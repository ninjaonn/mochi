// FortiClient helpers: VPN status from its network adapter, and auto-type.
// FortiClient has no command line and its saved-password option depends on the
// gateway. Its Chromium window hides its fields from accessibility tools, so
// the user clicks the Username box and Mochi types into the active window,
// but only after confirming that window really belongs to FortiClient.
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const FORTI_DIR = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Fortinet', 'FortiClient');
const FORTI_EXE = path.join(FORTI_DIR, 'FortiClient.exe');

const INPUT_SIZE = 40; // sizeof(INPUT) on x64
const INPUT_KEYBOARD = 1;
const KEYEVENTF_KEYUP = 0x0002;
const KEYEVENTF_UNICODE = 0x0004;
const VK_TAB = 0x09;
const MODIFIER_KEYS = [0x10, 0x11, 0x12, 0x5b, 0x5c]; // Shift, Ctrl, Alt, both Win keys
const PROCESS_QUERY_LIMITED = 0x1000;

let api = null;

function loadApi() {
  if (api) return api;
  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  const kernel32 = koffi.load('kernel32.dll');
  api = {
    sendInput: user32.func('uint32_t __stdcall SendInput(uint32_t count, void *inputs, int size)'),
    keyState: user32.func('int16_t __stdcall GetAsyncKeyState(int key)'),
    foreground: user32.func('void * __stdcall GetForegroundWindow()'),
    windowPid: user32.func('uint32_t __stdcall GetWindowThreadProcessId(void *hwnd, _Out_ uint32_t *pid)'),
    openProcess: kernel32.func('void * __stdcall OpenProcess(uint32_t access, bool inherit, uint32_t pid)'),
    closeHandle: kernel32.func('bool __stdcall CloseHandle(void *handle)'),
    imageName: kernel32.func('bool __stdcall QueryFullProcessImageNameW(void *process, uint32_t flags, void *name, _Inout_ uint32_t *size)'),
  };
  return api;
}

// ---------- status ----------
function findAdapterName() {
  const script = "(Get-NetAdapter -IncludeHidden | Where-Object { $_.InterfaceDescription -like 'Fortinet SSL VPN*' } | Select-Object -First 1).Name";
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true }, (err, stdout) => {
      resolve(err ? '' : stdout.trim());
    });
  });
}

// A disconnected adapter is missing or only has a self-assigned 169.254 address.
function isConnected(adapterName, interfaces = os.networkInterfaces()) {
  return (interfaces[adapterName] || []).some((a) => a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.'));
}

// ---------- typing ----------
function keyboardEvents(events) {
  const buf = Buffer.alloc(events.length * INPUT_SIZE);
  events.forEach(({ vk = 0, scan = 0, flags }, i) => {
    const at = i * INPUT_SIZE;
    buf.writeUInt32LE(INPUT_KEYBOARD, at);
    buf.writeUInt16LE(vk, at + 8);
    buf.writeUInt16LE(scan, at + 10);
    buf.writeUInt32LE(flags, at + 12);
  });
  return buf;
}

function textEvents(text) {
  const events = [];
  for (let i = 0; i < text.length; i++) {
    const scan = text.charCodeAt(i);
    events.push({ scan, flags: KEYEVENTF_UNICODE }, { scan, flags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP });
  }
  return events;
}

const TAB_EVENTS = [{ vk: VK_TAB, flags: 0 }, { vk: VK_TAB, flags: KEYEVENTF_KEYUP }];

function send(events) {
  const buf = keyboardEvents(events);
  const sent = loadApi().sendInput(events.length, buf, INPUT_SIZE);
  buf.fill(0);
  return sent === events.length;
}

function foregroundPath() {
  const a = loadApi();
  const hwnd = a.foreground();
  if (!hwnd) return '';
  const pid = [0];
  a.windowPid(hwnd, pid);
  const process = a.openProcess(PROCESS_QUERY_LIMITED, false, pid[0]);
  if (!process) return '';
  try {
    const name = Buffer.alloc(2048);
    const size = [1024];
    return a.imageName(process, 0, name, size) ? name.toString('utf16le', 0, size[0] * 2) : '';
  } finally {
    a.closeHandle(process);
  }
}

function isFortiClientPath(file) {
  return path.resolve(file).toLowerCase() === FORTI_EXE.toLowerCase();
}

function modifiersDown() {
  const a = loadApi();
  return MODIFIER_KEYS.some((k) => a.keyState(k) < 0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Types username, Tab, password. Never presses Enter: the user checks and submits,
// so a misplaced cursor cannot cost a failed login.
async function autoType({ username, password, isTarget, sendEvents = send, modifiersHeld = modifiersDown, wait = sleep }) {
  // Keys typed while Ctrl+Alt from the hotkey are still held would act as shortcuts.
  for (let i = 0; modifiersHeld(); i++) {
    if (i >= 40) return { ok: false, reason: 'keys-held' };
    await wait(50);
  }
  const steps = [textEvents(username), TAB_EVENTS, textEvents(password)];
  for (const events of steps) {
    if (!isTarget()) return { ok: false, reason: 'focus-lost' };
    if (!sendEvents(events)) return { ok: false, reason: 'blocked' };
    await wait(80);
  }
  return { ok: true };
}

// What the widget shows. A hidden light never reports a drop.
function statusView({ adapter, connected, dropped }, light) {
  return { known: Boolean(adapter), connected, dropped: light && dropped, light };
}

module.exports = { FORTI_EXE, findAdapterName, isConnected, foregroundPath, isFortiClientPath, autoType, textEvents, keyboardEvents, statusView };
