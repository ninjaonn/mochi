// Start with Windows, through Electron's per-user login item.
// Run from source, electron.exe needs the app folder as its argument.
// An installed build (.exe) needs no argument.
const NAME = 'Mochi Vault';

function loginItem({ execPath, appPath, packaged, name = NAME }) {
  return { name, path: execPath, args: packaged ? [] : [appPath] };
}

// Electron's openAtLogin ignores a custom name, so read launchItems instead.
// Off when disabled in Task Manager, or when the entry points at an old folder.
function isOn(settings, item) {
  return settings.launchItems.some((i) => i.name === item.name && i.enabled && i.path === item.path
    && JSON.stringify(i.args) === JSON.stringify(item.args));
}

module.exports = { loginItem, isOn };
