const { contextBridge, ipcRenderer } = require('electron');

const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);
const on = (channel) => (cb) => ipcRenderer.on(channel, (_e, payload) => cb(payload));

contextBridge.exposeInMainWorld('mochi', {
  vault: {
    list: call('vault:list'),
    save: call('vault:save'),
    trash: call('vault:trash'),
    restore: call('vault:restore'),
    purge: call('vault:purge'),
    fav: call('vault:fav'),
    reorder: call('vault:reorder'),
    copy: call('vault:copy'),
    reveal: call('vault:reveal'),
    connect: call('vault:connect'),
    run: call('vault:run'),
  },
  lock: {
    status: call('lock:status'),
    lock: call('lock:lock'),
    unlock: call('lock:unlock'),
    pin: call('lock:pin'),
    totp: call('lock:totp'),
    totpBegin: call('lock:totpBegin'),
    totpConfirm: call('lock:totpConfirm'),
    totpDisable: call('lock:totpDisable'),
    onChange: on('lock:changed'),
  },
  notes: {
    get: call('notes:get'),
    save: call('notes:save'),
    open: call('notes:open'),
    onChange: on('notes:changed'),
  },
  win: {
    mini: call('win:mini'),
    moveBy: (dx, dy) => ipcRenderer.send('win:moveBy', dx, dy),
    state: call('win:state'),
    say: call('bubble:say'),
    onNotice: on('win:notice'),
    onIdle: on('win:idle'),
    rename: call('win:rename'),
    autostart: call('win:autostart'),
    setAutostart: call('win:setAutostart'),
  },
  links: {
    open: call('links:open'),
    check: call('links:check'),
    onStatus: on('links:status'),
  },
  water: {
    status: call('water:status'),
    set: call('water:set'),
    sip: call('water:sip'),
    preview: call('water:preview'),
    onDue: on('water:due'),
    onSipped: on('water:sipped'),
  },
  vpn: {
    status: call('vpn:status'),
    open: call('vpn:open'),
    light: call('vpn:light'),
    onStatus: on('vpn:status'),
    onMessage: on('vpn:message'),
  },
  sticky: {
    scan: call('sticky:scan'),
    reviewed: call('sticky:reviewed'),
    reset: call('sticky:reset'),
  },
  mascot: {
    current: call('mascot:current'),
    list: call('mascot:list'),
    add: call('mascot:add'),
    use: call('mascot:use'),
    remove: call('mascot:remove'),
  },
  backup: {
    export: call('backup:export'),
    import: call('backup:import'),
  },
});
