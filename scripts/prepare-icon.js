/* Wrap a 256px PNG in a Windows ICO container using Electron's existing image API.
 * Run with ELECTRON_RUN_AS_NODE unset: electron scripts/prepare-icon.js. */
const { app, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
app.whenReady().then(() => {
  const root = path.resolve(__dirname, '..');
  const png = nativeImage.createFromPath(path.join(root, 'build', 'icon.png')).resize({ width: 256, height: 256 }).toPNG();
  const header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2); // ICO type.
  header.writeUInt16LE(1, 4); // One image; zero width/height bytes denote 256px.
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(22, 18);
  fs.writeFileSync(path.join(root, 'build', 'icon.ico'), Buffer.concat([header, png]));
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });