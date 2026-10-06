/*
 * engine.js
 * Runs FFmpeg and FFprobe in the Node.js background process. Main.js supplies jobs; policy.js supplies decisions. Guide: subprocesses and hashes; capabilities; inspection; verification; conversion; safe publication.
 * Learning note: async functions return Promises; await gets their result and try/catch handles failure.
 */
const { spawn } = require('node:child_process');
// fs/promises lets disk operations be awaited instead of blocking the Node.js event loop.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { planFile } = require('./policy');
const { sourceFormat } = require('./profiles');
const os = require('node:os');
const { resolveOutputDirectory } = require('./imports');
const { validatePreferences, preferencesDefaults } = require('./app-state');
// A title is a hint only for retained embedded subtitles, never audio or fonts.
function needsForcedSubtitleFlag(stream) {
  return stream.codec_type === 'subtitle' && /\bforced\b/i.test(stream.tags?.title || '') && stream.disposition?.forced !== 1;
}
// COPYFILE_EXCL refuses existing destinations but is not atomic publication:
// the final pathname is visible while copying. Never unlink on copy failure;
// Node handles its failed copy, and the pathname may belong to someone else.
// Accepts a verified temp file and output folder/name; returns destination and whether copying was needed.
async function publishOutput(temp, directory, basename, { io = fs, signal } = {}) {
  let copyOnly = false;
  for (let i = 0; i < 10000; i++) {
    if (signal?.aborted) throw new Error('Cancelled');
    const destination = path.join(directory, `${basename}${i ? ` (${i})` : ''}.mkv`);
    if (!copyOnly) {
      // A hard link gives the same bytes a second name atomically, refusing an existing name.
      try { await io.link(temp, destination); return { destination, copied: false }; }
      catch (error) {
        if (error.code === 'EEXIST') continue;
        if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EINVAL', 'ENOSYS'].includes(error.code)) throw new Error(`Cannot publish output: ${error.message}`, { cause: error });
        copyOnly = true;
      }
      const size = (await io.stat(temp)).size;
      const space = await io.statfs(directory);
      if (space.bavail * space.bsize < size + 64 * 1024 * 1024) throw new Error('Insufficient free space for exclusive-copy publication; this filesystem requires a second full output copy.');
    }
    try {
      // EXCL refuses existing destinations. Unlike a link, copying exposes the name before all bytes arrive.
      await io.copyFile(temp, destination, require('node:fs').constants.COPYFILE_EXCL);
      return { destination, copied: true };
    } catch (error) {
      if (error.code === 'EEXIST') continue;
      throw new Error(`Cannot copy verified output without overwriting: ${error.message}`, { cause: error });
    }
  }
  throw new Error('Could not find an unused output filename.');
}
// Accepts a path and cancellation signal; returns a SHA-256 fingerprint using bounded read chunks.
async function hashFile(file, signal) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of require('node:fs').createReadStream(file, { signal })) hash.update(chunk);
  return hash.digest('hex');
}
// Accepts probe executable/arguments/signal; returns a hash of its output without storing a huge JSON string.
async function hashProbe(binary, args, signal) {
  const hash = crypto.createHash('sha256');
  await run(binary, args, { signal, onLine: line => hash.update(`${line}\n`) });
  return hash.digest('hex');
}

// Accepts an executable and argument array; returns a Promise for output or rejects on tool failure/cancellation.
function run(binary, args, { signal, onLine } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Cancelled'));
    // spawn starts a separate OS process. An argument array avoids shell parsing of filenames.
    // Pipes let us read progress/errors; ignored stdin prevents the tool waiting for keyboard input.
    const child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', pending = '';
    const abort = () => { child.kill(); };
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', chunk => {
      if (!onLine) stdout += chunk.toString();
      else {
        pending += chunk.toString();
        const lines = pending.split(/\r?\n/); pending = lines.pop();
        for (const line of lines) onLine(line);
      }
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-24000); });
    child.on('error', error => { signal?.removeEventListener('abort', abort); reject(error); });
    child.on('close', code => {
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) reject(new Error('Cancelled'));
      else if (code !== 0) reject(new Error(stderr.trim() || `Process exited with ${code}`));
       else { if (onLine && pending) onLine(pending); resolve({ stdout, stderr }); }
    });
  });
}

