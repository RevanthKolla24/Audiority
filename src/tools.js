const path = require('node:path');
function toolPaths(resourcesPath) {
  if (resourcesPath) {
    const suffix = process.platform === 'win32' ? '.exe' : '';
    return { ffmpeg: path.join(resourcesPath, 'tools', `ffmpeg${suffix}`), ffprobe: path.join(resourcesPath, 'tools', `ffprobe${suffix}`) };
  }
  return { ffmpeg: process.env.AUDIORITY_FFMPEG || require('ffmpeg-static'), ffprobe: process.env.AUDIORITY_FFPROBE || require('ffprobe-static').path };
}
module.exports = { toolPaths };