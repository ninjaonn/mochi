const test = require('node:test');
const assert = require('node:assert');
const { FORTI_EXE, isConnected, isFortiClientPath, autoType, textEvents, keyboardEvents, statusView } = require('../src/vpn');

const noWait = async () => {};
const typed = (log) => log.map((events) => events.filter((e) => e.scan && !(e.flags & 2)).map((e) => String.fromCharCode(e.scan)).join('') || 'TAB');

function run(overrides = {}) {
  const log = [];
  const options = {
    username: 'first.last',
    password: 'Fake-P@ss',
    isTarget: () => true,
    sendEvents: (events) => { log.push(events); return true; },
    modifiersHeld: () => false,
    wait: noWait,
    ...overrides,
  };
  return autoType(options).then((result) => ({ result, log }));
}

test('reads connection state from the adapter', () => {
  const up = { 'Ethernet 3': [{ family: 'IPv4', internal: false, address: '10.212.134.5' }] };
  const selfAssigned = { 'Ethernet 3': [{ family: 'IPv4', internal: false, address: '169.254.10.2' }] };
  assert.equal(isConnected('Ethernet 3', up), true);
  assert.equal(isConnected('Ethernet 3', selfAssigned), false);
  assert.equal(isConnected('Ethernet 3', {}), false);
  assert.equal(isConnected('', up), false);
});

test('accepts only the real FortiClient program', () => {
  assert.equal(isFortiClientPath(FORTI_EXE), true);
  assert.equal(isFortiClientPath(FORTI_EXE.toUpperCase()), true);
  assert.equal(isFortiClientPath('C:\\Temp\\FortiClient.exe'), false);
  assert.equal(isFortiClientPath('C:\\Windows\\notepad.exe'), false);
  assert.equal(isFortiClientPath(''), false);
});

test('types username, Tab, password and never Enter', async () => {
  const { result, log } = await run();
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(typed(log), ['first.last', 'TAB', 'Fake-P@ss']);
  const keys = log.flat().map((e) => e.vk).filter(Boolean);
  assert.ok(!keys.includes(0x0d));
});

test('types nothing when another window is active', async () => {
  const { result, log } = await run({ isTarget: () => false });
  assert.deepEqual(result, { ok: false, reason: 'focus-lost' });
  assert.equal(log.length, 0);
});

test('stops before the password if focus moves away', async () => {
  let checks = 0;
  const { result, log } = await run({ isTarget: () => { checks += 1; return checks < 3; } });
  assert.equal(result.reason, 'focus-lost');
  assert.deepEqual(typed(log), ['first.last', 'TAB']);
});

test('waits for the hotkey to be released first', async () => {
  let held = 3;
  const { result, log } = await run({ modifiersHeld: () => { held -= 1; return held >= 0; } });
  assert.equal(result.ok, true);
  assert.equal(log.length, 3);
});

test('gives up without typing if keys stay held', async () => {
  const { result, log } = await run({ modifiersHeld: () => true });
  assert.deepEqual(result, { ok: false, reason: 'keys-held' });
  assert.equal(log.length, 0);
});

test('reports input blocked by Windows', async () => {
  const { result } = await run({ sendEvents: () => false });
  assert.deepEqual(result, { ok: false, reason: 'blocked' });
});

test('builds x64 keyboard INPUT records', () => {
  const buf = keyboardEvents(textEvents('ก'));
  assert.equal(buf.length, 80);
  assert.equal(buf.readUInt32LE(0), 1);
  assert.equal(buf.readUInt16LE(10), 0x0e01);
  assert.equal(buf.readUInt32LE(12), 4);
  assert.equal(buf.readUInt32LE(40 + 12), 6);
});

test('a hidden VPN light never reports a drop', () => {
  const dropped = { adapter: 'Fortinet SSL VPN', connected: false, dropped: true };
  assert.deepStrictEqual(statusView(dropped, true), { known: true, connected: false, dropped: true, light: true });
  assert.deepStrictEqual(statusView(dropped, false), { known: true, connected: false, dropped: false, light: false });
});
