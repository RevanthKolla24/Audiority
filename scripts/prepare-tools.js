const fs = require('node:fs');
const path = require('node:path');
const { toolPaths } = require('../src/tools');
const { execFileSync } = require('node:child_process');
const destination = path.join(__dirname, '..', 'resources', 'tools');
const tools = toolPaths();
for (const [name, binary] of Object.entries(tools)) {
  const version = execFileSync(binary, ['-version'], { encoding: 'utf8' });
  if (version.includes('--enable-nonfree')) throw new Error(`${name} is built with --enable-nonfree and cannot be redistributed. Supply reviewed binaries with AUDIORITY_FFMPEG and AUDIORITY_FFPROBE.`);
}
const notices = process.env.AUDIORITY_TOOL_NOTICES;
if (!notices || !fs.statSync(notices).isDirectory()) throw new Error('Set AUDIORITY_TOOL_NOTICES to a directory containing the FFmpeg/FFprobe licenses, build configuration, and matching source/source-distribution information before packaging.');
fs.rmSync(destination, { recursive: true, force: true });
fs.mkdirSync(destination, { recursive: true });
for (const [name, source] of Object.entries(tools)) {
  if (!source || !fs.existsSync(source)) throw new Error(`Missing ${name} binary for ${process.platform}/${process.arch}`);
  const target = path.join(destination, name + (process.platform === 'win32' ? '.exe' : ''));
  fs.copyFileSync(source, target);
  fs.chmodSync(target, 0o755);
}
fs.cpSync(notices, path.join(destination, 'notices'), { recursive: true });
console.log(`Prepared tools for ${process.platform}/${process.arch}. Build on each target platform/architecture.`);