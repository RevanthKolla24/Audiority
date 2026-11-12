/*
 * engine.js
 * Runs FFmpeg and FFprobe in the Node.js background process. Main.js supplies jobs; policy.js supplies decisions. Guide: subprocesses and hashes; capabilities; inspection; verification; conversion; safe publication.
 * Learning note: async functions return Promises; await gets their result and try/catch handles failure.
 */
const { spawn } = require('node:child_process');
// fs/promises lets disk operations be awaited instead of blocking the Node.js event loop.
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const { pipeline } = require('node:stream/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { planFile } = require('./policy');
const { sourceFormat } = require('./profiles');
const os = require('node:os');
const { resolveOutputDirectory } = require('./imports');
const { validatePreferences, preferencesDefaults } = require('./app-state');
const { sourceIdentity, sameSource } = require('./source-safety');
const { estimatedAudioBytes } = require('./conversion-estimates');
const { createResourceBudget } = require('./resource-budget');
const { verificationWorkers } = require('./verification-workers');
const { audioFingerprints } = require('./audio-fingerprints');
const { audioOutputMap, compatibilityTitle } = require('./audio-output-map');
// A title is a hint only for retained embedded subtitles, never audio or fonts.
function needsForcedSubtitleFlag(stream) {
  return stream.codec_type === 'subtitle' && /\bforced\b/i.test(stream.tags?.title || '') && stream.disposition?.forced !== 1;
}
// Exclusive streaming refuses existing destinations, but exposes the final name
// while copying. Only clean up a destination that we successfully created.
// Accepts a verified temp file and output folder/name; returns destination and whether copying was needed.
async function publishOutput(temp, directory, basename, { io = fs, signal, suffix = '.mkv', maxNames = 10000 } = {}) {
  let copyOnly = false;
  for (let i = 0; i < maxNames; i++) {
    if (signal?.aborted) throw new Error('Cancelled');
    const destination = path.join(directory, `${basename}${i ? ` (${i})` : ''}${suffix}`);
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
    let handle, owned;
    try {
      handle = await io.open(destination, 'wx');
      owned = await handle.stat();
      // pipeline propagates cancellation and drains/closes both streams on error.
      await pipeline(createReadStream(temp), handle.createWriteStream(), { signal });
      return { destination, copied: true };
    } catch (error) {
      if (!handle && error.code === 'EEXIST') continue;
      await handle?.close().catch(() => {});
      if (handle) {
        try {
          const current = await io.lstat(destination);
          // Do not delete a replacement file or symlink installed by another process.
          if (owned && current.isFile() && current.dev === owned.dev && current.ino === owned.ino) await io.unlink(destination);
        } catch (cleanupError) {
          if (cleanupError.code !== 'ENOENT') throw new Error(`Copy failed: ${error.message}. Could not remove incomplete output ${destination}: ${cleanupError.message}`, { cause: error });
        }
      }
      throw new Error(`Cannot copy verified output without overwriting: ${error.message}`, { cause: error });
    } finally {
      await handle?.close().catch(() => {});
    }
  }
  throw new Error('Could not find an unused output filename.');
}
// Verify a private copy before exposing its playback name. A collision is never overwritten.
async function publishSidecar(sidecar, target, { signal, io = fs, hash = hashFile } = {}) {
  const before = await sourceIdentity(sidecar.file);
  const temp = path.join(path.dirname(target), `.subtitle-${crypto.randomUUID()}.tmp`);
  let owned = false, record;
  try {
    // Reserve our private name before writing so cleanup cannot remove a collision.
    const handle = await io.open(temp, 'wx');
    owned = true;
    try { await pipeline(createReadStream(sidecar.file), handle.createWriteStream(), { signal }); }
    finally { await handle.close().catch(() => {}); }
    const digest = await hash(sidecar.file, signal);
    if (digest !== await hash(temp, signal)) throw new Error(`Subtitle copy verification failed: ${target}`);
    if (!sameSource(before, await sourceIdentity(sidecar.file))) throw new Error('Subtitle source changed during copying.');
    await publishOutput(temp, path.dirname(target), path.basename(target), { io, signal, suffix: '', maxNames: 1 });
    record = { file: sidecar.file, output: target, identity: before, hash: digest };
    return record;
  } finally {
    if (owned) {
      try { await io.unlink(temp); }
      catch (error) {
        if (error.code !== 'ENOENT') {
          if (!record) throw new Error(`Subtitle publication failed; could not remove temporary file ${temp}: ${error.message}`, { cause: error });
          record.warning = `Subtitle published and verified, but temporary file cleanup failed: ${temp} — ${error.message}`;
        }
      }
    }
  }
}
// Accepts a path and cancellation signal; returns a SHA-256 fingerprint using bounded read chunks.
async function hashFile(file, signal) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of require('node:fs').createReadStream(file, { signal })) hash.update(chunk);
  return hash.digest('hex');
}
// Accepts probe executable/arguments/signal; returns a hash of its output without storing a huge JSON string.
async function hashProbe(binary, args, signal, onActivity = () => {}) {
  const hash = crypto.createHash('sha256');
  // Include scan offsets solely for progress. Never fingerprint container offsets:
  // remuxing necessarily changes them while retaining identical payloads.
  args = args.map(arg => typeof arg === 'string' ? arg.replace(/packet=/g, 'packet=pos,') : arg);
  // Progress is optional; the probe remains responsible for reporting read errors.
  const size = await fs.stat(args[args.length - 1]).then(stat => stat.size, () => 0);
  let packets = 0, lastReport = 0, position = 0;
  await run(binary, args, { signal, idleTimeoutMs: 120000, onLine: line => {
    const offset = line.match(/^\s*"pos":/);
    if (offset) {
      const value = line.match(/:\s*"?(\d+)/);
      if (value) position = Math.max(position, Number(value[1]));
    }
    else hash.update(`${line}\n`);
    if (line.includes('"data_hash"')) packets++;
    if (Date.now() - lastReport >= 1000) { lastReport = Date.now(); onActivity(packets, { fraction: size ? position / size : 0 }); }
  } });
  onActivity(packets, { fraction: 1, done: true });
  return hash.digest('hex');
}

// Accepts an executable and argument array; returns a Promise for output or rejects on tool failure/cancellation.
function run(binary, args, { signal, onLine, idleTimeoutMs = 0, maxOutputBytes = 32 * 1024 * 1024, maxLineBytes = 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Cancelled'));
    if (![maxOutputBytes, maxLineBytes].every(value => Number.isSafeInteger(value) && value > 0)) return reject(new Error('Invalid tool output limit.'));
    // spawn starts a separate OS process. An argument array avoids shell parsing of filenames.
    // Pipes let us read progress/errors; ignored stdin prevents the tool waiting for keyboard input.
    const child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', pending = '';
    // Incremental UTF-8 decoding preserves metadata characters split across chunks.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let idleTimer, killTimer, timedOut = false, closed = false, callbackError, outputBytes = 0;
    const terminate = () => {
      if (closed) return;
      child.kill();
      // A malformed tool/input must not hang cleanup by ignoring SIGTERM.
      if (!killTimer) killTimer = setTimeout(() => { child.kill('SIGKILL'); }, 1000);
    };
    const fail = error => { callbackError ||= error; terminate(); };
    const deliver = line => {
      if (callbackError) return;
      if (Buffer.byteLength(line) > maxLineBytes) { fail(new Error(`Tool output line exceeded ${maxLineBytes} bytes.`)); return; }
      try { onLine(line); }
      catch (error) { fail(error); }
    };
    const activity = () => {
      if (!idleTimeoutMs) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { timedOut = true; terminate(); }, idleTimeoutMs);
    };
    activity();
    const abort = terminate;
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', chunk => {
      activity();
      if (callbackError || timedOut || signal?.aborted) return;
      if (!onLine) {
        outputBytes += Buffer.byteLength(chunk);
        if (outputBytes > maxOutputBytes) { fail(new Error(`Tool output exceeded ${maxOutputBytes} bytes.`)); return; }
        stdout += chunk;
      }
      else {
        pending += chunk;
        const lines = pending.split(/\r?\n/); pending = lines.pop();
        for (const line of lines) deliver(line);
        if (Buffer.byteLength(pending) > maxLineBytes) { pending = ''; fail(new Error(`Tool output line exceeded ${maxLineBytes} bytes.`)); }
      }
    });
    child.stderr.on('data', chunk => { activity(); stderr = (stderr + chunk).slice(-24000); });
    child.on('error', error => { clearTimeout(idleTimer); clearTimeout(killTimer); signal?.removeEventListener('abort', abort); reject(error); });
    child.on('close', code => {
      closed = true;
      clearTimeout(idleTimer);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) reject(new Error('Cancelled'));
      else if (callbackError) reject(callbackError);
      else if (timedOut) reject(new Error(`Verification stalled: no tool activity for ${idleTimeoutMs / 1000} seconds. Check that the media drive is connected and readable.${stderr.trim() ? ` ${stderr.trim()}` : ''}`));
      else if (code !== 0) reject(new Error(`Tool ${path.basename(binary)} exited with ${code}. ${stderr.trim() || 'No diagnostic output.'}`));
       else { if (onLine && pending) deliver(pending); if (callbackError) reject(callbackError); else resolve({ stdout, stderr }); }
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
    if (this.profile?.languageMode === 'all') return { ...this.profile, allowedLanguages: [] };
    const options = this.profile?.languageMode === 'custom' || this.profile?.allowedLanguages?.length ? this.profile : this.preferences || {};
    return { ...this.profile, allowedLanguages: options.allowedLanguages || [], keepDefaultTrack: options.keepDefaultTrack ?? true };
  }
  plan(probe) {
    // Apply language selection independently of codec planning, including when no profile exists.
    const dropped = require('./policy').languageDrops(probe, this.languageProfile());
    // Streams have already been filtered using the effective policy. Do not
    // apply a stale profile language list again inside codec planning.
    const codecProfile = this.profile ? { ...this.profile, allowedLanguages: [] } : null;
    const plan = planFile({ ...probe, streams: probe.streams.filter(s => !dropped.includes(s.index)) }, this.capabilities, codecProfile);
    return { ...plan, droppedStreams: dropped, streamsToDrop: dropped.map(index => `0:${index}`), needsConversion: plan.needsConversion || dropped.length > 0, warnings: [...plan.warnings, ...(dropped.length ? [`Language filter removes ${dropped.length} embedded audio/subtitle stream(s).`] : [])] };
  }
  // Accepts resolved playback constraints; stores them for subsequent jobs.
  setProfile(profile) { this.profile = profile; }
  // Accepts an inspected job; refreshes its plan and returns the job, without converting media.
  retainOriginal(track) {
    if (this.profile?.retentionMode === 'replace') return false;
    if (this.profile?.retentionMode === 'keep') return true;
    return !!(track.keepOriginal || this.keepOriginal);
  }
  replan(item) { item.plan = this.plan(item.probe); for (const track of item.plan.tracks) if (track.action !== 'copy') track.keepOriginal = this.retainOriginal(track); return item; }
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
  async probe(file, signal, idleTimeoutMs = 0) {
    // Probe container, streams and chapters as JSON; -v error hides informational chatter.
    const result = await run(this.tools.ffprobe, ['-v', 'error', '-show_format', '-show_streams', '-show_chapters', '-of', 'json', file], { signal, idleTimeoutMs });
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
    const inspectionSnapshot = await sourceIdentity(file);
    const stat = await fs.stat(file);
    if (!stat.isFile()) throw new Error('Please choose a file, not a folder.');
    if (!this.capabilities) await this.initialize();
    const probe = await this.probe(file, signal);
    for (const stream of probe.streams.filter(s => s.codec_type === 'audio' && sourceFormat(s) === 'dtshd')) {
      stream.audiorityCore = await this.inspectDtsCore(file, stream.index, signal);
    }
    const plan = this.plan(probe);
    for (const track of plan.tracks) if (track.action !== 'copy') track.keepOriginal = this.retainOriginal(track);
    if (!probe.streams.some(s => s.codec_type === 'audio')) throw new Error('No audio tracks found.');
    const subtitles = probe.streams.filter(s => s.codec_type === 'subtitle');
    const attachments = probe.streams.filter(s => s.codec_type === 'attachment');
    const fonts = attachments.filter(s => /\.(ttf|otf|ttc)$/i.test(s.tags?.filename || '') || /font|truetype|opentype/i.test(s.tags?.mimetype || ''));
    if (!sameSource(inspectionSnapshot, await sourceIdentity(file))) throw new Error('Source changed during inspection. Import it again once writing has finished.');
    return { file, inspectionSnapshot, name: path.basename(file), size: stat.size, duration: Number(probe.format?.duration) || 0, probe, plan,
      subtitleInfo: { count: subtitles.length, ass: subtitles.filter(s => ['ass', 'ssa'].includes(s.codec_name)).length, fonts: fonts.length, attachments: attachments.length } };
  }
  // Accepts job/output/signal; compares content and metadata with bounded parallel probes, throwing on mismatch.
  async verifyVideo(item, outputFile, signal, onVerification = () => {}) {
    for (const [ordinal, source] of item.probe.streams.filter(stream => stream.codec_type === 'video').entries()) {
      onVerification(`Checking video ${ordinal + 1}…`);
      const args = ['-v', 'error', '-select_streams', String(source.index), '-show_streams', '-show_packets', '-show_data_hash', 'sha256',
        '-show_entries', 'stream=codec_name,width,height,pix_fmt,extradata_hash,color_range,color_space,color_transfer,color_primaries:stream_tags=:stream_disposition=:stream_side_data=:packet=data_hash:packet_side_data=', '-of', 'json'];
      const outputArgs = [...args]; outputArgs[outputArgs.indexOf('-select_streams') + 1] = `v:${ordinal}`;
      const hashes = await Promise.allSettled([
        hashProbe(this.tools.ffprobe, [...args, item.file], signal, (count, activity) => onVerification(`Checking video ${ordinal + 1}: source · ${count.toLocaleString()} packets checked`, activity)),
        hashProbe(this.tools.ffprobe, [...outputArgs, outputFile], signal, (count, activity) => onVerification(`Checking video ${ordinal + 1}: output · ${count.toLocaleString()} packets checked`, activity))
      ]);
      const failure = hashes.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
      if (hashes[0].value !== hashes[1].value) throw new Error(`Verification failed: copied video content or format changed (stream ${source.index}).`);
    }
  }
  async verifySubtitles(item, outputFile, signal, onVerification = () => {}, budget) {
    // Stream copy must preserve ASS style headers, subtitle packets and all
    // attachment payloads. No decode/render step is used or implied here.
    if (!item.plan.needsConversion) return;
    const targets = item.probe.streams.filter(s => ['subtitle', 'attachment'].includes(s.codec_type) && !(item.plan.droppedStreams || []).includes(s.index));
    if (!targets.length) return;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    let failure;
    const verify = async source => {
      onVerification(`Checking ${source.codec_type === 'subtitle' ? 'subtitle' : 'attachment'} stream ${source.index}…`);
      // Select one stream; fingerprint codec header/font data and retain only relevant
      // tags/dispositions. Subtitle packet hashes additionally check the actual text/events.
      const args = ['-v', 'error', '-select_streams', String(source.index), '-show_streams', '-show_data_hash', 'sha256', '-show_entries', 'stream=codec_name,extradata_hash:stream_tags=language,title,filename,mimetype:stream_disposition=default,forced'];
      if (source.codec_type === 'subtitle') args.push('-show_packets', '-show_entries', 'stream=codec_name,extradata_hash:stream_tags=language,title,filename,mimetype:stream_disposition=default,forced:packet=data_hash');
      // The intentional forced-bit change is checked explicitly by verifyOutput.
      // Keep hashing default, content, headers, tags and attachment data unchanged.
      if (needsForcedSubtitleFlag(source)) {
        for (let i = 0; i < args.length; i++) if (args[i] === '-show_entries') args[i + 1] = args[i + 1].replace('stream_disposition=default,forced', 'stream_disposition=default');
      }
      // Container side data is not subtitle text/font payload and may be rewritten.
      for (let i = 0; i < args.length; i++) if (args[i] === '-show_entries') args[i + 1] += ':stream_side_data=:packet_side_data=';
      args.push('-of', 'json');
      const ordinal = targets.filter(s => s.codec_type === source.codec_type).findIndex(s => s.index === source.index);
      const outputArgs = [...args]; outputArgs[outputArgs.indexOf('-select_streams') + 1] = `${source.codec_type === 'subtitle' ? 's' : 't'}:${ordinal}`;
      const [before, after] = await Promise.all([
        track(hashProbe(this.tools.ffprobe, [...args, item.file], controller.signal, (count, activity) => onVerification(`Checking ${source.codec_type} stream ${source.index}: source · ${count.toLocaleString()} packets checked`, activity))),
        track(hashProbe(this.tools.ffprobe, [...outputArgs, outputFile], controller.signal, (count, activity) => onVerification(`Checking ${source.codec_type} stream ${source.index}: output · ${count.toLocaleString()} packets checked`, activity)))
      ]);
      if (before !== after) throw new Error(`Verification failed: subtitle/attachment content or metadata changed (stream ${source.index}).`);
    };
    const worker = async source => {
      try { await verify(source); }
      catch (error) { if (!failure) failure = error; controller.abort(); throw error; }
    };
    // Limit simultaneous readers: each stream launches an input/output pair.
    // Drain every child before conversion cleanup can remove the temporary MKV.
    const pending = new Set();
    const track = promise => {
      pending.add(promise);
      promise.then(() => pending.delete(promise), () => pending.delete(promise));
      return promise;
    };
    // A task can fail before its peer hash exits; separately drain those children.
    try {
      await verificationWorkers(targets, worker, { limit: () => budget?.limit() || 2, signal: controller.signal });
    } catch (error) {
      failure ||= error;
    } finally {
      await Promise.allSettled([...pending]);
      signal?.removeEventListener('abort', abort);
    }
    if (failure) throw failure;
    if (signal?.aborted) throw new Error('Cancelled');
  }
  // One demux pass per file for every copied audio stream, with bounded hash state.
  async verifyCopiedAudio(item, outputFile, signal, onVerification = () => {}, budget, outputProbe) {
    const tracks = item.plan.tracks.map((track, ordinal) => ({ ...track, ordinal }))
      .filter(track => track.action === 'copy' || track.keepOriginal);
    if (!tracks.length) return;
    const outputAudio = (outputProbe || await this.probe(outputFile, signal, 120000)).streams.filter(stream => stream.codec_type === 'audio');
    const scan = async (file, source) => {
      const fingerprints = audioFingerprints(tracks.map(track => source ? track.index : outputAudio[track.ordinal].index));
      const size = await fs.stat(file).then(stat => stat.size);
      const key = `Checking copied audio: ${source ? 'source' : 'output'}`;
      let packets = 0, last = 0;
      // FFprobe hashes all audio in this pass; filtering here preserves a single
      // demux scan. Avoiding unselected hashes needs a separately benchmarked path.
      await run(this.tools.ffprobe, ['-v', 'error', '-select_streams', 'a', '-show_packets', '-show_data_hash', 'sha256',
        '-show_entries', 'packet=stream_index,pos,data_hash', '-of', 'compact=p=0:nk=0', file], { signal, idleTimeoutMs: 120000, onLine: line => {
        if (!fingerprints.packet(line)) return;
        packets++;
        if (Date.now() - last >= 1000) {
          last = Date.now();
          const position = Number(line.match(/(?:^|\|)pos=(\d+)/)?.[1]);
          onVerification(`${key} · ${packets} packets checked`, Number.isFinite(position) && size ? { fraction: position / size } : undefined);
        }
      } });
      onVerification(key, { done: true });
      return fingerprints.finish();
    };
    let before, after;
    if ((budget?.limit() || 2) > 1) {
      const results = await Promise.allSettled([scan(item.file, true), scan(outputFile, false)]);
      const failed = results.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
      [before, after] = results.map(result => result.value);
    } else { before = await scan(item.file, true); after = await scan(outputFile, false); }
    if (before.some((entry, i) => entry.count !== after[i].count || entry.hash !== after[i].hash)) throw new Error('Verification failed: copied or retained original audio changed.');
  }
  // Accepts a planned job, folder and callbacks; returns verified output paths, warnings and size after publication.
  async convert(item, directory, { signal, onProgress = () => {}, onVerification = () => {}, onStage = () => {}, onTemporaryOutput = async () => {}, onPublished = async () => {}, preferences = preferencesDefaults() } = {}) {
    const started = performance.now(), timings = {};
    const measure = async (name, operation) => {
      const start = performance.now();
      try { return await operation(); }
      finally { timings[name] = (performance.now() - start) / 1000; }
    };
    preferences = validatePreferences(preferences);
    // Use a local plan snapshot; never mutate the displayed queue during execution.
    item = { ...item, plan: { ...item.plan, tracks: item.plan.tracks.map(track => ({ ...track, keepOriginal: track.action !== 'copy' && (this.profile?.retentionMode === 'replace' ? false : this.profile?.retentionMode === 'keep' || !!(track.keepOriginal || preferences.keepOriginal)) })) } };
    if (item.plan.blocked || item.plan.tracks.some(track => track.blocked)) throw new Error('Conversion blocked: an explicit audio request cannot be fulfilled. Review the track plan; no media was written.');
    if (!item.plan.needsConversion) return { skipped: true, reason: 'No convertible tracks; original unchanged.' };
    const sourceSnapshot = await sourceIdentity(item.file);
    if (item.inspectionSnapshot && !sameSource(item.inspectionSnapshot, sourceSnapshot)) throw new Error('Source changed since inspection. Remove and re-import this file before converting.');
    directory = await resolveOutputDirectory(directory, preferences.preserveFolders ? item.relativeDirectory || '' : '');
    const directoryStat = await fs.stat(directory);
    if (!directoryStat.isDirectory()) throw new Error('Output destination is not a folder.');
    await fs.access(directory, require('node:fs').constants.W_OK);
    const duration = item.duration;
    const audioBytes = estimatedAudioBytes(item);
    const space = await fs.statfs(directory);
    if (space.bavail * space.bsize < item.size + audioBytes + 64 * 1024 * 1024) throw new Error('Insufficient free space for a safe conversion.');
    const basename = `${path.parse(item.name).name}${preferences.outputSuffix}`;
    const temp = path.join(directory, `.${basename}.${crypto.randomUUID()}.partial.mkv`);
    let publicationCleanupAttempted = false;
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
    const duplicated = item.plan.tracks.map((track, i) => track.keepOriginal ? i : -1).filter(i => i >= 0);
    // Explicit defaults prevent the muxer from silently choosing the first audio
    // when filtering removed the original default (including copy-only jobs).
    for (const entry of audioOutputMap(item)) {
      const { source } = entry;
      const flags = Object.entries(source.disposition || {}).filter(([key, value]) => key !== 'default' && value).map(([key]) => key);
      if (entry.default) flags.push('default');
      args.push(`-disposition:a:${entry.ordinal}`, flags.join('+') || '0');
    }
    item.plan.tracks.forEach((track, i) => {
      if (track.action === 'copy') return;
      const targetIndex = track.keepOriginal ? item.plan.tracks.length + addedAudioCount++ : i;
      if (track.keepOriginal) {
        args.push('-map', `0:${track.index}`);
        args.push(`-metadata:s:a:${targetIndex}`, `title=${compatibilityTitle(track)}`);
      }
      // A bitstream filter removes DTS extensions without decoding/re-encoding the legacy core.
      if (track.action === 'extract') { args.push(`-bsf:a:${targetIndex}`, 'dca_core'); return; }
      if (track.action !== 'encode') return;
      args.push(`-c:a:${targetIndex}`, track.codec);
      if (preferences.threads) args.push(`-threads:a:${targetIndex}`, String(preferences.threads));
      if (track.codec === 'dca') args.push(`-strict:a:${targetIndex}`, 'experimental');
      if (track.bitrate) args.push(`-b:a:${targetIndex}`, track.bitrate);
      if (track.sampleRate) args.push(`-ar:a:${targetIndex}`, String(track.sampleRate));
      const filters = require('./audio-processing').audioFilters(track, preferences, this.profile);
      if (filters.length) args.push(`-filter:a:${targetIndex}`, filters.join(','));
      // Explicit layout prevents automatic downmixing to another encoder layout.
      args.push(`-channel_layout:a:${targetIndex}`, track.layout);
    });
    // Put attachments after appended compatibility audio. Newer Matroska muxers
    // can mis-handle attachment streams interleaved before those added tracks.
    if (duplicated.length && item.probe.streams.some(s => s.codec_type === 'attachment')) {
      args.push('-map', '-0:t');
      for (const stream of item.probe.streams.filter(s => s.codec_type === 'attachment')) args.push('-map', `0:${stream.index}`);
    }
    // Explicitly retain attachment codecs even when appended audio changes stream order.
    args.push('-c:t', 'copy', '-progress', 'pipe:1', '-nostats', '-f', 'matroska', temp);
    const budget = createResourceBudget(preferences.performanceMode);
    try {
      await onTemporaryOutput(temp);
      onStage('Converting', 'Writing temporary MKV…');
      await measure('conversion', () => run(this.tools.ffmpeg, args, { signal, onLine: line => {
        if (line.startsWith('out_time_us=')) {
          const elapsed = Number(line.slice(12));
          if (Number.isFinite(elapsed)) onProgress(Number.isFinite(duration) && duration > 0 ? Math.min(0.99, Math.max(0, elapsed / 1e6 / duration)) : 0);
        }
      } }));
      if (signal?.aborted) throw new Error('Cancelled');
      // Persist the completed partial's identity before verification. Interrupted
      // writes without a saved identity are retained rather than guessed at.
      await onTemporaryOutput(temp, await sourceIdentity(temp));
      // Process exit, not its final timestamp, starts verification. Complete is sent only after publication.
      onProgress(0.99);
      onStage('Verifying', 'Checking output structure…');
      const retained = item.probe.streams.filter(stream => !(item.plan.droppedStreams || []).includes(stream.index));
      const trackVerification = require('./verification-progress').verificationPhases({
        video: retained.filter(stream => stream.codec_type === 'video').length * 2,
        audio: item.plan.tracks.some(track => track.action === 'copy' || track.keepOriginal) ? 2 : 0,
        subtitle: retained.filter(stream => stream.codec_type === 'subtitle').length * 2,
        attachment: retained.filter(stream => stream.codec_type === 'attachment').length * 2
      });
      const reportVerification = onVerification;
      onVerification = (label, activity) => reportVerification(label, trackVerification(label.split(' · ')[0], activity));
      onVerification('Checking output structure…');
      const output = await measure('structure', async () => {
        const probe = await this.probe(temp, signal, 120000);
        verifyOutput(item, probe);
        return probe;
      });
      await measure('video', () => this.verifyVideo(item, temp, signal, onVerification));
      await measure('audio', () => this.verifyCopiedAudio(item, temp, signal, onVerification, budget, output));
      await measure('subtitlesAndAttachments', () => this.verifySubtitles(item, temp, signal, onVerification, budget));
      const conversionReport = require('./conversion-report').conversionReport(item, output, preferences, this.profile);
      if (!sameSource(sourceSnapshot, await sourceIdentity(item.file))) throw new Error('Source changed during processing. Output was not published; re-import the source.');
      onStage('Publishing', 'Publishing verified output…');
      const publicationStarted = performance.now();
      const { destination, copied } = await publishOutput(temp, directory, basename, { signal });
      // Removing the private hard link changes ctime; snapshot the final file afterward.
      publicationCleanupAttempted = true;
      let cleanupWarning;
      try { await fs.unlink(temp); }
      catch (error) {
        if (error.code !== 'ENOENT') cleanupWarning = `Media published and verified, but temporary file cleanup failed: ${temp} — ${error.message}`;
      }
      const outputSnapshot = await sourceIdentity(destination);
      // Cleanup trouble must not prevent the published destination being recorded.
      const temporaryOutputSnapshot = cleanupWarning ? await sourceIdentity(temp).catch(() => undefined) : undefined;
      await onPublished({ output: destination, outputSnapshot,
        ...(temporaryOutputSnapshot ? { temporaryOutputSnapshot } : {}) });
      const warnings = [...item.plan.warnings, ...(item.importWarnings || [])];
      if (cleanupWarning) warnings.push(cleanupWarning);
      if (copied) warnings.push('Hard links unavailable: output published using an exclusive copy. The destination was visible during copying.');
      // Publish each matching external subtitle without overwriting anything.
      // Sidecar failures do not invalidate a verified media output; report them.
      const sidecars = [];
      const verifiedSidecars = [];
      for (const sidecar of item.sidecars || []) {
        if (signal?.aborted) { warnings.push('Cancelled during external subtitle copy; media output is complete.'); break; }
        try {
          if (typeof sidecar.suffix !== 'string' || !/^\.[^/\\]+\.(ass|ssa|srt)$/i.test(sidecar.suffix) && !/^\.(ass|ssa|srt)$/i.test(sidecar.suffix)) throw new Error('Unsafe subtitle suffix.');
          const target = path.join(directory, `${path.parse(destination).name}${sidecar.suffix}`);
          const record = await publishSidecar(sidecar, target, { signal });
          verifiedSidecars.push(record);
          if (record.warning) warnings.push(record.warning);
          sidecars.push(target);
        } catch (error) { warnings.push(`External subtitle not copied/verified: ${path.basename(sidecar.file)} — ${error.message}`); }
      }
      timings.publication = (performance.now() - publicationStarted) / 1000;
      timings.total = (performance.now() - started) / 1000;
      onProgress(1);
      return { output: destination, warnings, sidecars, verifiedSidecars, sourceSnapshot, outputSnapshot, outputBytes: outputSnapshot.size, timings, conversionReport };
    } catch (error) {
      if (!signal?.aborted && !publicationCleanupAttempted) error.message += ' Temporary output was not published and is scheduled for cleanup; source media was not modified.';
      throw error;
    } finally {
      budget.close();
      // A second unlink after snapshotting would change the hard-linked output's
      // ctime. Leave a failed cleanup for startup rather than invalidating identity.
      if (!publicationCleanupAttempted) await fs.unlink(temp).catch(() => {});
    }
  }
}

// Accepts source job and output probe data; throws if stream counts, audio properties or duration disagree.
function verifyOutput(item, output) {
  const sourceStreams = item.probe.streams.filter(s => !(item.plan.droppedStreams || []).includes(s.index));
  const added = item.plan.tracks.filter(t => t.keepOriginal && t.action !== 'copy').length;
  if (output.streams.length !== sourceStreams.length + added) throw new Error('Verification failed: stream count changed.');
  const audio = output.streams.filter(s => s.codec_type === 'audio');
  if (audio.length !== item.plan.tracks.length + added) throw new Error('Verification failed: audio track count changed.');
  for (const entry of audioOutputMap(item)) {
    const actual = audio[entry.ordinal];
    if (Number(!!actual.disposition?.default) !== entry.default) throw new Error(`Verification failed: default audio flag changed for output track ${entry.ordinal + 1}.`);
    if ((actual.tags?.language || 'und') !== entry.language || (actual.tags?.title || '') !== entry.title) throw new Error(`Verification failed: audio language/title changed for output track ${entry.ordinal + 1}.`);
  }
  let addedIndex = item.plan.tracks.length;
  for (const [i, track] of item.plan.tracks.entries()) {
    if (track.keepOriginal && track.action !== 'copy') {
      const source = sourceStreams.find(s => s.index === track.index);
      if (audio[i].codec_name !== source.codec_name || audio[i].channels !== source.channels || audio[i].sample_rate !== source.sample_rate || audio[i].tags?.language !== source.tags?.language || audio[i].tags?.title !== source.tags?.title) throw new Error('Verification failed: retained original audio properties changed.');
    }
    const actual = track.keepOriginal && track.action !== 'copy' ? audio[addedIndex++] : audio[i];
    const expectedCodec = track.codec === 'dca' ? 'dts' : track.codec;
    if (actual.codec_name !== expectedCodec || actual.channels !== track.channels) throw new Error(`Verification failed: codec or channel count changed for audio track ${i + 1}.`);
    if (track.action === 'encode' && track.sampleRate && Number(actual.sample_rate) !== Number(track.sampleRate)) throw new Error(`Verification failed: sample rate changed for audio track ${i + 1}.`);
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

module.exports = { Engine, run, parseCapabilities, verifyOutput, hashFile, hashProbe, publishOutput, publishSidecar };