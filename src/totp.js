// TOTP (RFC 6238) compatible with Google Authenticator: SHA-1, 6 digits, 30s.
// This is an unlock gate only, like the PIN. It never encrypts the vault:
// a one-time code cannot be an encryption key, and the shared secret has to
// sit on this PC to be verified, so it does not protect against malware.
const crypto = require('crypto');

const DIGITS = 6;
const PERIOD = 30;
const ISSUER = 'Mochi Vault';
// Allow the previous and next window too, for small clock drift on the phone.
const DRIFT_WINDOWS = 1;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

// RFC 4648 base32, no padding. Google Authenticator wants A–Z, 2–7.
function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(text) {
  const clean = String(text).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const ch of clean) {
    value = (value << 5) | BASE32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

// The RFC 6238 / HOTP code for one time step.
function codeForCounter(secretBase32, counter) {
  const key = base32Decode(secretBase32);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

function codeAt(secretBase32, timeMs = Date.now()) {
  return codeForCounter(secretBase32, Math.floor(timeMs / 1000 / PERIOD));
}

// True if the code matches this window or an adjacent one (clock drift).
// Compared length-first, then timing-safe, so no early-exit leak.
function verify(secretBase32, code, timeMs = Date.now()) {
  const given = String(code ?? '').trim();
  if (!/^\d{6}$/.test(given)) return false;
  const counter = Math.floor(timeMs / 1000 / PERIOD);
  const a = Buffer.from(given);
  for (let w = -DRIFT_WINDOWS; w <= DRIFT_WINDOWS; w++) {
    const b = Buffer.from(codeForCounter(secretBase32, counter + w));
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }
  return false;
}

// otpauth:// URI for the QR code. label is what shows in the authenticator app.
function otpauthUrl(secretBase32, label = 'vault') {
  const name = encodeURIComponent(label);
  const issuer = encodeURIComponent(ISSUER);
  return `otpauth://totp/${issuer}:${name}?secret=${secretBase32}&issuer=${issuer}&algorithm=SHA1&digits=${DIGITS}&period=${PERIOD}`;
}

module.exports = { generateSecret, codeAt, verify, otpauthUrl, base32Encode, base32Decode, DIGITS, PERIOD };
