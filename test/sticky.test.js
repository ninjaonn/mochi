const test = require('node:test');
const assert = require('node:assert');
const { parseSdkRow, parsePlumText, classifyLine, looksLikePassword } = require('../src/sticky');

const kinds = (line) => classifyLine(line).map((i) => i.kind);

test('flags password-looking strings', () => {
  for (const s of ['aB3$xY9!qZ', 'fake,pa55word', 'Zz9xQ2mK', '@7FAKEpass', 'g=fakeValue9']) {
    assert.ok(looksLikePassword(s), s);
  }
});

test('leaves ordinary values alone', () => {
  const plain = ['TM_COUPON_NEW', 'sys_non_grey', 'SAMPLE-USER-VPN', 'Remark', 'first.last', '#a75b5b',
    '2026-11-05', '10.0.0.5:8080', 'https://example.com/a1', 'corp.local\\first.last', 'a.b@example.com', 'abc1'];
  for (const s of plain) assert.equal(looksLikePassword(s), false, s);
});

test('classifies lines', () => {
  assert.deepEqual(kinds('SAMPLE-USER-VPN (PROD,UAT,DEV)'), ['text']);
  assert.deepEqual(kinds('https://uat.example.com/api'), ['url']);
  assert.deepEqual(kinds('UAT: https://uat.example.com/api'), ['url']);
  assert.deepEqual(kinds('corp.local\\first.last'), ['user']);
  assert.deepEqual(kinds('Zz9xQ2mK!'), ['secret']);
  assert.deepEqual(kinds('   '), []);
  assert.deepEqual(kinds('กาญจน์ โนกลาง'), ['text']);
});

test('splits a username and password sharing one line', () => {
  assert.deepEqual(classifyLine('first.last Zz9xQ2mK'), [
    { text: 'first.last', kind: 'user' },
    { text: 'Zz9xQ2mK', kind: 'secret' },
  ]);
});

test('strips password and username labels', () => {
  assert.deepEqual(classifyLine('Password: Zz9xQ2mK'), [{ text: 'Zz9xQ2mK', kind: 'secret' }]);
  assert.deepEqual(classifyLine('pwd=plainword'), [{ text: 'plainword', kind: 'secret' }]);
  assert.deepEqual(classifyLine('รหัส Zz9xQ2mK'), [{ text: 'Zz9xQ2mK', kind: 'secret' }]);
  assert.deepEqual(classifyLine('Username: first.last'), [{ text: 'first.last', kind: 'user' }]);
});

test('keeps headings that merely start with a label', () => {
  assert.deepEqual(classifyLine('Password Remark'), [{ text: 'Password Remark', kind: 'text' }]);
  assert.deepEqual(kinds('Password'), ['text']);
  assert.deepEqual(kinds('Username Password'), ['text']);
});

test('parses a OneNote row with doubled quotes', () => {
  const note = {
    id: 'n1',
    deleted: false,
    createdAt: 1,
    documentModifiedAt: 2,
    media: [],
    document: { content: [{ content: { text: 'say "hi"' } }, { content: { text: 'line 2' } }] },
    metadata: { context: { host: 'Line' } },
  };
  const n = parseSdkRow(JSON.stringify(note).replace(/"/g, '""'));
  assert.deepEqual(n.lines, ['say "hi"', 'line 2']);
  assert.equal(n.from, 'Line');
  assert.equal(n.hasPicture, false);
});

test('skips deleted notes and teaching cards', () => {
  const base = { id: 'n', media: [], document: { content: [] } };
  assert.equal(parseSdkRow(JSON.stringify({ ...base, deleted: true }).replace(/"/g, '""')), null);
  assert.equal(parseSdkRow(JSON.stringify({ ...base, metadata: { isTeachingCard: true } }).replace(/"/g, '""')), null);
});

test('strips classic line ids', () => {
  assert.deepEqual(parsePlumText('\\id=1a2b-3c first\n\\id=4d5e-6f second'), ['first', 'second']);
});
