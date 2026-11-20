// Read-only import from Windows Sticky Notes. Two stores exist:
//   OneNote-based: %LOCALAPPDATA%\Microsoft\OneNote\16.0\Memory\notes.sdk_*.db
//   Classic app:   %LOCALAPPDATA%\Packages\Microsoft.MicrosoftStickyNotes_*\LocalState\plum.sqlite
// Uses Windows' own winsqlite3.dll, which also reads the -wal file holding the
// newest edits. Nothing is ever written back: those notes sync to Microsoft,
// so deleting them is left to the Sticky Notes app.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SQLITE_OPEN_READONLY = 1;
const SQLITE_ROW = 100;

let sqlite = null;

function loadSqlite() {
  if (sqlite) return sqlite;
  const koffi = require('koffi');
  const lib = koffi.load('winsqlite3.dll');
  sqlite = {
    open: lib.func('int __stdcall sqlite3_open_v2(const char *file, _Out_ void **db, int flags, const char *vfs)'),
    prepare: lib.func('int __stdcall sqlite3_prepare_v2(void *db, const char *sql, int bytes, _Out_ void **stmt, void *tail)'),
    step: lib.func('int __stdcall sqlite3_step(void *stmt)'),
    text: lib.func('const char * __stdcall sqlite3_column_text(void *stmt, int col)'),
    int64: lib.func('int64_t __stdcall sqlite3_column_int64(void *stmt, int col)'),
    finalize: lib.func('int __stdcall sqlite3_finalize(void *stmt)'),
    close: lib.func('int __stdcall sqlite3_close_v2(void *db)'),
  };
  return sqlite;
}

// Returns each row as an array, reading columns with the given readers ('text' | 'int64').
function query(file, sql, columns) {
  const s = loadSqlite();
  const dbOut = [null];
  const rows = [];
  if (s.open(file, dbOut, SQLITE_OPEN_READONLY, null) !== 0) {
    if (dbOut[0]) s.close(dbOut[0]);
    throw new Error(`Could not open ${path.basename(file)}`);
  }
  const db = dbOut[0];
  try {
    const stmtOut = [null];
    if (s.prepare(db, sql, -1, stmtOut, null) !== 0) throw new Error(`Unexpected layout in ${path.basename(file)}`);
    const stmt = stmtOut[0];
    try {
      while (s.step(stmt) === SQLITE_ROW) rows.push(columns.map((kind, i) => s[kind](stmt, i)));
    } finally {
      s.finalize(stmt);
    }
  } finally {
    s.close(db);
  }
  return rows;
}

// The OneNote store doubles every quote, like CSV escaping.
function parseSdkRow(value) {
  const n = JSON.parse(value.replace(/""/g, '"'));
  if (n.deleted || (n.metadata && n.metadata.isTeachingCard)) return null;
  const blocks = (n.document && n.document.content) || [];
  const lines = blocks.map((b) => (b.content && b.content.text) || '');
  const context = (n.metadata && n.metadata.context) || {};
  return {
    id: n.id,
    source: 'Sticky Notes',
    from: context.host && context.host !== 'StickyNotes' ? context.host : '',
    modifiedAt: n.documentModifiedAt || n.createdAt || 0,
    hasPicture: Array.isArray(n.media) && n.media.length > 0,
    lines,
  };
}

// Classic notes store each line as "\id=<guid> text".
function parsePlumText(text) {
  return String(text || '').replace(/\r\n/g, '\n').split('\n').map((l) => l.replace(/^\\id=[0-9a-fA-F-]+ ?/, ''));
}

const URL_RE = /^(https?:\/\/|www\.)\S+$/i;
const DOMAIN_USER_RE = /^[\w.-]+\\[\w.-]+$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const COLOR_RE = /^#[0-9a-f]{3,8}$/i;
const IP_RE = /^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/;
const PASS_LABEL_RE = /^(?:pass(?:word)?|pwd|รหัส(?:ผ่าน)?)\s*([:=]?)\s*(\S+)$/i;
const USER_LABEL_RE = /^(?:user(?:name)?|login|ชื่อผู้ใช้)\s*[:=]\s*(\S+)$/i;

