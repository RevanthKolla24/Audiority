// Native Windows menu; commands reuse renderer buttons and their busy-state guards.
function windowsMenu(sendCommand) {
  const command = (label, accelerator, action) => ({ label, accelerator, click: () => sendCommand(action) });
  return [
    { label: '&File', submenu: [
      command('Add &files…', 'Ctrl+O', 'add-files'),
      command('Add f&older…', 'Ctrl+Shift+O', 'add-folder'),
      { type: 'separator' }, command('&New profile…', 'Ctrl+N', 'new-profile'),
      command('&Settings', 'Ctrl+,', 'settings'), { type: 'separator' }, { role: 'quit' }
    ] },
    { label: '&Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '&View', submenu: [
      command('&Queue', 'Ctrl+1', 'queue'), command('S&tatistics', 'Ctrl+2', 'statistics'),
      { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
      { type: 'separator' }, { role: 'togglefullscreen' }
    ] }
  ];
}
module.exports = { windowsMenu };