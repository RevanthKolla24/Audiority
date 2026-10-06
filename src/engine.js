const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { planFile } = require('./policy');
const { sourceFormat } = require('./profiles');
const os = require('node:os');
const { resolveOutputDirectory } = require('./imports');
const { validatePreferences, preferencesDefaults } = require('./app-state');
// COPYFILE_EXCL refuses existing destinations but is not atomic publication:
// the final pathname is visible while copying. Never unlink on copy failure;
// Node handles its failed copy, and the pathname may belong to someone else.
async function publishOutput(temp, directory, basename, { io = fs, signal } = {}) {
  let copyOnly = false;
  for (let i = 0; i < 10000; i++) {
    if (signal?.aborted) throw new Error('Cancelled');
    const destination = path.join(directory, `${basename}${i ? ` (${i})` : ''}.mkv`);
    if (!copyOnly) {
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
      await io.copyFile(temp, destination, require('node:fs').constants.COPYFILE_EXCL);
      return { destination, copied: true };
    } catch (error) {
      if (error.code === 'EEXIST') continue;
      throw new Error(`Cannot copy verified output without overwriting: ${error.message}`, { cause: error });
    }
  }
  throw new Error('Could not find an unused output filename.');
}
async function hashFile(file, signal) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of require('node:fs').createReadStream(file, { signal })) hash.update(chunk);
  return hash.digest('hex');
}
async function hashProbe(binary, args, signal) {
  const hash = crypto.createHash('sha256');
  await run(binary, args, { signal, onLine: line => hash.update(`${line}\n`) });
  return hash.digest('hex');
}

function run(binary, args, { signal, onLine } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Cancelled'));
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

function parseCapabilities(text) {
  return {
    layouts: (text.match(/Supported channel layouts:\s*([^\r\n]+)/)?.[1] || '').trim().split(/\s+/).filter(Boolean),
    rates: (text.match(/Supported sample rates:\s*([^\r\n]+)/)?.[1] || '').trim().split(/\s+/).map(Number).filter(Number.isFinite)
  };
}

class Engine {
  constructor(tools) { this.tools = tools; this.capabilities = null; this.profile = null; }
  setProfile(profile) { this.profile = profile; }
  replan(item) { item.plan = planFile(item.probe, this.capabilities, this.profile); return item; }
  async initialize() {
    const entries = await Promise.all(['dca', 'ac3'].map(async encoder => {
      const { stdout, stderr } = await run(this.tools.ffmpeg, ['-hide_banner', '-h', `encoder=${encoder}`]);
      return [encoder, parseCapabilities(stdout + stderr)];
    }));
    this.capabilities = Object.fromEntries(entries);
    return this.capabilities;
  }
  async toolVersions() {
    const versions = {};
    for (const [name, binary] of Object.entries(this.tools)) versions[name] = (await run(binary, ['-version'])).stdout.split('\n')[0];
    return versions;
  }
  async probe(file, signal) {
    const result = await run(this.tools.ffprobe, ['-v', 'error', '-show_format', '-show_streams', '-show_chapters', '-of', 'json', file], { signal });
    return JSON.parse(result.stdout);
  }
  async inspectDtsCore(file, index, signal) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'audiority-core-'));
    try {
      const sample = path.join(directory, 'core.dts');
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
  async inspect(file, { signal } = {}) {
    const stat = await fs.stat(file);
    if (!stat.isFile()) throw new Error('Please choose a file, not a folder.');
    if (!this.capabilities) await this.initialize();
    const probe = await this.probe(file, signal);
    for (const stream of probe.streams.filter(s => s.codec_type === 'audio' && sourceFormat(s) === 'dtshd')) {
      stream.audiorityCore = await this.inspectDtsCore(file, stream.index, signal);
    }
    const plan = planFile(probe, this.capabilities, this.profile);
    if (!plan.tracks.length) throw new Error('No audio tracks found.');
    const subtitles = probe.streams.filter(s => s.codec_type === 'subtitle');
    const attachments = probe.streams.filter(s => s.codec_type === 'attachment');
    const fonts = attachments.filter(s => /\.(ttf|otf|ttc)$/i.test(s.tags?.filename || '') || /font|truetype|opentype/i.test(s.tags?.mimetype || ''));
    return { file, name: path.basename(file), size: stat.size, duration: Number(probe.format?.duration) || 0, probe, plan,
      subtitleInfo: { count: subtitles.length, ass: subtitles.filter(s => ['ass', 'ssa'].includes(s.codec_name)).length, fonts: fonts.length, attachments: attachments.length } };
  }
  async verifySubtitles(item, outputFile, signal) {
    // Stream copy must preserve ASS style headers, subtitle packets and all
    // attachment payloads. No decode/render step is used or implied here.
    if (!item.plan.needsConversion) return;
    const targets = item.probe.streams.filter(s => ['subtitle', 'attachment'].includes(s.codec_type));
    if (!targets.length) return;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    let next = 0, failure;
    const verify = async source => {
      const args = ['-v', 'error', '-select_streams', String(source.index), '-show_streams', '-show_data_hash', 'sha256', '-show_entries', 'stream=codec_name,extradata_hash:stream_tags=language,title,filename,mimetype:stream_disposition=default,forced'];
      if (source.codec_type === 'subtitle') args.push('-show_packets', '-show_entries', 'stream=codec_name,extradata_hash:stream_tags=language,title,filename,mimetype:stream_disposition=default,forced:packet=data_hash');
      args.push('-of', 'json');
      const [before, after] = await Promise.all([
        track(hashProbe(this.tools.ffprobe, [...args, item.file], controller.signal)),
        track(hashProbe(this.tools.ffprobe, [...args, outputFile], controller.signal))
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
  async convert(item, directory, { signal, onProgress = () => {}, onTemporaryOutput = async () => {}, preferences = preferencesDefaults() } = {}) {
    preferences = validatePreferences(preferences);
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
    const args = ['-hide_banner', '-nostdin', '-v', 'warning', '-n', '-i', item.file, '-map', '0', '-map_metadata', '0', '-map_chapters', '0', '-c', 'copy'];
    item.plan.tracks.forEach((track, i) => {
      if (track.action === 'extract') { args.push(`-bsf:a:${i}`, 'dca_core'); return; }
      if (track.action !== 'encode') return;
      args.push(`-c:a:${i}`, track.codec);
      if (preferences.threads) args.push(`-threads:a:${i}`, String(preferences.threads));
      if (track.codec === 'dca') args.push(`-strict:a:${i}`, 'experimental');
      if (track.bitrate) args.push(`-b:a:${i}`, track.bitrate);
      if (track.sampleRate) args.push(`-ar:a:${i}`, String(track.sampleRate));
      if (track.downmix) args.push(`-filter:a:${i}`, `aresample=out_chlayout=${track.layout}:rematrix_maxval=1`);
      // Explicit layout prevents automatic downmixing to another encoder layout.
      args.push(`-channel_layout:a:${i}`, track.layout);
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

function verifyOutput(item, output) {
  const sourceStreams = item.probe.streams;
  if (output.streams.length !== sourceStreams.length) throw new Error('Verification failed: stream count changed.');
  const audio = output.streams.filter(s => s.codec_type === 'audio');
  if (audio.length !== item.plan.tracks.length) throw new Error('Verification failed: audio track count changed.');
  for (const [i, track] of item.plan.tracks.entries()) {
    const actual = audio[i];
    const expectedCodec = track.codec === 'dca' ? 'dts' : track.codec;
    if (actual.codec_name !== expectedCodec || actual.channels !== track.channels) throw new Error(`Verification failed: codec or channel count changed for audio track ${i + 1}.`);
    if (track.action === 'extract' && (sourceFormat(actual) !== 'dts' || Number(actual.sample_rate) !== track.sampleRate)) throw new Error('Verification failed: extracted DTS core properties differ from plan.');
    // Matroska PCM often omits a layout field; its two-channel output uses
    // standard interleaved left/right order. Never infer multichannel layouts.
    const actualLayout = actual.channel_layout || (actual.codec_name.startsWith('pcm_') && actual.channels === 2 ? 'stereo' : undefined);
    if (track.layout && actualLayout !== track.layout) throw new Error(`Verification failed: channel layout changed for audio track ${i + 1}.`);
  }
  for (const [i, source] of sourceStreams.entries()) {
    if (source.codec_type !== 'audio' && (output.streams[i].codec_type !== source.codec_type || output.streams[i].codec_name !== source.codec_name)) throw new Error('Verification failed: a copied stream changed.');
  }
  const outputDuration = Number(output.format?.duration);
  if (item.duration && (!Number.isFinite(outputDuration) || Math.abs(outputDuration - item.duration) > Math.max(1, item.duration * 0.001))) throw new Error('Verification failed: output duration differs from input.');
}

module.exports = { Engine, run, parseCapabilities, verifyOutput, hashFile, hashProbe, publishOutput };