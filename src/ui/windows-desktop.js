// Windows presentation only; existing buttons retain their handlers and busy guards.
if (api.platform === 'win32') {
  const sidebar = document.querySelector('.sidebar');
  const navigation = document.querySelector('.app-nav');
  sidebar.insertBefore(navigation, document.querySelector('.sidebar-heading'));
  navigation.setAttribute('aria-label', 'Workspace navigation');
  const localNote = document.querySelector('.sidebar-bottom');
  localNote.textContent = 'On-device processing · No uploads';
  document.querySelector('header .eyebrow').textContent = 'LOCAL MEDIA UTILITY';
  $('policy-summary-slot').append(document.querySelector('.policy'));
  const importFiles = element('button', '', 'Add files…');
  importFiles.id = 'import-files';
  importFiles.type = 'button';
  importFiles.title = 'Add media files (Ctrl+O)';
  importFiles.addEventListener('click', () => { if (!$('import-folder').disabled) $('drop').click(); });
  document.querySelector('.import-controls').prepend(importFiles);
  // The canonical drop control owns busy state; mirror it without extra IPC.
  const syncImport = () => { importFiles.disabled = $('import-folder').disabled; };
  new MutationObserver(syncImport).observe($('import-folder'), { attributes: true, attributeFilter: ['disabled'] });
  syncImport();
  api.onUpdate(update => {
    if (update.type !== 'desktop-command') return;
    if (document.querySelector('dialog[open]')) return;
    const targets = { 'add-files': 'import-files', 'add-folder': 'import-folder', queue: 'nav-queue', settings: 'nav-settings', statistics: 'nav-statistics', 'new-profile': 'new-profile' };
    const button = $(targets[update.command]);
    if (button && !button.disabled) {
      if (['add-files', 'add-folder'].includes(update.command)) {
        if (profileEditing) return;
        showPage('queue');
        if (button.disabled) return;
      }
      button.click();
    }
  });
}