// Accepts encoder help text; returns supported sample rates and layouts advertised by this FFmpeg build.
function parseCapabilities(text) {
  return {
    layouts: (text.match(/Supported channel layouts:\s*([^\r\n]+)/)?.[1] || '').trim().split(/\s+/).filter(Boolean),
    rates: (text.match(/Supported sample rates:\s*([^\r\n]+)/)?.[1] || '').trim().split(/\s+/).map(Number).filter(Number.isFinite)
  };
}

class Engine {
  // Accepts executable paths; initializes this worker without starting any conversion.
  constructor(tools) { this.tools = tools; this.capabilities = null; this.profile = null; this.keepOriginal = false; }
  // Accepts global settings; stores original-retention behavior for later planning.
  setPreferences(preferences) { this.keepOriginal = !!preferences.keepOriginal; this.preferences = preferences; }
  // Profile language lists override global ones; an empty profile list inherits Settings.
  languageProfile() {
    const options = this.profile?.allowedLanguages?.length ? this.profile : this.preferences || {};
    return { ...this.profile, allowedLanguages: options.allowedLanguages || [], keepDefaultTrack: options.keepDefaultTrack ?? true };
  }
  plan(probe) {
    // Apply language selection independently of codec planning, including when no profile exists.
    const dropped = require('./policy').languageDrops(probe, this.languageProfile());
    const plan = planFile({ ...probe, streams: probe.streams.filter(s => !dropped.includes(s.index)) }, this.capabilities, this.profile);
    return { ...plan, droppedStreams: dropped, streamsToDrop: dropped.map(index => `0:${index}`), needsConversion: plan.needsConversion || dropped.length > 0, warnings: [...plan.warnings, ...(dropped.length ? [`Language filter removes ${dropped.length} embedded audio/subtitle stream(s).`] : [])] };
  }
  // Accepts resolved playback constraints; stores them for subsequent jobs.
  setProfile(profile) { this.profile = profile; }
  // Accepts an inspected job; refreshes its plan and returns the job, without converting media.
  replan(item) { item.plan = this.plan(item.probe); if (this.keepOriginal) for (const track of item.plan.tracks) if (track.action !== 'copy') track.keepOriginal = true; return item; }
  // Inspects actual tool support; resolves when cached encoder capabilities are ready.
  async initialize() {
    const entries = await Promise.all(['dca', 'ac3'].map(async encoder => {
      // -h encoder=... asks for encoder help (layouts/rates); it does not process any media.
      const { stdout, stderr } = await run(this.tools.ffmpeg, ['-hide_banner', '-h', `encoder=${encoder}`]);
      return [encoder, parseCapabilities(stdout + stderr)];
    }));
    this.capabilities = Object.fromEntries(entries);
    return this.capabilities;
  }
  // Uses this worker's executables; returns version strings for diagnostics.
  async toolVersions() {
    const versions = {};
    for (const [name, binary] of Object.entries(this.tools)) versions[name] = (await run(binary, ['-version'])).stdout.split('\n')[0];
    return versions;
  }
  // Probe: receives file, signal. See the return statements below for the result; async results are Promises.
  async probe(file, signal) {
    // Probe container, streams and chapters as JSON; -v error hides informational chatter.
    const result = await run(this.tools.ffprobe, ['-v', 'error', '-show_format', '-show_streams', '-show_chapters', '-of', 'json', file], { signal });
    return JSON.parse(result.stdout);
  }
  // Inspect dts core: receives file, index, signal. See the return statements below for the result; async results are Promises.
  async inspectDtsCore(file, index, signal) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'audiority-core-'));
    try {
      const sample = path.join(directory, 'core.dts');
      // Select one absolute input stream, copy a two-second sample, strip extensions,
      // and force raw DTS output so we can inspect the legacy core's real properties.
      await run(this.tools.ffmpeg, ['-v', 'error', '-nostdin', '-i', file, '-map', `0:${index}`, '-t', '2', '-c:a', 'copy', '-bsf:a', 'dca_core', '-f', 'dts', sample], { signal });
      const probe = await this.probe(sample, signal);
      const core = probe.streams.find(s => s.codec_name === 'dts');
      if (!core || sourceFormat(core) !== 'dts' || !core.channel_layout) return null;
      return { channels: core.channels, layout: core.channel_layout, sampleRate: Number(core.sample_rate) };
    } catch (error) {
      if (signal?.aborted) throw error;
      return null;
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  }
  // Inspect: receives file, { signal } = {}. See the return statements below for the result; async results are Promises.
  async inspect(file, { signal } = {}) {
    const stat = await fs.stat(file);
    if (!stat.isFile()) throw new Error('Please choose a file, not a folder.');
    if (!this.capabilities) await this.initialize();
    const probe = await this.probe(file, signal);
    for (const stream of probe.streams.filter(s => s.codec_type === 'audio' && sourceFormat(s) === 'dtshd')) {
      stream.audiorityCore = await this.inspectDtsCore(file, stream.index, signal);
    }
    const plan = this.plan(probe);
    if (this.keepOriginal) for (const track of plan.tracks) if (track.action !== 'copy') track.keepOriginal = true;
    if (!probe.streams.some(s => s.codec_type === 'audio')) throw new Error('No audio tracks found.');
    const subtitles = probe.streams.filter(s => s.codec_type === 'subtitle');
    const attachments = probe.streams.filter(s => s.codec_type === 'attachment');
    const fonts = attachments.filter(s => /\.(ttf|otf|ttc)$/i.test(s.tags?.filename || '') || /font|truetype|opentype/i.test(s.tags?.mimetype || ''));
    return { file, name: path.basename(file), size: stat.size, duration: Number(probe.format?.duration) || 0, probe, plan,
      subtitleInfo: { count: subtitles.length, ass: subtitles.filter(s => ['ass', 'ssa'].includes(s.codec_name)).length, fonts: fonts.length, attachments: attachments.length } };
  }
  // Accepts job/output/signal; compares content and metadata with bounded parallel probes, throwing on mismatch.
  async verifySubtitles(item, outputFile, signal) {
    // Stream copy must preserve ASS style headers, subtitle packets and all
    // attachment payloads. No decode/render step is used or implied here.
    if (!item.plan.needsConversion) return;
    const targets = item.probe.streams.filter(s => ['subtitle', 'attachment'].includes(s.codec_type) && !(item.plan.droppedStreams || []).includes(s.index));
    if (!targets.length) return;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    let next = 0, failure;
    const verify = async source => {
      // Select one stream; fingerprint codec header/font data and retain only relevant
      // tags/dispositions. Subtitle packet hashes additionally check the actual text/events.
      const args = ['-v', 'error', '-select_streams', String(source.index), '-show_streams', '-show_data_hash', 'sha256', '-show_entries', 'stream=codec_name,extradata_hash:stream_tags=language,title,filename,mimetype:stream_disposition=default,forced'];
      if (source.codec_type === 'subtitle') args.push('-show_packets', '-show_entries', 'stream=codec_name,extradata_hash:stream_tags=language,title,filename,mimetype:stream_disposition=default,forced:packet=data_hash');
      // The intentional forced-bit change is checked explicitly by verifyOutput.
      // Keep hashing default, content, headers, tags and attachment data unchanged.
      if (needsForcedSubtitleFlag(source)) {
        for (let i = 0; i < args.length; i++) if (args[i] === '-show_entries') args[i + 1] = args[i + 1].replace('stream_disposition=default,forced', 'stream_disposition=default');
      }
      args.push('-of', 'json');
      const ordinal = targets.filter(s => s.codec_type === source.codec_type).findIndex(s => s.index === source.index);
      const outputArgs = [...args]; outputArgs[outputArgs.indexOf('-select_streams') + 1] = `${source.codec_type === 'subtitle' ? 's' : 't'}:${ordinal}`;
      const [before, after] = await Promise.all([
        track(hashProbe(this.tools.ffprobe, [...args, item.file], controller.signal)),
        track(hashProbe(this.tools.ffprobe, [...outputArgs, outputFile], controller.signal))
      ]);
      if (before !== after) throw new Error(`Verification failed: subtitle/attachment content or metadata changed (stream ${source.index}).`);
    };
    const worker = async () => {
      while (next < targets.length && !controller.signal.aborted) {
        const source = targets[next++];
        try { await verify(source); }
        catch (error) { if (!failure) failure = error; controller.abort(); }
      }
    };
    // Limit simultaneous readers: each stream launches an input/output pair.
    // Drain every child before conversion cleanup can remove the temporary MKV.
    const pending = new Set();
    const track = promise => {
      pending.add(promise);
      promise.then(() => pending.delete(promise), () => pending.delete(promise));
      return promise;
    };
    // Promise.all rejects early; separately drain each surviving hash process.
    try {
      await Promise.all(Array.from({ length: Math.min(2, targets.length) }, worker));
      await Promise.allSettled([...pending]);
      if (failure) throw failure;
      if (signal?.aborted) throw new Error('Cancelled');
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }
  // Accepts a planned job, folder and callbacks; returns verified output paths, warnings and size after publication.
  async convert(item, directory, { signal, onProgress = () => {}, onTemporaryOutput = async () => {}, preferences = preferencesDefaults() } = {}) {
    preferences = validatePreferences(preferences);
    // Use a local plan snapshot; never mutate the displayed queue during execution.
    item = { ...item, plan: { ...item.plan, tracks: item.plan.tracks.map(track => ({ ...track, keepOriginal: track.action !== 'copy' && !!(track.keepOriginal || preferences.keepOriginal) })) } };
    if (!item.plan.needsConversion) return { skipped: true, reason: 'No convertible tracks; original unchanged.' };
    directory = await resolveOutputDirectory(directory, preferences.preserveFolders ? item.relativeDirectory || '' : '');
    const directoryStat = await fs.stat(directory);
    if (!directoryStat.isDirectory()) throw new Error('Output destination is not a folder.');
    await fs.access(directory, require('node:fs').constants.W_OK);
    const duration = item.duration;
    const audioBytes = item.plan.tracks.reduce((sum, t) => {
      if (t.action !== 'encode') return sum;
      if (t.codec.startsWith('pcm_')) return sum + duration * Number(item.probe.streams.find(s => s.index === t.index)?.sample_rate || 48000) * 2 * 8;
      return sum + duration * (t.codec === 'dca' ? 1411200 : 640000) / 8;
    }, 0);
    const space = await fs.statfs(directory);
    if (space.bavail * space.bsize < item.size + audioBytes + 64 * 1024 * 1024) throw new Error('Insufficient free space for a safe conversion.');
    const basename = `${path.parse(item.name).name}${preferences.outputSuffix}`;
    const temp = path.join(directory, `.${basename}.${crypto.randomUUID()}.partial.mkv`);
    // -i opens the source; -n refuses overwrite; -nostdin forbids interactive prompts.
    // -map 0 selects ALL streams from input zero, not just FFmpeg's automatic favorites.
    // Metadata/chapters come from input zero; -c copy avoids decoding/encoding by default.
    // Later per-audio options override copy. Extra mappings append compatibility streams,
    // so stream indices must be matched carefully during verification, not assumed unchanged.
    const args = ['-hide_banner', '-nostdin', '-v', 'warning', '-n', '-i', item.file, '-map', '0', '-map_metadata', '0', '-map_chapters', '0', '-c', 'copy'];
    // Negative absolute stream maps remove only selected audio/subtitle streams.
    for (const stream of item.plan.streamsToDrop || []) args.push('-map', `-${stream}`);
    const retainedSubtitles = item.probe.streams.filter(stream => stream.codec_type === 'subtitle' && !(item.plan.droppedStreams || []).includes(stream.index));
    retainedSubtitles.forEach((stream, outputIndex) => {
      // +forced adds one flag without clearing default, hearing_impaired, etc.
      // s:N is the retained subtitle ordinal, not the input's absolute index.
      if (needsForcedSubtitleFlag(stream)) args.push(`-disposition:s:${outputIndex}`, '+forced');
    });
    let addedAudioCount = 0;
    const originalAudio = item.plan.tracks.map(t => item.probe.streams.find(s => s.index === t.index));
    const duplicated = item.plan.tracks.map((track, i) => track.keepOriginal ? i : -1).filter(i => i >= 0);
    const sourceDefault = originalAudio.findIndex(s => s.disposition?.default);
    const defaultSource = sourceDefault >= 0 ? sourceDefault : (duplicated[0] ?? item.plan.tracks.findIndex(track => track.action !== 'copy'));
    // Audio-relative indices: appended counterparts inherit their source's default.
    // With no source default, prefer the first compatibility track if one exists.
    const defaultOutput = duplicated.includes(defaultSource) ? item.plan.tracks.length + duplicated.indexOf(defaultSource) : defaultSource;
    if (duplicated.length || (sourceDefault < 0 && defaultSource >= 0)) for (let i = 0; i < item.plan.tracks.length + duplicated.length; i++) {
      const source = i < originalAudio.length ? originalAudio[i] : originalAudio[duplicated[i - originalAudio.length]];
      const flags = Object.entries(source.disposition || {}).filter(([key, value]) => key !== 'default' && value).map(([key]) => key);
      if (i === defaultOutput) flags.push('default');
      args.push(`-disposition:a:${i}`, flags.join('+') || '0');
    }
    item.plan.tracks.forEach((track, i) => {
      if (track.action === 'copy') return;
      const targetIndex = track.keepOriginal ? item.plan.tracks.length + addedAudioCount++ : i;
      if (track.keepOriginal) {
        args.push('-map', `0:${track.index}`);
        args.push(`-metadata:s:a:${targetIndex}`, `title=${track.title ? `${track.title} · ` : ''}Compatibility (${track.codec === 'dca' ? 'DTS' : track.codec.toUpperCase()})`);
      }
      // A bitstream filter removes DTS extensions without decoding/re-encoding the legacy core.
      if (track.action === 'extract') { args.push(`-bsf:a:${targetIndex}`, 'dca_core'); return; }
      if (track.action !== 'encode') return;
      args.push(`-c:a:${targetIndex}`, track.codec);
      if (preferences.threads) args.push(`-threads:a:${targetIndex}`, String(preferences.threads));
      if (track.codec === 'dca') args.push(`-strict:a:${targetIndex}`, 'experimental');
      if (track.bitrate) args.push(`-b:a:${targetIndex}`, track.bitrate);
      if (track.sampleRate) args.push(`-ar:a:${targetIndex}`, String(track.sampleRate));
      const filters = [];
      // aresample rematrixing combines weighted input channels into the requested speaker layout.
      // Stereo means combining surround contributions into left/right, not just dropping speakers.
      // rematrix_maxval limits mixing coefficients; it is not a guarantee against every clipping case.
      if (track.downmix) filters.push(`aresample=out_chlayout=${track.layout}:rematrix_maxval=1`);
      // Boost only the remixed 7.1 -> 5.1 center, not all dialogue or all channels.
      // Gain needs headroom: 1.5x may clip loud center peaks; normalization is separate.
      if (track.downmix && track.sourceLayout === '7.1' && ['5.1', '5.1(side)'].includes(track.layout) &&
          (preferences.dialogueBoost || this.profile?.dialogueBoost || this.profile?.settings?.dialogueBoost)) {
        const surround = track.layout === '5.1(side)' ? ['SL', 'SR'] : ['BL', 'BR'];
        filters.push(`pan=${track.layout}|FL=FL|FR=FR|FC=1.5*FC|LFE=LFE|${surround[0]}=${surround[0]}|${surround[1]}=${surround[1]}`);
      }
      // dynaudnorm adjusts time-varying gain (150 ms frames, 15-frame smoothing window).
      // It changes overall dynamics, not dialogue independently, and only runs on encoded tracks.
      if (preferences.normalizeVolume || this.profile?.settings?.normalizeVolume) filters.push('dynaudnorm=f=150:g=15');
      if (filters.length) args.push(`-filter:a:${targetIndex}`, filters.join(','));
      // Explicit layout prevents automatic downmixing to another encoder layout.
      args.push(`-channel_layout:a:${targetIndex}`, track.layout);
    });
    args.push('-progress', 'pipe:1', '-nostats', '-f', 'matroska', temp);
    try {
      await onTemporaryOutput(temp);
      await run(this.tools.ffmpeg, args, { signal, onLine: line => {
        if (line.startsWith('out_time_us=')) onProgress(duration ? Math.min(0.99, Math.max(0, Number(line.slice(12)) / 1e6 / duration)) : 0);
      } });
      if (signal?.aborted) throw new Error('Cancelled');
      const output = await this.probe(temp, signal);
      verifyOutput(item, output);
      for (const [i, track] of item.plan.tracks.entries()) if (track.keepOriginal) {
        // a:i means the i-th audio stream (not absolute stream index). Compare compressed
        // packet payload hashes to prove copied/retained audio bytes were not re-encoded.
        const hashArgs = ['-v', 'error', '-select_streams', `a:${i}`, '-show_packets', '-show_data_hash', 'sha256', '-show_entries', 'packet=data_hash', '-of', 'json'];
        const inputArgs = [...hashArgs]; inputArgs[inputArgs.indexOf('-select_streams') + 1] = String(track.index);
        const hashes = await Promise.allSettled([hashProbe(this.tools.ffprobe, [...inputArgs, item.file], signal), hashProbe(this.tools.ffprobe, [...hashArgs, temp], signal)]);
        const failure = hashes.find(result => result.status === 'rejected');
        if (failure) throw failure.reason;
        if (hashes[0].value !== hashes[1].value) throw new Error(`Verification failed: retained original audio changed (track ${i + 1}).`);
      }
      await this.verifySubtitles(item, temp, signal);
      const { destination, copied } = await publishOutput(temp, directory, basename, { signal });
      const warnings = [...item.plan.warnings, ...(item.importWarnings || [])];
      if (copied) warnings.push('Hard links unavailable: output published using an exclusive copy. The destination was visible during copying.');
      // Publish each matching external subtitle without overwriting anything.
      // Sidecar failures do not invalidate a verified media output; report them.
      const sidecars = [];
      for (const sidecar of item.sidecars || []) {
        if (signal?.aborted) { warnings.push('Cancelled during external subtitle copy; media output is complete.'); break; }
        try {
          if (typeof sidecar.suffix !== 'string' || !/^\.[^/\\]+\.(ass|ssa|srt)$/i.test(sidecar.suffix) && !/^\.(ass|ssa|srt)$/i.test(sidecar.suffix)) throw new Error('Unsafe subtitle suffix.');
          if (!(await fs.lstat(sidecar.file)).isFile()) throw new Error('Subtitle is no longer a regular file.');
          const target = path.join(directory, `${path.parse(destination).name}${sidecar.suffix}`);
          await fs.copyFile(sidecar.file, target, require('node:fs').constants.COPYFILE_EXCL);
          if (await hashFile(sidecar.file, signal) !== await hashFile(target, signal)) throw new Error(`Subtitle copy verification failed: ${target}`);
          sidecars.push(target);
        } catch (error) { warnings.push(`External subtitle not copied/verified: ${path.basename(sidecar.file)} — ${error.message}`); }
      }
      onProgress(1);
      return { output: destination, warnings, sidecars, outputBytes: (await fs.stat(destination)).size };
    } finally { await fs.unlink(temp).catch(() => {}); }
  }
}

