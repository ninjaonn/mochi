// The name shown in the title bar and on the taskbar. Display only: data
// folders and the startup entry keep their original names.
const DEFAULT_NAME = '🍡 Mochi Vault';
const MAX_LENGTH = 30;

// Blank goes back to the default. Counts characters, so emoji stay whole.
function cleanName(text) {
  const name = String(text ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return [...name].slice(0, MAX_LENGTH).join('').trim() || DEFAULT_NAME;
}

module.exports = { DEFAULT_NAME, MAX_LENGTH, cleanName };
