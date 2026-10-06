/*
 * tools.js
 * Finds executables for main.js and engine.js. Guide: packaged resource paths; Windows suffix; development and environment overrides.
 * Learning note: async functions return Promises; await gets their result and try/catch handles failure.
 */
const path = require('node:path');
// Tool paths: receives resourcesPath. Returns the calculated value for the caller.
function toolPaths(resourcesPath) {
  if (resourcesPath) {
    const suffix = process.platform === 'win32' ? '.exe' : '';
    return { ffmpeg: path.join(resourcesPath, 'tools', `ffmpeg${suffix}`), ffprobe: path.join(resourcesPath, 'tools', `ffprobe${suffix}`) };
  }
  return { ffmpeg: process.env.AUDIORITY_FFMPEG || require('ffmpeg-static'), ffprobe: process.env.AUDIORITY_FFPROBE || require('ffprobe-static').path };
}
module.exports = { toolPaths };