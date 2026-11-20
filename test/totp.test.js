const test = require('node:test');
const assert = require('node:assert');
const { generateSecret, codeAt, verify, otpauthUrl, base32Encode, base32Decode, PERIOD } = require('../src/totp');

// RFC 6238 test vector: ASCII secret "12345678901234567890" = base32 below, SHA-1.
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));

test('base32 round-trips bytes', () => {
  const bytes = Buffer.from('12345678901234567890');
  assert.strictEqual(base32Decode(base32Encode(bytes)).toString(), bytes.toString());
});

test('matches the official RFC 6238 SHA-1 codes', () => {
  // From RFC 6238 Appendix B: Unix time -> expected 8-digit; take last 6.
  assert.strictEqual(codeAt(RFC_SECRET, 59 * 1000), '287082');
  assert.strictEqual(codeAt(RFC_SECRET, 1111111109 * 1000), '081804');
  assert.strictEqual(codeAt(RFC_SECRET, 1111111111 * 1000), '050471');
  assert.strictEqual(codeAt(RFC_SECRET, 1234567890 * 1000), '005924');
});

test('a fresh secret is valid base32 of the right size', () => {
  const s = generateSecret();
  assert.match(s, /^[A-Z2-7]{32}$/);
  assert.notStrictEqual(generateSecret(), s);
});

test('verify accepts the current code', () => {
  const now = 1700000000000;
  assert.strictEqual(verify(RFC_SECRET, codeAt(RFC_SECRET, now), now), true);
});

test('verify accepts one window of clock drift, rejects two', () => {
  const now = 1700000000000;
  assert.strictEqual(verify(RFC_SECRET, codeAt(RFC_SECRET, now - PERIOD * 1000), now), true);
  assert.strictEqual(verify(RFC_SECRET, codeAt(RFC_SECRET, now + PERIOD * 1000), now), true);
  assert.strictEqual(verify(RFC_SECRET, codeAt(RFC_SECRET, now - 2 * PERIOD * 1000), now), false);
});

test('verify rejects wrong, malformed, and empty codes', () => {
  const now = 1700000000000;
  assert.strictEqual(verify(RFC_SECRET, '000000', now), false);
  for (const bad of ['', '12345', '1234567', 'abcdef', null, undefined, ' 12 34 ']) {
    assert.strictEqual(verify(RFC_SECRET, bad, now), false);
  }
});

test('otpauth URL carries the secret and standard params', () => {
  const url = otpauthUrl('ABCDEF', 'me@host');
  assert.match(url, /^otpauth:\/\/totp\/Mochi%20Vault:me%40host\?/);
  assert.match(url, /secret=ABCDEF/);
  assert.match(url, /issuer=Mochi%20Vault/);
  assert.match(url, /algorithm=SHA1&digits=6&period=30/);
});
