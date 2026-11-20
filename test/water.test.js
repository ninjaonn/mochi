const test = require('node:test');
const assert = require('node:assert');
const { cleanMinutes, shouldNudge } = require('../src/water');

const MINUTE = 60000;
const base = { minutes: 45, lastSip: 0, lastNudge: 0, now: 45 * MINUTE, asleep: false };

test('minutes stay in a sensible range, and 0 or junk means off', () => {
  assert.strictEqual(cleanMinutes(45), 45);
  assert.strictEqual(cleanMinutes('60'), 60);
  assert.strictEqual(cleanMinutes(1), 5);
  assert.strictEqual(cleanMinutes(9999), 240);
  for (const off of [0, -5, '', 'abc', null, undefined]) assert.strictEqual(cleanMinutes(off), 0);
});

test('nudges once the time has passed, not before', () => {
  assert.strictEqual(shouldNudge({ ...base, now: 45 * MINUTE - 1 }), false);
  assert.strictEqual(shouldNudge(base), true);
});

test('never nudges when off or while away', () => {
  assert.strictEqual(shouldNudge({ ...base, minutes: 0 }), false);
  assert.strictEqual(shouldNudge({ ...base, asleep: true }), false);
});

test('repeats every 5 minutes until the sip', () => {
  const lastNudge = 45 * MINUTE;
  assert.strictEqual(shouldNudge({ ...base, lastNudge, now: lastNudge + 5 * MINUTE - 1 }), false);
  assert.strictEqual(shouldNudge({ ...base, lastNudge, now: lastNudge + 5 * MINUTE }), true);
});

test('a sip restarts the wait', () => {
  const sipped = 50 * MINUTE;
  assert.strictEqual(shouldNudge({ ...base, lastSip: sipped, now: sipped + 44 * MINUTE }), false);
});
