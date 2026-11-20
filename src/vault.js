// Encrypted credential store. The whole vault is one JSON document encrypted
// with Electron safeStorage (DPAPI on Windows: tied to this Windows user).
// Secrets never leave the main process except through copy/reveal.
const fs = require('fs');
const crypto = require('crypto');

const TRASH_DAYS = 30;
const SECRET_FIELDS = new Set(['password', 'prevPassword']);

class Vault {
  constructor(file, safeStorage) {
    this.file = file;
    this.safe = safeStorage;
    this.data = { entries: [] };
    this.load();
  }

  load() {
    if (!fs.existsSync(this.file)) return;
    const json = this.safe.decryptString(fs.readFileSync(this.file));
    this.data = JSON.parse(json);
    this.purgeExpired();
  }

  persist() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, this.safe.encryptString(JSON.stringify(this.data)));
    fs.renameSync(tmp, this.file);
  }

  find(id) {
    const entry = this.data.entries.find((e) => e.id === id);
    if (!entry) throw new Error('Entry not found');
    return entry;
  }

  // Safe view for the renderer: secret values replaced by flags.
  list() {
    return this.data.entries
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((e) => ({
        id: e.id,
        title: e.title,
        group: e.group,
        envs: e.envs,
        username: e.username,
        host: e.host,
        remark: e.remark,
        fav: e.fav,
        rdp: e.rdp,
        vpn: e.vpn,
        hasCommand: Boolean(e.command && e.command.trim()),
        deletedAt: e.deletedAt,
        updatedAt: e.updatedAt,
        hasPassword: Boolean(e.password),
        hasPrev: Boolean(e.prevPassword),
        extras: e.extras.map((x) => ({ name: x.name, secret: x.secret, value: x.secret ? '' : x.value })),
      }));
  }

  save(input) {
    const now = Date.now();
    const extrasIn = Array.isArray(input.extras) ? input.extras : [];
    if (!input.title || !input.title.trim()) throw new Error('Title is required');

    let entry = input.id ? this.find(input.id) : null;
    if (!entry) {
      // A key usually holds a password, but one that only runs a command or
      // opens a server/link does not need one.
      const hasContent = input.password || (input.command && input.command.trim()) || (input.host && input.host.trim());
      if (!hasContent) throw new Error('Add a password, a command, or a server/host');
      entry = {
        id: crypto.randomUUID(),
        order: this.data.entries.length ? Math.max(...this.data.entries.map((e) => e.order)) + 1 : 0,
        fav: false,
        deletedAt: null,
        password: '',
        prevPassword: '',
        extras: [],
      };
      this.data.entries.push(entry);
    }

    entry.title = input.title.trim();
    entry.group = (input.group || 'Other').trim() || 'Other';
    entry.envs = (input.envs || []).map((s) => s.trim()).filter(Boolean);
    entry.username = (input.username || '').trim();
    entry.host = (input.host || '').trim();
    entry.remark = input.remark || '';
    entry.rdp = Boolean(input.rdp);
    entry.command = typeof input.command === 'string' ? input.command : (entry.command || '');
    entry.vpn = Boolean(input.vpn);
    // Auto-type uses a single login, so ticking one key unticks the others.
    if (entry.vpn) this.data.entries.forEach((o) => { if (o !== entry) o.vpn = false; });
    if (input.password && input.password !== entry.password) {
      entry.prevPassword = entry.password;
      entry.password = input.password;
    }
    // Secret extras sent back blank mean "unchanged".
    entry.extras = extrasIn
      .filter((x) => x.name && x.name.trim())
      .map((x) => {
        const old = entry.extras.find((o) => o.name === x.name && o.secret);
        const value = x.secret && !x.value && old ? old.value : x.value || '';
        return { name: x.name.trim(), secret: Boolean(x.secret), value };
      });
    entry.updatedAt = now;
    this.persist();
    return entry.id;
  }

  secret(id, field) {
    const e = this.find(id);
    if (field === 'command') return e.command || '';
    if (SECRET_FIELDS.has(field)) return e[field];
    if (field.startsWith('extra:')) {
      const x = e.extras[Number(field.slice(6))];
      if (x) return x.value;
    }
    if (field === 'username' || field === 'host') return e[field];
    throw new Error('Unknown field');
  }

  isSecretField(id, field) {
    if (SECRET_FIELDS.has(field)) return true;
    if (field.startsWith('extra:')) {
      const x = this.find(id).extras[Number(field.slice(6))];
      return Boolean(x && x.secret);
    }
    return false;
  }

  vpnEntryId() {
    const entry = this.data.entries.find((e) => e.vpn && !e.deletedAt);
    return entry ? entry.id : null;
  }

  toggleFav(id) {
    const e = this.find(id);
    e.fav = !e.fav;
    this.persist();
  }

  reorder(ids) {
    ids.forEach((id, i) => { this.find(id).order = i; });
    this.persist();
  }

  trash(id) { this.find(id).deletedAt = Date.now(); this.persist(); }
  restore(id) { this.find(id).deletedAt = null; this.persist(); }

  purge(id) {
    this.data.entries = this.data.entries.filter((e) => e.id !== id);
    this.persist();
  }

  purgeExpired() {
    const cutoff = Date.now() - TRASH_DAYS * 86400000;
    const before = this.data.entries.length;
    this.data.entries = this.data.entries.filter((e) => !e.deletedAt || e.deletedAt > cutoff);
    if (this.data.entries.length !== before) this.persist();
  }

  // Portable backup protected by a master password (scrypt + AES-256-GCM),
  // so it survives this PC dying, unlike DPAPI.
  exportTo(file, master) {
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const key = crypto.scryptSync(master, salt, 32, { N: 1 << 15, maxmem: 64 * 1024 * 1024 });
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(this.data), 'utf8'), cipher.final()]);
    const out = { v: 1, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: body.toString('base64') };
    fs.writeFileSync(file, JSON.stringify(out));
  }

  importFrom(file, master) {
    const box = JSON.parse(fs.readFileSync(file, 'utf8'));
    const key = crypto.scryptSync(master, Buffer.from(box.salt, 'base64'), 32, { N: 1 << 15, maxmem: 64 * 1024 * 1024 });
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
    let json;
    try {
      json = Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()]).toString('utf8');
    } catch {
      throw new Error('Wrong master password or damaged file');
    }
    const incoming = JSON.parse(json).entries || [];
    for (const e of incoming) {
      const i = this.data.entries.findIndex((x) => x.id === e.id);
      if (i >= 0) this.data.entries[i] = e; else this.data.entries.push(e);
    }
    this.persist();
    return incoming.length;
  }
}

module.exports = { Vault };
