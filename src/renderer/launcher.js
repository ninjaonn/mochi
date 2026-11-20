const api = window.launcher;
const query = document.getElementById('query');
const pin = document.getElementById('pin');
const results = document.getElementById('results');
const hint = document.getElementById('hint');
const DONE_MS = 300;
const COLORED_CHIPS = ['PROD', 'UAT', 'DEV'];

const view = { items: [], index: 0, seq: 0, waiting: null };

function say(text, kind = '') {
  hint.textContent = text;
  hint.className = 'launcher-hint ' + kind;
}

function hintFor(item) {
  if (!item) return '';
  if (item.kind === 'link') return 'Enter opens · Shift+Enter copies the link';
  return item.hasPassword ? 'Enter copies password · Shift+Enter copies username' : 'Enter copies username';
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function row(item, i) {
  const button = el('button', 'launcher-row' + (i === view.index ? ' selected' : ''));
  const text = el('div', 'launcher-text');
  text.append(el('div', 'launcher-title', item.title), el('div', 'launcher-sub', item.sub));
  button.append(el('span', 'launcher-icon', item.kind === 'link' ? '🔗' : '🔑'), text);
  for (const chip of item.chips) {
    button.append(el('span', 'chip' + (COLORED_CHIPS.includes(chip) ? ' ' + chip : ''), chip));
  }
  button.tabIndex = -1;
  button.addEventListener('mousedown', (ev) => ev.preventDefault()); // Keep focus in the search box.
  button.addEventListener('click', (ev) => run(item, ev.shiftKey));
  return button;
}

function render() {
  results.replaceChildren(...view.items.map(row));
  if (!view.items.length) results.append(el('div', 'launcher-empty', 'No matches'));
  say(hintFor(view.items[view.index]));
  const selected = results.querySelector('.selected');
  if (selected) selected.scrollIntoView({ block: 'nearest' });
}

async function refresh() {
  const seq = ++view.seq;
  const items = await api.search(query.value);
  if (seq !== view.seq) return; // A newer search has started.
  view.items = Array.isArray(items) ? items : [];
  view.index = 0;
  render();
}

function showSearch() {
  view.waiting = null;
  pin.value = '';
  pin.classList.add('hidden');
  query.classList.remove('hidden');
  query.focus();
}

function finish(text) {
  say(text, 'done');
  setTimeout(() => api.hide(), DONE_MS);
}

async function askPin(item, wantUsername) {
  const status = await api.lockStatus();
  if (!status.pinSet) { say('Open the widget and set your PIN first', 'error'); return; }
  view.waiting = { item, wantUsername };
  query.classList.add('hidden');
  pin.classList.remove('hidden');
  pin.focus();
  say('Mochi is locked');
}

async function copyKey(item, wantUsername) {
  const field = wantUsername || !item.hasPassword ? 'username' : 'password';
  if (field === 'username' && !item.username) { say('This key has no username', 'error'); return; }
  const r = await api.copy(item.id, field);
  if (r.needPin) { askPin(item, wantUsername); return; }
  if (!r.ok) { say(r.error, 'error'); return; }
  finish(field === 'password' ? `✓ Password copied · clears in ${r.clearsIn}s` : '✓ Username copied');
}

async function run(item, alternate) {
  if (item.kind === 'key') { await copyKey(item, alternate); return; }
  const r = alternate ? await api.copyLink(item.url) : await api.openLink(item.url);
  if (!r.ok) { say(r.error, 'error'); return; }
  finish(alternate ? '✓ Link copied' : '✓ Opening');
}

function move(step) {
  if (!view.items.length) return;
  view.index = (view.index + step + view.items.length) % view.items.length;
  render();
}

query.addEventListener('input', refresh);
query.addEventListener('keydown', (ev) => {
  if (ev.key === 'ArrowDown') { ev.preventDefault(); move(1); }
  if (ev.key === 'ArrowUp') { ev.preventDefault(); move(-1); }
  if (ev.key === 'Enter' && view.items[view.index]) run(view.items[view.index], ev.shiftKey);
});

pin.addEventListener('keydown', async (ev) => {
  if (ev.key !== 'Enter' || !view.waiting) return;
  const { item, wantUsername } = view.waiting;
  const r = await api.pin(pin.value);
  pin.value = '';
  if (!r.ok) { say(r.error, 'error'); return; }
  showSearch();
  copyKey(item, wantUsername);
});

document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape') return;
  if (view.waiting) { showSearch(); say(hintFor(view.items[view.index])); } else api.hide();
});

// Never leave a typed PIN behind when the launcher loses focus.
window.addEventListener('blur', showSearch);

api.onShow(() => {
  showSearch();
  query.value = '';
  refresh();
});
