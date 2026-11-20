// notes.md holds plain (non-secret) notes, project links and the daily log,
// so it can be edited by hand or by Claude Code. Layout:
//
//   # Notes
//   ## <note title>
//   <body>
//
//   # Links
//   ## <project>
//   - PROD: https://...
//
//   # Daily
//   ## 2026-11-05
//   - [ ] todo
//   - [x] done
const fs = require('fs');
const path = require('path');

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TODO_RE = /^\s*[-*] \[( |x|X)\] (.*)$/;
// "- Label: url" or "- url"
const LINK_RE = /^\s*[-*]\s+(?:(.+?):\s+)?([a-z][\w+.-]*:\/\/\S+|www\.\S+)\s*$/i;

function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parse(md) {
  const doc = { notes: [], links: [], days: [] };
  let section = 'notes';
  let current = null;

  for (const line of md.replace(/\r\n/g, '\n').split('\n')) {
    const h1 = line.match(/^# (.*)$/);
    if (h1) {
      section = /link/i.test(h1[1]) ? 'links' : /daily|todo|log/i.test(h1[1]) ? 'daily' : 'notes';
      current = null;
      continue;
    }
    const h2 = line.match(/^## (.*)$/);
    if (h2) {
      const title = h2[1].trim();
      if (section === 'daily' && DAY_RE.test(title)) {
        current = { date: title, items: [] };
        doc.days.push(current);
      } else if (section === 'links') {
        current = { project: title, items: [] };
        doc.links.push(current);
      } else {
        current = { title, body: '' };
        doc.notes.push(current);
      }
      continue;
    }
    if (!current) {
      if (!line.trim()) continue;
      // Text before the first heading becomes an untitled note / project.
      if (section === 'links') {
        current = { project: 'Other', items: [] };
        doc.links.push(current);
      } else {
        current = { title: 'Untitled', body: '' };
        doc.notes.push(current);
      }
    }
    if (current.project !== undefined) {
      const m = line.match(LINK_RE);
      if (m) current.items.push({ label: (m[1] || '').trim(), url: m[2] });
      else if (line.trim()) current.items.push({ raw: line });
    } else if (current.items) {
      const m = line.match(TODO_RE);
      if (m) current.items.push({ done: m[1] !== ' ', text: m[2] });
      else if (line.trim()) current.items.push({ raw: line });
    } else {
      current.body += (current.body ? '\n' : '') + line;
    }
  }
  for (const n of doc.notes) n.body = n.body.trim();
  doc.days.sort((a, b) => b.date.localeCompare(a.date));
  return doc;
}

function serialize(doc) {
  const out = ['# Notes', ''];
  for (const n of doc.notes) {
    out.push(`## ${n.title || 'Untitled'}`);
    if (n.body) out.push(n.body);
    out.push('');
  }
  out.push('# Links', '');
  for (const p of doc.links || []) {
    out.push(`## ${p.project || 'Untitled'}`);
    for (const it of p.items) out.push(it.raw !== undefined ? it.raw : `- ${it.label ? `${it.label}: ` : ''}${it.url}`);
    out.push('');
  }
  out.push('# Daily', '');
  for (const d of doc.days) {
    out.push(`## ${d.date}`);
    for (const it of d.items) out.push(it.raw !== undefined ? it.raw : `- [${it.done ? 'x' : ' '}] ${it.text}`);
    out.push('');
  }
  return out.join('\n');
}

// Start today's entry, moving unfinished todos forward from the last day.
function rollover(doc) {
  const date = today();
  if (doc.days.some((d) => d.date === date)) return false;
  const last = doc.days[0];
  const carried = last ? last.items.filter((i) => i.raw === undefined && !i.done) : [];
  if (last) last.items = last.items.filter((i) => !carried.includes(i));
  doc.days.unshift({ date, items: carried.map((i) => ({ done: false, text: i.text })) });
  return true;
}

class Notes {
  constructor(file, onExternalChange) {
    this.file = file;
    this.lastWritten = null;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) this.write({ notes: [], days: [] });
    this.doc = parse(fs.readFileSync(file, 'utf8'));
    if (rollover(this.doc)) this.write(this.doc);

    let timer = null;
    fs.watch(path.dirname(file), (_evt, name) => {
      if (name !== path.basename(file)) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        let text;
        try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
        if (text === this.lastWritten) return;
        this.doc = parse(text);
        onExternalChange(this.get());
      }, 300);
    });
  }

  get() {
    if (rollover(this.doc)) this.write(this.doc);
    return this.doc;
  }

  write(doc) {
    this.doc = doc;
    const text = serialize(doc);
    this.lastWritten = text;
    fs.writeFileSync(this.file, text, 'utf8');
  }
}

module.exports = { Notes, parse, serialize, rollover, today };
