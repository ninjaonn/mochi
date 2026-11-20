const test = require('node:test');
const assert = require('node:assert');
const { loginItem, isOn } = require('../src/autostart');

const item = loginItem({ execPath: 'C:/app/electron.exe', appPath: 'C:/app/mochi', packaged: false });
const entry = { name: 'Mochi Vault', path: 'C:/app/electron.exe', args: ['C:/app/mochi'], scope: 'user', enabled: true };

test('running from source starts electron with the app folder', () => {
  assert.deepStrictEqual(item, { name: 'Mochi Vault', path: 'C:/app/electron.exe', args: ['C:/app/mochi'] });
});

test('an installed build starts on its own', () => {
  const installed = loginItem({ execPath: 'C:/app/Mochi Vault.exe', appPath: 'C:/app/resources/app.asar', packaged: true });
  assert.deepStrictEqual(installed.args, []);
});

test('on only when the matching entry is enabled', () => {
  assert.strictEqual(isOn({ launchItems: [entry] }, item), true);
  assert.strictEqual(isOn({ launchItems: [] }, item), false);
  assert.strictEqual(isOn({ launchItems: [{ ...entry, name: 'Notion' }] }, item), false);
  assert.strictEqual(isOn({ launchItems: [{ ...entry, enabled: false }] }, item), false);
});

test('an entry from an old folder counts as off', () => {
  assert.strictEqual(isOn({ launchItems: [{ ...entry, args: ['C:/old/mochi'] }] }, item), false);
});