// Errs toward "secret": wrongly masking a word is harmless,
// wrongly showing a password or saving it to notes.md is not.
function looksLikePassword(token) {
  if (token.length < 6 || token.length > 64 || /\s/.test(token)) return false;
  if (URL_RE.test(token) || DOMAIN_USER_RE.test(token) || EMAIL_RE.test(token) || COLOR_RE.test(token) || IP_RE.test(token)) return false;
  if (/[^\x21-\x7e]/.test(token)) return false;
  if (/^[\d\s./:-]+$/.test(token)) return false; // dates, versions, phone numbers
  if (/^\(.*\)$|^\[.*\]$/.test(token)) return false; // "(PROD,UAT,DEV)" in a title
  const hasDigit = /\d/.test(token);
  const hasSymbol = /[^A-Za-z0-9._-]/.test(token);
  return hasDigit || hasSymbol;
}

// One note line -> one or more items: { text, kind: secret | url | user | text }.
function classifyLine(raw) {
  const line = raw.trim();
  if (!line) return [];
  const pass = line.match(PASS_LABEL_RE);
  // Without ":" or "=", "Password Remark" is a heading, not a value.
  if (pass && (pass[1] || looksLikePassword(pass[2]))) return [{ text: pass[2], kind: 'secret' }];
  const user = line.match(USER_LABEL_RE);
  if (user) return [{ text: user[1], kind: 'user' }];
  if (/(https?:\/\/|www\.)\S+/i.test(line)) return [{ text: line, kind: 'url' }];
  if (DOMAIN_USER_RE.test(line) || EMAIL_RE.test(line)) return [{ text: line, kind: 'user' }];
  if (looksLikePassword(line)) return [{ text: line, kind: 'secret' }];

  // "someone.name s3cretValue" holds a username and a password on one line.
  const tokens = line.split(/\s+/);
  if (tokens.length >= 2 && tokens.length <= 3 && tokens.some(looksLikePassword)) {
    return tokens.map((t) => ({ text: t, kind: looksLikePassword(t) ? 'secret' : 'user' }));
  }
  return [{ text: line, kind: 'text' }];
}

function toNote(raw) {
  const items = raw.lines.flatMap(classifyLine);
  return items.length || raw.hasPicture ? { ...raw, lines: undefined, items } : null;
}

function fingerprint(items) {
  return crypto.createHash('sha256').update(items.map((i) => i.text).join('\n')).digest('hex');
}

function sdkFiles(localAppData) {
  const dir = path.join(localAppData, 'Microsoft', 'OneNote', '16.0', 'Memory');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /^notes\.sdk_.*\.db$/.test(f)).map((f) => path.join(dir, f));
}

function plumFiles(localAppData) {
  const dir = path.join(localAppData, 'Packages');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.startsWith('Microsoft.MicrosoftStickyNotes_'))
    .map((f) => path.join(dir, f, 'LocalState', 'plum.sqlite'))
    .filter((f) => fs.existsSync(f));
}

// Newest first, with identical notes from the two stores merged.
function readStickyNotes(localAppData = process.env.LOCALAPPDATA) {
  const raws = [];
  const errors = [];
  for (const file of sdkFiles(localAppData)) {
    try {
      for (const [value] of query(file, 'select value from notes', ['text'])) {
        const n = parseSdkRow(value);
        if (n) raws.push(n);
      }
    } catch (err) {
      errors.push(err.message);
    }
  }
  for (const file of plumFiles(localAppData)) {
    try {
      const sql = 'select Id, Text, UpdatedAt from Note where DeletedAt is null or DeletedAt = 0';
      for (const [id, text, updatedAt] of query(file, sql, ['text', 'text', 'int64'])) {
        // UpdatedAt is in .NET ticks (100 ns since year 1).
        const modifiedAt = Number(BigInt(updatedAt) / 10000n) - 62135596800000;
        raws.push({ id, source: 'Old Sticky Notes', from: '', modifiedAt, hasPicture: false, lines: parsePlumText(text) });
      }
    } catch (err) {
      errors.push(err.message);
    }
  }

  const seen = new Set();
  const notes = [];
  for (const n of raws.map(toNote).filter(Boolean)) {
    const key = fingerprint(n.items);
    if (seen.has(key)) continue;
    seen.add(key);
    notes.push(n);
  }
  notes.sort((a, b) => b.modifiedAt - a.modifiedAt);
  return { notes, errors };
}

module.exports = { readStickyNotes, parseSdkRow, parsePlumText, classifyLine, looksLikePassword };
