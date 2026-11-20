// One-click Remote Desktop. The login is handed to Windows through the
// Credential API (never on a command line, where other programs could read it),
// lives only for this logon session, and is removed shortly after mstsc starts.
const { spawn } = require('child_process');

const CRED_TYPE_GENERIC = 1;
const CRED_PERSIST_SESSION = 1;
const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9.-]*(:\d{1,5})?$/;

let api = null;

function loadApi() {
  if (api) return api;
  const koffi = require('koffi');
  const advapi = koffi.load('advapi32.dll');
  koffi.struct('CREDENTIALW', {
    Flags: 'uint32_t',
    Type: 'uint32_t',
    TargetName: 'str16',
    Comment: 'str16',
    LastWrittenLow: 'uint32_t',
    LastWrittenHigh: 'uint32_t',
    CredentialBlobSize: 'uint32_t',
    CredentialBlob: 'void *',
    Persist: 'uint32_t',
    AttributeCount: 'uint32_t',
    Attributes: 'void *',
    TargetAlias: 'str16',
    UserName: 'str16',
  });
  api = {
    write: advapi.func('bool __stdcall CredWriteW(_In_ CREDENTIALW *cred, uint32_t flags)'),
    read: advapi.func('bool __stdcall CredReadW(const char16_t *target, uint32_t type, uint32_t flags, _Out_ void **cred)'),
    free: advapi.func('void __stdcall CredFree(void *cred)'),
    remove: advapi.func('bool __stdcall CredDeleteW(const char16_t *target, uint32_t type, uint32_t flags)'),
  };
  return api;
}

function splitHosts(text) {
  return text
    .split(/[,;\s]+/)
    .map((h) => h.replace(/^(?:rdp|https?):\/\//i, '').replace(/\/.*$/, ''))
    .filter(Boolean);
}

// "PROD 10.0.0.1, 10.0.0.2\nUAT\n10.0.1.1\t10.0.1.2" -> [{ label: 'PROD', hosts: [...] }, ...].
// A section starts with PROD/UAT/DEV/SIT or any "Label:", and runs until the next one.
function parseHostGroups(text) {
  const groups = [];
  let label = '';
  for (const line of String(text || '').split(/\r?\n/)) {
    const env = line.match(/^\s*(PROD|UAT|DEV|SIT)(?=[\s:]|$):?(.*)$/i);
    const named = env ? null : line.match(/^\s*([A-Za-z][\w -]*?)\s*:(?:\s+(.*))?$/);
    if (env) label = env[1].toUpperCase();
    else if (named) [, label] = named;
    const rest = env ? env[2] : named ? named[2] || '' : line;
    const hosts = splitHosts(rest);
    if (!hosts.length) continue;
    const group = groups.find((g) => g.label === label);
    if (group) group.hosts.push(...hosts.filter((h) => !group.hosts.includes(h)));
    else groups.push({ label, hosts: [...new Set(hosts)] });
  }
  return groups;
}

function parseHosts(text) {
  return parseHostGroups(text).flatMap((g) => g.hosts);
}

function isValidHost(host) {
  return HOST_RE.test(host);
}

function targetFor(host) {
  return `TERMSRV/${host.replace(/:\d+$/, '')}`;
}

function hasCredential(target) {
  const a = loadApi();
  const out = [null];
  if (!a.read(target, CRED_TYPE_GENERIC, 0, out)) return false;
  a.free(out[0]);
  return true;
}

function writeCredential(target, username, password) {
  const blob = Buffer.from(password, 'utf16le');
  const ok = loadApi().write({
    Flags: 0,
    Type: CRED_TYPE_GENERIC,
    TargetName: target,
    Comment: null,
    LastWrittenLow: 0,
    LastWrittenHigh: 0,
    CredentialBlobSize: blob.length,
    CredentialBlob: blob,
    Persist: CRED_PERSIST_SESSION,
    AttributeCount: 0,
    Attributes: null,
    TargetAlias: null,
    UserName: username,
  }, 0);
  blob.fill(0);
  return ok;
}

function deleteCredential(target) {
  return loadApi().remove(target, CRED_TYPE_GENERIC, 0);
}

function launch(host) {
  const child = spawn('mstsc.exe', [`/v:${host}`], { detached: true, stdio: 'ignore' });
  child.unref();
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('spawn', resolve);
  });
}

// Hands the login to Windows, starts mstsc, and copies the password in case
// a policy blocks saved logins and Windows asks for it anyway.
function createConnector({ ttlMs, login, copyPassword, start = launch }) {
  const cleanups = new Map(); // target -> timer, for logins Mochi put in Windows

  function forget(target) {
    clearTimeout(cleanups.get(target));
    cleanups.delete(target);
    deleteCredential(target);
  }

  async function connect(id, host) {
    const target = targetFor(host);
    const { username, password } = login(id);
    const ours = cleanups.has(target);
    // A login the user saved in Windows themselves is never replaced or deleted.
    const saved = !ours && hasCredential(target);
    const handed = Boolean(username) && !saved && writeCredential(target, username, password);
    if (handed) {
      clearTimeout(cleanups.get(target));
      cleanups.set(target, setTimeout(() => forget(target), ttlMs));
    }
    copyPassword(id);
    try {
      await start(host);
    } catch (err) {
      if (handed) forget(target);
      throw new Error(`Could not start Remote Desktop: ${err.message}`);
    }
    return { ok: true, host, mode: saved ? 'saved' : handed ? 'auto' : 'paste' };
  }

  return { connect, forgetAll: () => [...cleanups.keys()].forEach(forget) };
}

module.exports = { parseHosts, parseHostGroups, isValidHost, targetFor, hasCredential, writeCredential, deleteCredential, createConnector };