// Accepts source job and output probe data; throws if stream counts, audio properties or duration disagree.
function verifyOutput(item, output) {
  const sourceStreams = item.probe.streams.filter(s => !(item.plan.droppedStreams || []).includes(s.index));
  const added = item.plan.tracks.filter(t => t.keepOriginal && t.action !== 'copy').length;
  if (output.streams.length !== sourceStreams.length + added) throw new Error('Verification failed: stream count changed.');
  const audio = output.streams.filter(s => s.codec_type === 'audio');
  if (audio.length !== item.plan.tracks.length + added) throw new Error('Verification failed: audio track count changed.');
  let addedIndex = item.plan.tracks.length;
  for (const [i, track] of item.plan.tracks.entries()) {
    if (track.keepOriginal && track.action !== 'copy') {
      const source = sourceStreams.find(s => s.index === track.index);
      if (audio[i].codec_name !== source.codec_name || audio[i].channels !== source.channels || audio[i].sample_rate !== source.sample_rate || audio[i].tags?.language !== source.tags?.language || audio[i].tags?.title !== source.tags?.title) throw new Error('Verification failed: retained original audio properties changed.');
    }
    const actual = track.keepOriginal && track.action !== 'copy' ? audio[addedIndex++] : audio[i];
    const expectedCodec = track.codec === 'dca' ? 'dts' : track.codec;
    if (actual.codec_name !== expectedCodec || actual.channels !== track.channels) throw new Error(`Verification failed: codec or channel count changed for audio track ${i + 1}.`);
    if (track.action === 'extract' && (sourceFormat(actual) !== 'dts' || Number(actual.sample_rate) !== track.sampleRate)) throw new Error('Verification failed: extracted DTS core properties differ from plan.');
    // Matroska PCM often omits a layout field; its two-channel output uses
    // standard interleaved left/right order. Never infer multichannel layouts.
    const actualLayout = actual.channel_layout || (actual.codec_name.startsWith('pcm_') && actual.channels === 2 ? 'stereo' : undefined);
    if (track.layout && actualLayout !== track.layout) throw new Error(`Verification failed: channel layout changed for audio track ${i + 1}.`);
  }
  for (const type of new Set(sourceStreams.filter(s => s.codec_type !== 'audio').map(s => s.codec_type))) {
    const originals = sourceStreams.filter(s => s.codec_type === type);
    const copies = output.streams.filter(s => s.codec_type === type);
    if (originals.length !== copies.length || originals.some((source, i) => copies[i].codec_name !== source.codec_name)) throw new Error('Verification failed: a copied stream changed.');
    if (type === 'subtitle') for (const [i, source] of originals.entries()) {
      if (needsForcedSubtitleFlag(source) && copies[i].disposition?.forced !== 1) throw new Error('Verification failed: expected forced subtitle flag is missing.');
    }
  }
  const outputDuration = Number(output.format?.duration);
  if (item.duration && (!Number.isFinite(outputDuration) || Math.abs(outputDuration - item.duration) > Math.max(1, item.duration * 0.001))) throw new Error('Verification failed: output duration differs from input.');
}

module.exports = { Engine, run, parseCapabilities, verifyOutput, hashFile, hashProbe, publishOutput };