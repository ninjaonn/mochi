const test = require('node:test');
const assert = require('node:assert');
const { DEFAULT_NAME, MAX_LENGTH, cleanName } = require('../src/appname');

test('keeps a normal name, including emoji and Thai', () => {
  assert.strictEqual(cleanName('  🐶 ตู้เซฟ  '), '🐶 ตู้เซฟ');
});

test('blank goes back to the default', () => {
  for (const blank of ['', '   ', null, undefined]) assert.strictEqual(cleanName(blank), DEFAULT_NAME);
});

test('long names are cut without breaking an emoji', () => {
  const name = cleanName('🐶'.repeat(MAX_LENGTH + 5));
  assert.strictEqual([...name].length, MAX_LENGTH);
  assert.ok(name.endsWith('🐶'));
});

test('line breaks and control characters are removed', () => {
  assert.strictEqual(cleanName('My\nVault\u0007'), 'My Vault');
});
