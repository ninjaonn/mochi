const { app, BrowserWindow, ipcMain, safeStorage, clipboard, powerMonitor, globalShortcut, shell, dialog, screen, nativeImage, net } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Vault } = require('./vault');
const { Notes } = require('./notes');
const { Lock, TotpStore } = require('./lock');
const QRCode = require('qrcode');
const { writeSecret } = require('./clipboard');
const { readStickyNotes } = require('./sticky');
const rdp = require('./rdp');
const vpn = require('./vpn');
const autostart = require('./autostart');
const { cleanName, DEFAULT_NAME } = require('./appname');
const command = require('./command');
const { execFile } = require('child_process');
const quickSearch = require('./launcher');
const linkcheck = require('./linkcheck');
const water = require('./water');
const { bubblePosition } = require('./bubble');

const FULL_SIZE = { width: 360, height: 560 };
const RDP_CREDENTIAL_MS = 60000;
const VPN_POLL_MS = 5000;
const LINK_TIMEOUT_MS = 6000;
const SLEEP_AFTER_SECONDS = 300;
const IDLE_POLL_MS = 15000;
const BUBBLE_MAX_SIZE = { width: 240, height: 140 };
const BUBBLE_MS = 15000;
const BUBBLE_SHORT_MS = 4000;
const LAUNCHER_SIZE = { width: 480, height: 460 };
const MINI_SIZE = 84;

