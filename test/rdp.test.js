const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const { parseHosts, parseHostGroups, isValidHost, targetFor, hasCredential, writeCredential, deleteCredential, createConnector } = require('../src/rdp');

test('parses host lists', () => {
  assert.deepEqual(parseHosts('srv-a, srv-b;srv-c\nsrv-d'), ['srv-a', 'srv-b', 'srv-c', 'srv-d']);
  assert.deepEqual(parseHosts('https://srv.example.com/path'), ['srv.example.com']);
  assert.deepEqual(parseHosts(''), []);
  assert.deepEqual(parseHosts(undefined), []);
});

test('reads sections pasted from a spreadsheet', () => {
  const pasted = 'PROD 10.0.1.1,10.0.1.2,10.0.1.3\t10.0.1.4\n\nUAT\n10.0.2.1\t10.0.2.2\t\t10.0.2.3\n\nDev\n10.0.3.1\t\n';
  assert.deepEqual(parseHostGroups(pasted), [
    { label: 'PROD', hosts: ['10.0.1.1', '10.0.1.2', '10.0.1.3', '10.0.1.4'] },
    { label: 'UAT', hosts: ['10.0.2.1', '10.0.2.2', '10.0.2.3'] },
    { label: 'DEV', hosts: ['10.0.3.1'] },
  ]);
  assert.equal(parseHosts(pasted).length, 8);
});

test('supports custom labels, colons and repeated sections', () => {
  assert.deepEqual(parseHostGroups('PROD: a1\nDatabase: b1, b2\nprod: a2, a1'), [
    { label: 'PROD', hosts: ['a1', 'a2'] },
    { label: 'Database', hosts: ['b1', 'b2'] },
  ]);
});

test('does not mistake server names for sections', () => {
  assert.deepEqual(parseHostGroups('dev-app-01, prod.example.com\nsrv.example.com:3390'), [
    { label: '', hosts: ['dev-app-01', 'prod.example.com', 'srv.example.com:3390'] },
  ]);
  assert.deepEqual(parseHosts('https://srv.example.com/path'), ['srv.example.com']);
});

test('rejects hosts that could act as mstsc switches', () => {
  for (const h of ['srv-a', '10.0.0.5', 'srv.example.com:3390']) assert.ok(isValidHost(h), h);
  for (const h of ['/admin', '-x', 'a b', 'a"b', 'srv:port', '']) assert.equal(isValidHost(h), false, h);
});

test('credential target ignores the port', () => {
  assert.equal(targetFor('srv.example.com:3390'), 'TERMSRV/srv.example.com');
});

test('writes, finds and deletes a session credential', { skip: process.platform !== 'win32' }, () => {
  const target = 'TERMSRV/mochi-vault-selftest.invalid';
  deleteCredential(target);
  assert.equal(hasCredential(target), false);
  assert.equal(writeCredential(target, 'corp\\fake.user', 'Fake-Passw0rd-รหัส'), true);
  assert.equal(hasCredential(target), true);
  const listed = execFileSync('cmdkey.exe', ['/list:' + target], { encoding: 'utf8' });
  assert.match(listed, /corp\\fake\.user/);
  assert.equal(deleteCredential(target), true);
  assert.equal(hasCredential(target), false);
});

const windowsOnly = { skip: process.platform !== 'win32' };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function connector(overrides = {}) {
  const calls = { copied: 0, started: [] };
  const c = createConnector({
    ttlMs: 150,
    login: () => ({ username: 'corp\\fake.user', password: 'Fake-Passw0rd' }),
    copyPassword: () => { calls.copied += 1; },
    start: async (host) => { calls.started.push(host); },
    ...overrides,
  });
  return { c, calls };
}

test('hands over the login, then removes it', windowsOnly, async () => {
  const host = 'mochi-a.invalid';
  const { c, calls } = connector();
  const r = await c.connect('id', host);
  assert.equal(r.mode, 'auto');
  assert.equal(hasCredential(targetFor(host)), true);
  assert.deepEqual(calls, { copied: 1, started: [host] });
  await wait(300);
  assert.equal(hasCredential(targetFor(host)), false);
});

test('never replaces or deletes a login the user saved', windowsOnly, async () => {
  const host = 'mochi-b.invalid';
  const target = targetFor(host);
  writeCredential(target, 'corp\\own.login', 'Users-Own-Passw0rd');
  try {
    const { c, calls } = connector();
    const r = await c.connect('id', host);
    assert.equal(r.mode, 'saved');
    assert.equal(calls.copied, 1);
    await wait(300);
    c.forgetAll();
    assert.equal(hasCredential(target), true);
    const listed = execFileSync('cmdkey.exe', [`/list:${target}`], { encoding: 'utf8' });
    assert.match(listed, /corp\\own\.login/);
  } finally {
    deleteCredential(target);
  }
});

test('reconnecting keeps the login alive until the new timer ends', windowsOnly, async () => {
  const host = 'mochi-c.invalid';
  const { c } = connector();
  await c.connect('id', host);
  await wait(100);
  assert.equal((await c.connect('id', host)).mode, 'auto');
  await wait(100);
  assert.equal(hasCredential(targetFor(host)), true);
  await wait(200);
  assert.equal(hasCredential(targetFor(host)), false);
});

test('removes the login at once if Remote Desktop cannot start', windowsOnly, async () => {
  const host = 'mochi-d.invalid';
  const { c } = connector({ start: async () => { throw new Error('nope'); } });
  await assert.rejects(c.connect('id', host), /Could not start Remote Desktop/);
  assert.equal(hasCredential(targetFor(host)), false);
});

test('without a username it only copies the password', windowsOnly, async () => {
  const host = 'mochi-e.invalid';
  const { c, calls } = connector({ login: () => ({ username: '', password: 'Fake-Passw0rd' }) });
  assert.equal((await c.connect('id', host)).mode, 'paste');
  assert.equal(hasCredential(targetFor(host)), false);
  assert.equal(calls.copied, 1);
});

test('forgetAll clears pending logins on quit', windowsOnly, async () => {
  const host = 'mochi-f.invalid';
  const { c } = connector({ ttlMs: 60000 });
  await c.connect('id', host);
  c.forgetAll();
  assert.equal(hasCredential(targetFor(host)), false);
});
