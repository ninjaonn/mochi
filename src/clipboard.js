// Writes secrets to the Windows clipboard with the formats that tell
// Win+V history and cloud clipboard sync to ignore them.
// Falls back to a plain write if the native calls are unavailable.
let native = null;

function loadNative() {
  if (native !== null) return native;
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const kernel32 = koffi.load('kernel32.dll');
    native = {
      OpenClipboard: user32.func('bool __stdcall OpenClipboard(void *hwnd)'),
      EmptyClipboard: user32.func('bool __stdcall EmptyClipboard()'),
      CloseClipboard: user32.func('bool __stdcall CloseClipboard()'),
      SetClipboardData: user32.func('void * __stdcall SetClipboardData(uint32_t fmt, void *mem)'),
      RegisterClipboardFormatW: user32.func('uint32_t __stdcall RegisterClipboardFormatW(const char16_t *name)'),
      GlobalAlloc: kernel32.func('void * __stdcall GlobalAlloc(uint32_t flags, size_t bytes)'),
      GlobalLock: kernel32.func('void * __stdcall GlobalLock(void *mem)'),
      GlobalUnlock: kernel32.func('bool __stdcall GlobalUnlock(void *mem)'),
      RtlMoveMemory: kernel32.func('void __stdcall RtlMoveMemory(void *dst, const uint8_t *src, size_t len)'),
    };
  } catch {
    native = false;
  }
  return native;
}

const GMEM_MOVEABLE = 0x0002;
const CF_UNICODETEXT = 13;

function globalFrom(n, buf) {
  const mem = n.GlobalAlloc(GMEM_MOVEABLE, buf.length);
  const ptr = n.GlobalLock(mem);
  n.RtlMoveMemory(ptr, buf, buf.length);
  n.GlobalUnlock(mem);
  return mem;
}

function openWithRetry(n) {
  for (let i = 0; i < 10; i++) {
    if (n.OpenClipboard(null)) return true;
    const until = Date.now() + 20;
    while (Date.now() < until) { /* clipboard busy, wait briefly */ }
  }
  return false;
}

// Returns true when the secret was written with history exclusion.
function writeSecret(text, fallbackClipboard) {
  const n = process.platform === 'win32' ? loadNative() : false;
  if (!n || !openWithRetry(n)) {
    fallbackClipboard.writeText(text);
    return false;
  }
  try {
    n.EmptyClipboard();
    n.SetClipboardData(CF_UNICODETEXT, globalFrom(n, Buffer.from(text + '\0', 'utf16le')));
    const zeroDword = Buffer.alloc(4);
    for (const name of ['ExcludeClipboardContentFromMonitorProcessing', 'CanIncludeInClipboardHistory', 'CanUploadToCloudClipboard']) {
      n.SetClipboardData(n.RegisterClipboardFormatW(name), globalFrom(n, zeroDword));
    }
    return true;
  } finally {
    n.CloseClipboard();
  }
}

module.exports = { writeSecret };