class Settings {
  constructor(file) {
    this.file = file;
    this.data = {
      unlockMinutes: 15,
      clipboardSeconds: 30,
      notesPath: path.join(app.getPath('documents'), 'MochiVault', 'notes.md'),
      bounds: null,
      mini: false,
      vpnLight: true,
      waterMinutes: water.DEFAULT_MINUTES,
      waterMessage: water.DEFAULT_MESSAGE,
      appName: DEFAULT_NAME,
    };
    try { Object.assign(this.data, JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { /* first run */ }
  }
  get() { return this.data; }
  update(patch) {
    Object.assign(this.data, patch);
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }
}

if (!app.requestSingleInstanceLock()) app.quit();

let win;
let launcher;
let bubble;
let settings;
let vault;
let notes;
let lock;
let clearTimer;
let lastSecret = null;
const rdpConnector = rdp.createConnector({
  ttlMs: RDP_CREDENTIAL_MS,
  login: (id) => ({ username: vault.secret(id, 'username'), password: vault.secret(id, 'password') }),
  copyPassword: (id) => copyField(id, 'password'),
});

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function onScreen(bounds) {
  return screen.getAllDisplays().some(({ workArea: a }) =>
    bounds.x < a.x + a.width && bounds.x + 40 > a.x && bounds.y < a.y + a.height && bounds.y + 40 > a.y);
}

// ---------- mascots: user pictures kept in <userData>/mascots ----------
const MASCOT_TYPES = { '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
const MAX_MASCOT_BYTES = 5 * 1024 * 1024;
let mascotsDir;

function initMascots() {
  mascotsDir = path.join(app.getPath('userData'), 'mascots');
  fs.mkdirSync(mascotsDir, { recursive: true });
  // One-time move of the picture that used to ship next to the page.
  if (!settings.get().mascotsSeeded) {
    const bundled = path.join(__dirname, 'renderer', 'mascot-dog.png');
    if (fs.existsSync(bundled)) {
      fs.copyFileSync(bundled, path.join(mascotsDir, 'dog.png'));
      if (!settings.get().mascot) settings.update({ mascot: 'dog.png' });
    }
    settings.update({ mascotsSeeded: true });
  }
}

function mascotIds() {
  return fs.readdirSync(mascotsDir).filter((f) => MASCOT_TYPES[path.extname(f).toLowerCase()]).sort();
}

function isMascot(id) {
  return id === 'mochi' || (typeof id === 'string' && path.basename(id) === id && mascotIds().includes(id));
}

// Pictures go to the page as data URLs, which its CSP already allows.
function mascotDataUrl(id) {
  const type = MASCOT_TYPES[path.extname(id).toLowerCase()];
  return `data:${type};base64,${fs.readFileSync(path.join(mascotsDir, id)).toString('base64')}`;
}

function currentMascot() {
  const saved = settings.get().mascot || 'mochi';
  const id = isMascot(saved) ? saved : 'mochi';
  return { id, dataUrl: id === 'mochi' ? null : mascotDataUrl(id) };
}

function addMascotFile(src) {
  const name = path.basename(src);
  const ext = path.extname(src).toLowerCase();
  if (!MASCOT_TYPES[ext]) throw new Error(`${name}: use PNG, GIF, WebP or JPG`);
  if (fs.statSync(src).size > MAX_MASCOT_BYTES) throw new Error(`${name} is over 5 MB`);

  // Shrink big still images; GIF/WebP are copied as-is so animations survive.
  let img = null;
  if (ext === '.png' || ext === '.jpg' || ext === '.jpeg') {
    img = nativeImage.createFromPath(src);
    if (img.isEmpty()) throw new Error(`${name} could not be read`);
    const { width, height } = img.getSize();
    img = width > 512 || height > 512 ? img.resize(width >= height ? { width: 256, quality: 'best' } : { height: 256, quality: 'best' }) : null;
  }
  const outExt = img ? '.png' : ext;
  const base = path.basename(src, path.extname(src)).replace(/[^\w-]+/g, '-').slice(0, 40) || 'mascot';
  let id = base + outExt;
  for (let n = 2; fs.existsSync(path.join(mascotsDir, id)); n++) id = `${base}-${n}${outExt}`;
  if (img) fs.writeFileSync(path.join(mascotsDir, id), img.toPNG());
  else fs.copyFileSync(src, path.join(mascotsDir, id));
  return id;
}

function clampToScreen(r) {
  const a = screen.getDisplayMatching(r).workArea;
  return {
    ...r,
    x: Math.min(Math.max(r.x, a.x), a.x + a.width - r.width),
    y: Math.min(Math.max(r.y, a.y), a.y + a.height - r.height),
  };
}

// The mochi sits where the full widget's top-right corner is,
// so shrinking and expanding feel anchored to the same spot.
function miniBoundsFor(full) {
  return { x: full.x + full.width - MINI_SIZE, y: full.y, width: MINI_SIZE, height: MINI_SIZE };
}

function fullBoundsFor(mini) {
  const full = settings.get().bounds || FULL_SIZE;
  return { x: mini.x + MINI_SIZE - full.width, y: mini.y, width: full.width, height: full.height };
}

// settings.bounds always holds the full-size bounds, even while mini.
function rememberBounds() {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  settings.update({ bounds: settings.get().mini ? fullBoundsFor(b) : b });
}

// The shrunk mascot holds no secrets, so it may be screenshotted/shared.
// The full widget shows passwords, so it stays protected (blank in captures).
function setProtection(mini) {
  win.setContentProtection(!mini);
}

function applyMini(mini) {
  hideBubble();
  const b = win.getBounds();
  if (mini) {
    settings.update({ mini: true, bounds: b });
    win.setResizable(false);
    win.setBounds(miniBoundsFor(b));
  } else {
    const target = clampToScreen(fullBoundsFor(b));
    settings.update({ mini: false, bounds: target });
    win.setResizable(true);
    win.setBounds(target);
  }
  setProtection(mini);
}

function createWindow() {
  const s = settings.get();
  const saved = s.bounds && onScreen(s.bounds) ? s.bounds : {};
  win = new BrowserWindow({
    ...FULL_SIZE,
    width: saved.width || FULL_SIZE.width,
    height: saved.height || FULL_SIZE.height,
    x: saved.x,
    y: saved.y,
    minWidth: MINI_SIZE,
    minHeight: MINI_SIZE,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    resizable: true,
    skipTaskbar: false,
    title: 'Mochi Vault',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setAlwaysOnTop(true, 'floating');
  // Hide the full widget from screen sharing and screenshots; the shrunk
  // mascot holds no secrets, so it may be captured.
  setProtection(Boolean(s.mini));
  if (s.mini) {
    win.setResizable(false);
    win.setBounds(miniBoundsFor(win.getBounds()));
  }
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.on('moved', rememberBounds);
  win.on('resized', rememberBounds);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  // A hidden launcher must not keep the app alive after the widget closes.
  win.on('closed', () => {
    for (const extra of [launcher, bubble]) if (extra && !extra.isDestroyed()) extra.destroy();
  });
  win.on('move', moveBubble);
  win.on('hide', hideBubble);
}

// ---------- speech bubble ----------
// The shrunk mascot's window only fits the mascot, so anything it says gets a
// small window of its own, sized to the text.
const bubbleState = { size: null, ms: 0, timer: null };

function createBubble() {
  bubble = new BrowserWindow({
    ...BUBBLE_MAX_SIZE,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    resizable: false,
    focusable: false,
    hasShadow: false,
    skipTaskbar: true,
    title: 'Mascot bubble',
    webPreferences: {
      preload: path.join(__dirname, 'bubble-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  bubble.setAlwaysOnTop(true, 'floating');
  bubble.setContentProtection(true);
  bubble.loadFile(path.join(__dirname, 'renderer', 'bubble.html'));
  bubble.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  bubble.webContents.on('will-navigate', (e) => e.preventDefault());
}

function placeBubble() {
  const anchor = win.getBounds();
  const place = bubblePosition(anchor, bubbleState.size, screen.getDisplayMatching(anchor).workArea);
  bubble.setBounds({ x: place.x, y: place.y, ...bubbleState.size });
  return place;
}

function moveBubble() {
  if (bubble && !bubble.isDestroyed() && bubble.isVisible()) bubble.webContents.send('bubble:place', placeBubble());
}

function hideBubble() {
  clearTimeout(bubbleState.timer);
  if (bubble && !bubble.isDestroyed()) bubble.hide();
}

function showBubble(text, ms) {
  hideBubble();
  bubbleState.ms = ms;
  // Measuring needs room, so the text can wrap the way it will on screen.
  bubble.setBounds({ ...bubble.getBounds(), ...BUBBLE_MAX_SIZE });
  bubble.webContents.send('bubble:text', text);
}

const mascotShowing = () => settings.get().mini && win.isVisible();

// ---------- quick launcher ----------
function createLauncher() {
  launcher = new BrowserWindow({
    ...LAUNCHER_SIZE,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    title: 'Quick search',
    webPreferences: {
      preload: path.join(__dirname, 'launcher-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  launcher.setAlwaysOnTop(true, 'floating');
  launcher.setContentProtection(true);
  launcher.loadFile(path.join(__dirname, 'renderer', 'launcher.html'));
  launcher.on('blur', () => launcher.hide());
  launcher.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  launcher.webContents.on('will-navigate', (e) => e.preventDefault());
}

function toggleLauncher() {
  if (launcher.isVisible()) { launcher.hide(); return; }
  // Open on the screen the mouse is on.
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  launcher.setPosition(
    Math.round(area.x + (area.width - LAUNCHER_SIZE.width) / 2),
    Math.round(area.y + area.height * 0.18),
  );
  launcher.show();
  launcher.focus();
  launcher.webContents.send('launcher:show');
}

function clearSecretFromClipboard() {
  if (lastSecret && clipboard.readText() === lastSecret) clipboard.clear();
  lastSecret = null;
}

function copyField(id, field) {
  const value = vault.secret(id, field);
  if (!vault.isSecretField(id, field)) {
    clipboard.writeText(value);
    return { ok: true };
  }
  const excluded = writeSecret(value, clipboard);
  clearTimeout(clearTimer);
  lastSecret = value;
  const seconds = settings.get().clipboardSeconds;
  clearTimer = setTimeout(clearSecretFromClipboard, seconds * 1000);
  return { ok: true, excluded, clearsIn: seconds };
}

// ---------- FortiClient VPN ----------
const vpnState = { adapter: '', connected: false, dropped: false };

function vpnStatus() {
  return vpn.statusView(vpnState, settings.get().vpnLight);
}

function checkVpn() {
  const connected = vpn.isConnected(vpnState.adapter);
  if (connected === vpnState.connected) return;
  vpnState.dropped = !connected;
  vpnState.connected = connected;
  linkChecker.forget();
  send('vpn:status', vpnStatus());
}

// ---------- mascot mood ----------
let asleep = false;

function checkIdle() {
  const idle = powerMonitor.getSystemIdleTime() >= SLEEP_AFTER_SECONDS;
  if (idle === asleep) return;
  asleep = idle;
  send('win:idle', asleep);
}

// ---------- water reminder ----------
const waterState = { lastSip: Date.now(), lastNudge: 0 };

function restartWater() {
  waterState.lastSip = Date.now();
  waterState.lastNudge = 0;
}

function checkWater() {
  const now = Date.now();
  if (!water.shouldNudge({ ...waterState, minutes: settings.get().waterMinutes, now, asleep })) return;
  waterState.lastNudge = now;
  const message = water.cleanMessage(settings.get().waterMessage);
  send('water:due', { message });
  if (mascotShowing()) showBubble(message, BUBBLE_MS);
}

// ---------- link status ----------
async function probeLink(url) {
  try {
    const r = await net.fetch(url, { method: 'HEAD', redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(LINK_TIMEOUT_MS) });
    return { status: r.status };
  } catch (err) {
    return { error: err.message };
  }
}

const linkChecker = linkcheck.createChecker({
  probe: probeLink,
  isVpnOff: () => Boolean(vpnState.adapter) && !vpnState.connected,
  onResult: (result) => send('links:status', result),
});

const fortiClientActive = () => vpn.isFortiClientPath(vpn.foregroundPath());

async function typeVpnLogin() {
  const stop = (text, unlock = false) => send('vpn:message', { text, unlock });
  if (!fortiClientActive()) { stop('Click the Username box in FortiClient, then press Ctrl+Alt+V'); return; }
  const id = vault.vpnEntryId();
  if (!id) { stop('Edit your VPN key and tick 🔌 VPN login first'); return; }
  const username = vault.secret(id, 'username');
  if (!username) { stop('Your VPN key has no username'); return; }
  if (!lock.isUnlocked()) { stop('Unlock Mochi, then press Ctrl+Alt+V again', true); return; }
  const r = await vpn.autoType({ username, password: vault.secret(id, 'password'), isTarget: fortiClientActive });
  if (r.reason === 'focus-lost') stop('Stopped: FortiClient was no longer the active window');
  if (r.reason === 'keys-held') stop('Let go of Ctrl+Alt+V, then try again');
  if (r.reason === 'blocked') stop('Windows blocked typing into FortiClient');
}

// Secret access: unlock first (Windows Hello pops its own dialog).
async function ensureUnlocked() {
  if (lock.isUnlocked()) return { ok: true };
  if (lock.status().method === 'hello') {
    win.setAlwaysOnTop(false);
    const r = await lock.unlockWithHello();
    win.setAlwaysOnTop(true, 'floating');
    return r;
  }
  return { ok: false, needPin: true };
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}

function registerIpc() {
  handle('vault:list', () => vault.list().map((e) => ({ ...e, hostCount: rdp.parseHosts(e.host).length })));
  handle('vault:save', (entry) => ({ ok: true, id: vault.save(entry) }));
  handle('vault:trash', (id) => { vault.trash(id); return { ok: true }; });
  handle('vault:restore', (id) => { vault.restore(id); return { ok: true }; });
  handle('vault:purge', (id) => { vault.purge(id); return { ok: true }; });
  handle('vault:fav', (id) => { vault.toggleFav(id); return { ok: true }; });
  handle('vault:reorder', (ids) => { vault.reorder(ids); return { ok: true }; });
  handle('vault:copy', async (id, field) => {
    if (vault.isSecretField(id, field)) {
      const u = await ensureUnlocked();
      if (!u.ok) return u;
    }
    return copyField(id, field);
  });
  handle('vault:reveal', async (id, field) => {
    const u = await ensureUnlocked();
    if (!u.ok) return u;
    return { ok: true, value: vault.secret(id, field) };
  });

  handle('vault:run', async (id) => {
    const text = vault.secret(id, 'command');
    if (!command.hasCommand(text)) return { ok: false, error: 'This key has no command' };
    const u = await ensureUnlocked();
    if (!u.ok) return u;
    let file;
    try {
      file = command.scriptPath(app.getPath('temp'));
      fs.writeFileSync(file, command.buildScript(text), 'utf8');
    } catch (err) {
      return { ok: false, error: err.message };
    }
    // Launch in a brand-new PowerShell window, detached so it outlives Mochi.
    const child = execFile('powershell.exe', command.launchArgs(file), { windowsHide: false, detached: true });
    child.on('error', () => {});
    child.unref();
    // Remove the one-shot script a little later; PowerShell has read it by then.
    setTimeout(() => { try { fs.unlinkSync(file); } catch { /* already gone */ } }, 15000);
    return { ok: true };
  });

  handle('vault:connect', async (id, chosen) => {
    const hosts = rdp.parseHosts(vault.secret(id, 'host'));
    if (!hosts.length) return { ok: false, error: 'Add a Host to this key first' };
    if (hosts.length > 1 && !chosen) return { ok: true, chooseHost: rdp.parseHostGroups(vault.secret(id, 'host')) };
    const host = chosen || hosts[0];
    if (!hosts.includes(host) || !rdp.isValidHost(host)) return { ok: false, error: `"${host}" is not a valid server name` };
    const u = await ensureUnlocked();
    if (!u.ok) return u;
    return rdpConnector.connect(id, host);
  });

  handle('vpn:status', () => vpnStatus());
  handle('vpn:light', (on) => {
    settings.update({ vpnLight: Boolean(on) });
    vpnState.dropped = false;
    send('vpn:status', vpnStatus());
    return { ok: true };
  });
  handle('vpn:open', async () => {
    const error = await shell.openPath(vpn.FORTI_EXE);
    return error ? { ok: false, error } : { ok: true };
  });

  handle('lock:status', () => lock.status());
  handle('lock:lock', () => { lock.lock(); return { ok: true }; });
  handle('lock:unlock', () => ensureUnlocked());
  handle('lock:pin', (pin) => (lock.status().pinSet ? lock.unlockWithPin(pin) : lock.setPin(String(pin))));
  handle('lock:totp', (code) => lock.unlockWithTotp(String(code)));
  handle('lock:totpBegin', async () => {
    const r = lock.beginTotpSetup(os.userInfo().username);
    if (!r.ok) return r;
    // Render the QR in the main process; the renderer's CSP blocks bundled libs.
    const svg = await QRCode.toString(r.url, { type: 'svg', errorCorrectionLevel: 'M', margin: 2 });
    return { ok: true, secret: r.secret, qr: 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64') };
  });
  handle('lock:totpConfirm', (code) => lock.confirmTotpSetup(String(code)));
  handle('lock:totpDisable', (code) => lock.disableTotp(String(code)));

  handle('notes:get', () => notes.get());
  handle('notes:save', (doc) => { notes.write(doc); return { ok: true }; });
  handle('notes:open', () => shell.openPath(path.dirname(settings.get().notesPath)));
  // Only web links go to the browser; never file:// or app protocols.
  handle('links:open', async (raw) => {
    let url;
    try { url = new URL(/^www\./i.test(raw) ? `https://${raw}` : raw); } catch { return { ok: false, error: 'Not a valid link' }; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, error: 'Only http/https links can be opened' };
    await shell.openExternal(url.href);
    return { ok: true };
  });

  handle('water:status', () => ({ minutes: settings.get().waterMinutes, message: water.cleanMessage(settings.get().waterMessage) }));
  handle('water:set', (minutes, message) => {
    settings.update({ waterMinutes: water.cleanMinutes(minutes), waterMessage: water.cleanMessage(message) });
    restartWater();
    return { ok: true, minutes: settings.get().waterMinutes };
  });
  handle('water:sip', () => { restartWater(); hideBubble(); return { ok: true }; });
  handle('water:preview', (message) => { showBubble(water.cleanMessage(message), BUBBLE_SHORT_MS); return { ok: true }; });

  handle('bubble:say', (text) => {
    if (text && mascotShowing()) showBubble(water.cleanMessage(text), BUBBLE_SHORT_MS);
    return { ok: true };
  });
  handle('bubble:size', (width, height) => {
    bubbleState.size = { width, height };
    return placeBubble();
  });
  handle('bubble:show', () => {
    bubble.showInactive();
    bubbleState.timer = setTimeout(hideBubble, bubbleState.ms);
    return { ok: true };
  });
  // Clicking a water reminder counts as the sip.
  handle('bubble:click', () => {
    hideBubble();
    if (waterState.lastNudge) { restartWater(); send('water:sipped'); }
    return { ok: true };
  });

  handle('links:check', (urls, force) => linkChecker.check(urls, force));

  handle('launcher:search', (text) => quickSearch.search(quickSearch.buildItems(vault.list(), notes.get().links), text));
  handle('launcher:copyLink', (url) => { clipboard.writeText(String(url)); return { ok: true }; });
  handle('launcher:hide', () => { launcher.hide(); return { ok: true }; });

  handle('win:mini', (mini) => { applyMini(Boolean(mini)); return { ok: true }; });
  // Fire-and-forget so dragging the mochi stays smooth.
  let saveTimer;
  ipcMain.on('win:moveBy', (_e, dx, dy) => {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    const [x, y] = win.getPosition();
    win.setPosition(Math.round(x + dx), Math.round(y + dy));
    clearTimeout(saveTimer);
    saveTimer = setTimeout(rememberBounds, 300);
  });
  handle('win:state', () => ({ mini: settings.get().mini, name: cleanName(settings.get().appName) }));
  handle('win:rename', (name) => {
    settings.update({ appName: cleanName(name) });
    return { ok: true, name: settings.get().appName };
  });
  const loginItem = () => autostart.loginItem({ execPath: process.execPath, appPath: app.getAppPath(), packaged: app.isPackaged });
  const autostartOn = () => autostart.isOn(app.getLoginItemSettings(), loginItem());
  handle('win:autostart', () => ({ on: autostartOn() }));
  handle('win:setAutostart', (on) => {
    app.setLoginItemSettings({ ...loginItem(), openAtLogin: Boolean(on) });
    return { ok: true, on: autostartOn() };
  });

  // Sticky Notes hold plain-text passwords, so reading them needs an unlock too.
  handle('sticky:scan', async () => {
    const u = await ensureUnlocked();
    if (!u.ok) return u;
    const reviewed = new Set(settings.get().stickyReviewed || []);
    const { notes: found, errors } = readStickyNotes();
    return { ok: true, errors, notes: found.map((n) => ({ ...n, reviewed: reviewed.has(n.id) })) };
  });
  handle('sticky:reviewed', (id) => {
    const reviewed = new Set(settings.get().stickyReviewed || []);
    reviewed.add(id);
    settings.update({ stickyReviewed: [...reviewed] });
    return { ok: true };
  });
  handle('sticky:reset', () => { settings.update({ stickyReviewed: [] }); return { ok: true }; });

  handle('mascot:current', () => currentMascot());
  handle('mascot:list', () => ({
    current: currentMascot().id,
    items: mascotIds().map((id) => ({ id, dataUrl: mascotDataUrl(id) })),
  }));
  handle('mascot:add', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Add mascot',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Images', extensions: ['png', 'gif', 'webp', 'jpg', 'jpeg'] }],
    });
    if (r.canceled) return { ok: false, canceled: true };
    const added = [];
    const errors = [];
    for (const file of r.filePaths) {
      try { added.push(addMascotFile(file)); } catch (err) { errors.push(err.message); }
    }
    return { ok: true, added, errors };
  });
  handle('mascot:use', (id) => {
    if (!isMascot(id)) return { ok: false, error: 'Mascot not found' };
    settings.update({ mascot: id });
    return { ok: true, ...currentMascot() };
  });
  handle('mascot:remove', (id) => {
    if (id === 'mochi' || !isMascot(id)) return { ok: false, error: 'That mascot cannot be deleted' };
    fs.unlinkSync(path.join(mascotsDir, id));
    if (settings.get().mascot === id) settings.update({ mascot: 'mochi' });
    return { ok: true, current: currentMascot() };
  });

  handle('backup:export', async (master) => {
    if (!master || master.length < 8) return { ok: false, error: 'Master password needs 8+ characters' };
    const r = await dialog.showSaveDialog(win, { defaultPath: `mochi-vault-backup-${new Date().toISOString().slice(0, 10)}.mvault`, filters: [{ name: 'Mochi Vault backup', extensions: ['mvault'] }] });
    if (r.canceled) return { ok: false, canceled: true };
    vault.exportTo(r.filePath, master);
    return { ok: true, file: r.filePath };
  });
  handle('backup:import', async (master) => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Mochi Vault backup', extensions: ['mvault'] }] });
    if (r.canceled) return { ok: false, canceled: true };
    return { ok: true, count: vault.importFrom(r.filePaths[0], master) };
  });
}

app.whenReady().then(() => {
  const dataDir = app.getPath('userData');
  settings = new Settings(path.join(dataDir, 'settings.json'));

  if (!safeStorage.isEncryptionAvailable()) {
    dialog.showErrorBox('Mochi Vault', 'Windows encryption (DPAPI) is not available, so passwords cannot be stored safely.');
    app.quit();
    return;
  }
  vault = new Vault(path.join(dataDir, 'vault.enc'), safeStorage);
  notes = new Notes(settings.get().notesPath, (doc) => send('notes:changed', doc));
  const totpStore = new TotpStore(path.join(dataDir, 'totp.enc'), safeStorage);
  lock = new Lock(settings, () => send('lock:changed', lock.status()), totpStore);
  initMascots();

  registerIpc();
  createWindow();
  createLauncher();
  createBubble();

  setInterval(() => { checkIdle(); checkWater(); }, IDLE_POLL_MS);
  powerMonitor.on('lock-screen', () => { lock.lock(); launcher.hide(); });
  powerMonitor.on('suspend', () => lock.lock());
  // Check for a new day (daily log rollover) when the PC wakes or unlocks.
  const refreshDay = () => send('notes:changed', notes.get());
  powerMonitor.on('unlock-screen', refreshDay);
  powerMonitor.on('resume', refreshDay);

  vpn.findAdapterName().then((name) => {
    vpnState.adapter = name;
    vpnState.connected = vpn.isConnected(name);
    linkChecker.forget();
    send('vpn:status', vpnStatus());
    if (name) setInterval(checkVpn, VPN_POLL_MS);
  });
  globalShortcut.register('Control+Alt+V', () => {
    typeVpnLogin().catch((err) => send('vpn:message', { text: err.message }));
  });

  if (!globalShortcut.register('Control+Alt+Space', toggleLauncher)) {
    win.webContents.once('did-finish-load', () => send('win:notice', '⚠️ Another app is using Ctrl+Alt+Space, so quick search is off'));
  }

  globalShortcut.register('Control+Alt+M', () => {
    if (win.isVisible()) win.hide(); else { win.show(); win.focus(); }
  });
});

app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  // Do not leave a copied secret behind after quitting.
  clearTimeout(clearTimer);
  clearSecretFromClipboard();
  rdpConnector.forgetAll();
});
app.on('window-all-closed', () => app.quit());
