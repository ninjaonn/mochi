const test = require('node:test');
const assert = require('node:assert');
const { bubblePosition } = require('../src/bubble');
const { cleanMessage, DEFAULT_MESSAGE, MAX_MESSAGE } = require('../src/water');

const area = { x: 0, y: 0, width: 1000, height: 800 };
const size = { width: 200, height: 60 };
const mascot = (x, y) => ({ x, y, width: 84, height: 84 });

test('sits above the mascot, centered, with the tail in the middle', () => {
  assert.deepStrictEqual(bubblePosition(mascot(400, 400), size, area), { x: 342, y: 344, side: 'above', tailX: 100 });
});

test('goes below when there is no room above', () => {
  const p = bubblePosition(mascot(400, 10), size, area);
  assert.strictEqual(p.side, 'below');
  assert.strictEqual(p.y, 90);
});

test('stays on screen near the edges, and the tail still points at the mascot', () => {
  const left = bubblePosition(mascot(0, 400), size, area);
  assert.strictEqual(left.x, 0);
  assert.strictEqual(left.tailX, 42);
  const right = bubblePosition(mascot(916, 400), size, area);
  assert.strictEqual(right.x, 800);
  assert.strictEqual(right.tailX, 158);
});

test('works on a screen to the left of the main one', () => {
  const second = { x: -1000, y: 0, width: 1000, height: 800 };
  assert.strictEqual(bubblePosition(mascot(-1000, 400), size, second).x, -1000);
});

test('the tail never leaves the bubble', () => {
  assert.strictEqual(bubblePosition(mascot(-30, 400), size, area).tailX, 16);
});

test('the message keeps Thai and emoji, and blank goes back to the default', () => {
  assert.strictEqual(DEFAULT_MESSAGE, 'จิบน้ำหน่อยงับ');
  assert.strictEqual(cleanMessage('  ดื่มน้ำ 🐶 '), 'ดื่มน้ำ 🐶');
  for (const blank of ['', '   ', null, undefined]) assert.strictEqual(cleanMessage(blank), DEFAULT_MESSAGE);
});

test('long messages are cut and line breaks removed', () => {
  assert.strictEqual([...cleanMessage('🐶'.repeat(MAX_MESSAGE + 9))].length, MAX_MESSAGE);
  assert.strictEqual(cleanMessage('sip\nnow'), 'sip now');
});
