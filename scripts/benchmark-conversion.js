// Disposable generated-media benchmark. Never imports user media or app settings.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { Engine, run } = require('../src/engine');
const { toolPaths } = require('../src/tools');
const { preferencesDefaults } = require('../src/app-state');

async function main() {
  const duration = Number(process.argv[2] || 15), repeats = Number(process.argv[3] || 3);
  if (!Number.isInteger(duration) || duration < 1 || duration > 600 || !Number.isInteger(repeats) || repeats < 1 || repeats > 10) {
    throw new Error('Usage: node scripts/benchmark-conversion.js [seconds:1-600] [repeats:1-10]');
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'audiority-media-benchmark-'));
  try {
    const tools = toolPaths(), engine = new Engine(tools);
    const input = path.join(root, 'fixture.mkv'), subtitle = path.join(root, 'fixture.srt');
    await fs.writeFile(subtitle, '1\n00:00:00,000 --> 00:00:00,800\nDisposable benchmark subtitle\n');
    await run(tools.ffmpeg, ['-v', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24',
      '-f', 'lavfi', '-i', 'aevalsrc=sin(2*PI*220*t)|sin(2*PI*330*t)|sin(2*PI*440*t)|sin(2*PI*55*t)|sin(2*PI*550*t)|sin(2*PI*660*t):s=48000:c=5.1(side)',
      '-f', 'lavfi', '-i', 'aevalsrc=sin(2*PI*770*t)|sin(2*PI*880*t):s=48000:c=stereo',
      '-f', 'lavfi', '-i', 'aevalsrc=sin(2*PI*990*t)|sin(2*PI*1100*t):s=48000:c=stereo', '-i', subtitle,
      '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:a', '-map', '4:s',
      '-t', String(duration), '-c:v', 'mpeg4', '-q:v', '4', '-c:a:0', 'flac', '-c:a:1', 'ac3', '-c:a:2', 'ac3',
      '-c:s', 'srt', '-metadata:s:a:0', 'title=Surround main', '-metadata:s:a:1', 'title=Stereo alternate',
      '-metadata:s:a:2', 'title=Stereo commentary', '-disposition:a:0', 'default', '-disposition:a:1', '0', '-disposition:a:2', '0', input]);
    const inspectionStarted = performance.now();
    const item = await engine.inspect(input);
    const inspectionSeconds = (performance.now() - inspectionStarted) / 1000;
    if (!item.plan.needsConversion || !item.plan.tracks.some(track => track.action === 'encode')) throw new Error('Fixture did not exercise audio encoding.');
    const runs = [];
    for (let repeat = 0; repeat < repeats; repeat++) {
      // Alternate order to reduce systematic first-run/cache bias; caches are not flushed.
      for (const mode of repeat % 2 ? ['adaptive', 'balanced'] : ['balanced', 'adaptive']) {
        const output = path.join(root, `${repeat}-${mode}`); await fs.mkdir(output);
        const cpu = process.cpuUsage();
        const result = await engine.convert(item, output, { preferences: { ...preferencesDefaults(), performanceMode: mode, keepOriginal: true } });
        const used = process.cpuUsage(cpu);
        runs.push({ repeat: repeat + 1, mode, timings: result.timings, parentCpuSeconds: (used.user + used.system) / 1e6,
          outputBytes: result.outputBytes, warnings: result.warnings, conversionReport: result.conversionReport });
        await fs.rm(output, { recursive: true });
      }
    }
    const medians = {};
    for (const mode of ['balanced', 'adaptive']) {
      medians[mode] = {};
      for (const stage of Object.keys(runs[0].timings)) {
        const values = runs.filter(run => run.mode === mode).map(run => run.timings[stage]).sort((a, b) => a - b);
        const middle = Math.floor(values.length / 2);
        medians[mode][stage] = values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
      }
    }
    console.log(JSON.stringify({ note: 'Generated short media; not movie throughput evidence. Filesystem caches are not flushed. Parent CPU excludes FFmpeg/FFprobe. Disk bytes and child CPU are not measured.',
      platform: process.platform, arch: process.arch, duration, repeats, sourceBytes: item.size, inspectionSeconds,
      tools: await engine.toolVersions(), tracks: item.plan.tracks.map(({ index, action, codec }) => ({ index, action, codec })), medians, runs }, null, 2));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });