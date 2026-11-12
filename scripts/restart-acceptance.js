// Node coordinator: three genuinely separate Electron processes, private data/media only.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { run } = require('../src/engine');
const { toolPaths } = require('../src/tools');

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'audiority-restart-acceptance-'));
  try {
    await fs.mkdir(path.join(root, 'output'));
    await run(toolPaths().ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i',
      'aevalsrc=0.1*sin(2*PI*220*t)|0.1*sin(2*PI*330*t)|0.1*sin(2*PI*440*t)|0.1*sin(2*PI*55*t)|0.1*sin(2*PI*550*t)|0.1*sin(2*PI*660*t):s=48000:c=5.1(side)',
      '-t', '3', '-c:a', 'flac', path.join(root, 'source.mkv')]);
    for (const phase of ['save', 'convert', 'verify']) {
      await new Promise((resolve, reject) => {
        const child = spawn(require('electron'), [path.join(__dirname, 'restart-acceptance-child.js'), root, phase], { stdio: 'inherit' });
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Restart acceptance ${phase} timed out`)); }, 45000);
        child.on('error', error => { clearTimeout(timer); reject(error); });
        child.on('exit', (code, signal) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`${phase}: exit ${code}, signal ${signal}`)); });
      });
    }
    const queue = JSON.parse(await fs.readFile(path.join(root, 'profile', 'queue.json'), 'utf8'));
    assert.equal(queue.items[0].status, 'Complete');
    assert.ok(queue.items[0].timings.total > 0);
    console.log('Restart acceptance passed: save/quit, restore/hidden conversion, restart/verified output.');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });