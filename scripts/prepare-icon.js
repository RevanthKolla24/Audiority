/* Build a multi-resolution Windows ICO using Electron's existing image API.
 * Run with ELECTRON_RUN_AS_NODE unset: electron scripts/prepare-icon.js. */
const { app, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
app.whenReady().then(() => {
  const root = path.resolve(__dirname, '..');
  const image = nativeImage.createFromPath(path.join(root, 'build', 'icon.png'));
  if (image.isEmpty()) throw new Error('Missing or unreadable build/icon.png');
  const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
  const images = sizes.map(size => image.resize({ width: size, height: size, quality: 'best' }).toPNG());
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(1, 2); // ICO type.
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((size, index) => {
    const entry = 6 + index * 16;
    header[entry] = header[entry + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(images[index].length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += images[index].length;
  });
  fs.writeFileSync(path.join(root, 'build', 'icon.ico'), Buffer.concat([header, ...images]));
  console.log(`Windows icon generated: ${sizes.join(', ')}px`);
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });