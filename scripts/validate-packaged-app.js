// Inspect the actual packaged resources and execute their native media tools.
// This is a packaging gate, not an installed-upgrade or packaged-GUI test.
const fs = require('node:fs');
const path = require('node:path');
const asar = require('@electron/asar');
const { validateTools } = require('./prepare-tools');
function validatePackagedApp(target, directory = path.resolve(__dirname, '../dist')) {
  if (!['mac', 'win'].includes(target)) throw new Error('Expected mac or win target.');
  const candidates = target === 'win' ? [path.join(directory, 'win-unpacked', 'resources')] :
    fs.readdirSync(directory).filter(name => name.startsWith('mac')).flatMap(name => {
      const base = path.join(directory, name);
      return fs.statSync(base).isDirectory() ? fs.readdirSync(base).filter(file => file.endsWith('.app')).map(file => path.join(base, file, 'Contents', 'Resources')) : [];
    });
  if (candidates.length !== 1) throw new Error(`Expected one packaged application, found ${candidates.length}.`);
  const resources = candidates[0], archive = path.join(resources, 'app.asar');
  for (const file of ['package.json', 'src/main.js', 'src/preload.js', 'src/windows-menu.js', 'src/ui/index.html', 'src/ui/platform.js', 'src/ui/windows-desktop.js', 'src/ui/windows-desktop.css', 'src/assets/logo.png']) {
    if (!asar.extractFile(archive, file).length) throw new Error(`Empty packaged resource: ${file}`);
  }
  const packaged = JSON.parse(asar.extractFile(archive, 'package.json').toString());
  if (packaged.version !== require('../package.json').version) throw new Error('Packaged version does not match source.');
  validateTools(target, path.join(resources, 'tools'));
  if (!fs.readFileSync(path.join(resources, 'license.txt'), 'utf8').trim()) throw new Error('Packaged application license is empty.');
  return resources;
}
if (require.main === module) console.log(`Validated packaged resources: ${validatePackagedApp(process.argv[2], process.argv[3])}`);
module.exports = { validatePackagedApp };