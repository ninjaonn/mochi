// Unlock gate for copying/revealing secrets. Uses Windows Hello when the PC
// has it, otherwise an app PIN (stored only as a scrypt hash).
const crypto = require('crypto');
const fs = require('fs');
const { execFile } = require('child_process');
const totp = require('./totp');

const HELLO_PS = (call, resultType) => `
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
[void][Windows.Security.Credentials.UI.UserConsentVerifier,Windows.Security.Credentials.UI,ContentType=WindowsRuntime]
$op = [Windows.Security.Credentials.UI.UserConsentVerifier]::${call}
$t = $asTask.MakeGenericMethod([Windows.Security.Credentials.UI.${resultType}]).Invoke($null, @($op))
[void]$t.Wait(-1); $t.Result`;

function runPs(script) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true }, (err, stdout) => {
      resolve(err ? '' : stdout.trim());
    });
  });
}

function hashPin(pin, salt) {
  return crypto.scryptSync(pin, salt, 32).toString('base64');
}

class Lock {
  constructor(settings, onChange, totpStore) {
    this.settings = settings;
    this.onChange = onChange;
    this.totpStore = totpStore || null;
    this.pendingSecret = null;
    this.unlockedUntil = 0;
    this.failures = 0;
    this.blockedUntil = 0;
    this.helloAvailable = false;
    this.timer = null;
    if (process.platform === 'win32') {
      runPs(HELLO_PS('CheckAvailabilityAsync()', 'UserConsentVerifierAvailability'))
        .then((r) => { this.helloAvailable = r === 'Available'; this.onChange(); });
    }
  }

  status() {
    return {
      unlocked: Date.now() < this.unlockedUntil,
      until: this.unlockedUntil,
      method: this.helloAvailable ? 'hello' : 'pin',
      pinSet: Boolean(this.settings.get().pinHash),
      totpSet: this.totpEnabled(),
    };
  }

  isUnlocked() { return Date.now() < this.unlockedUntil; }

  grant() {
    const minutes = this.settings.get().unlockMinutes;
    this.unlockedUntil = Date.now() + minutes * 60000;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.lock(), minutes * 60000);
    this.onChange();
  }

  lock() {
    this.unlockedUntil = 0;
    clearTimeout(this.timer);
    this.onChange();
  }

  async unlockWithHello() {
    const r = await runPs(HELLO_PS('RequestVerificationAsync("Unlock Mochi Vault")', 'UserConsentVerificationResult'));
    if (r === 'Verified') { this.grant(); return { ok: true }; }
    return { ok: false, error: r || 'Windows Hello failed' };
  }

  setPin(pin) {
    if (this.settings.get().pinHash) return { ok: false, error: 'PIN already set' };
    if (!/^\d{4,12}$/.test(pin)) return { ok: false, error: 'PIN must be 4–12 digits' };
    const salt = crypto.randomBytes(16).toString('base64');
    this.settings.update({ pinSalt: salt, pinHash: hashPin(pin, salt) });
    this.grant();
    return { ok: true };
  }

  // Shared rate limit for PIN and TOTP: five tries, then a 30-second wait.
  blocked() {
    if (Date.now() < this.blockedUntil) {
      return { ok: false, error: `Too many tries. Wait ${Math.ceil((this.blockedUntil - Date.now()) / 1000)}s` };
    }
    return null;
  }

  countFailure() {
    this.failures += 1;
    if (this.failures >= 5) { this.blockedUntil = Date.now() + 30000; this.failures = 0; }
  }

  // ----- TOTP (authenticator app). An unlock gate only, like the PIN. -----
  totpEnabled() {
    return Boolean(this.totpStore && this.totpStore.exists());
  }

  // Step 1: make a secret and show its QR. Not active until confirmed.
  beginTotpSetup(label) {
    this.pendingSecret = totp.generateSecret();
    return { ok: true, secret: this.pendingSecret, url: totp.otpauthUrl(this.pendingSecret, label || 'vault') };
  }

  // Step 2: the user types a code from the app to prove the QR scanned.
  confirmTotpSetup(code) {
    if (!this.pendingSecret) return { ok: false, error: 'Start the setup again' };
    if (!totp.verify(this.pendingSecret, code)) return { ok: false, error: 'That code did not match. Check your phone clock and try again' };
    this.totpStore.write(this.pendingSecret);
    this.pendingSecret = null;
    this.onChange();
    return { ok: true };
  }

  // Removing it needs a current code, so a passer-by cannot just switch it off.
  disableTotp(code) {
    if (!this.totpEnabled()) return { ok: true };
    const b = this.blocked();
    if (b) return b;
    if (!totp.verify(this.totpStore.read(), code)) { this.countFailure(); return { ok: false, error: 'Wrong code' }; }
    this.totpStore.clear();
    this.failures = 0;
    this.onChange();
    return { ok: true };
  }

  unlockWithTotp(code) {
    if (!this.totpEnabled()) return { ok: false, error: 'Two-factor is not set up' };
    const b = this.blocked();
    if (b) return b;
    if (totp.verify(this.totpStore.read(), code)) { this.failures = 0; this.grant(); return { ok: true }; }
    this.countFailure();
    return { ok: false, error: 'Wrong code' };
  }

  unlockWithPin(pin) {
    const s = this.settings.get();
    const b = this.blocked();
    if (b) return b;
    const given = Buffer.from(hashPin(String(pin), s.pinSalt));
    const stored = Buffer.from(s.pinHash);
    if (given.length === stored.length && crypto.timingSafeEqual(given, stored)) {
      this.failures = 0;
      this.grant();
      return { ok: true };
    }
    this.countFailure();
    return { ok: false, error: 'Wrong PIN' };
  }
}

// Small DPAPI-encrypted store for the TOTP secret, kept out of settings.json
// (plaintext) and out of vault.enc.
class TotpStore {
  constructor(file, safe) { this.file = file; this.safe = safe; }
  exists() { return fs.existsSync(this.file); }
  read() { return this.safe.decryptString(fs.readFileSync(this.file)); }
  write(secret) {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, this.safe.encryptString(secret));
    fs.renameSync(tmp, this.file);
  }
  clear() { if (fs.existsSync(this.file)) fs.unlinkSync(this.file); }
}

module.exports = { Lock, TotpStore };
