const api = window.mochi;
const $ = (sel) => document.querySelector(sel);

const state = {
  linkStatus: {},
  vpnKey: '',
  tab: 'keys',
  entries: [],
  query: '',
  showTrash: false,
  collapsed: new Set(),
  revealed: new Map(), // "id:field" -> value, auto-hidden after 10s
  showPrev: new Set(),
  lock: { unlocked: false, method: 'pin', pinSet: false },
  doc: { notes: [], days: [] },
  yesterdayOpen: true,
  linkQuery: '',
  linkEnv: 'All',
  pendingNotesRender: false,
};

const TAG_COLORS = 6;
const TAG_MAX_LENGTH = 24;
const BOUNCE_MS = 800;
const WATER_CHOICES = [0, 30, 45, 60, 90];
const WATER_TITLE = 'Time for a sip! Click when done';
const REVEAL_MS = 10000;

// ---------- tiny DOM helper (textContent only, never innerHTML) ----------
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : String(kid));
  }
  return el;
}

// ---------- toast ----------
let toastTimer;
const widgetOpen = () => !$('#app').classList.contains('hidden');

function hideToast() {
  clearTimeout(toastTimer);
  $('#toast').classList.add('hidden');
}

// The shrunk mascot's window only fits the mascot, so it says it in a bubble.
function toast(msg, undo) {
  if (!widgetOpen()) { api.win.say(msg); return; }
  const t = $('#toast');
  t.replaceChildren(h('span', null, msg));
  if (undo) {
    t.append(h('button', { onclick: () => { t.classList.add('hidden'); undo(); } }, 'Undo'));
  }
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), undo ? 5000 : 2500);
}

// ---------- modal ----------
function openModal(...content) {
  $('#sheet').replaceChildren(...content.flat().filter((c) => c != null && c !== false));
  $('#modal').classList.remove('hidden');
  const first = $('#sheet').querySelector('input, textarea');
  if (first) first.focus();
}
function closeModal() {
  $('#modal').classList.add('hidden');
  $('#sheet').replaceChildren();
}

function askPin() {
  return new Promise((resolve) => {
    const creating = !state.lock.pinSet;
    const totpOn = state.lock.totpSet;
    const pin = h('input', { class: 'field', type: 'password', inputmode: 'numeric', autocomplete: 'off',
      placeholder: creating ? '4–12 digits' : (totpOn ? 'PIN, or 6-digit app code' : '4–12 digits') });
    const pin2 = creating ? h('input', { class: 'field', type: 'password', inputmode: 'numeric', autocomplete: 'off', placeholder: 'Repeat PIN' }) : null;
    const err = h('div', { class: 'error' });
    const submit = async () => {
      if (creating && pin.value !== pin2.value) { err.textContent = 'PINs do not match'; return; }
      // When two-factor is on, a 6-digit entry is tried as an app code first.
      let r;
      if (!creating && totpOn && /^\d{6}$/.test(pin.value.trim())) {
        r = await api.lock.totp(pin.value.trim());
        if (!r.ok) r = await api.lock.pin(pin.value);
      } else {
        r = await api.lock.pin(pin.value);
      }
      if (r.ok) { closeModal(); resolve(true); } else { err.textContent = r.error; pin.select(); }
    };
    const onKey = (e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') { closeModal(); resolve(false); } };
    pin.addEventListener('keydown', onKey);
    if (pin2) pin2.addEventListener('keydown', onKey);
    openModal(
      h('h3', null, creating ? '🔐 Create your unlock PIN' : '🔐 Unlock'),
      h('div', { class: 'hint' }, creating
        ? 'Windows Hello is not set up on this PC, so Mochi uses its own PIN. You will need it to copy or reveal passwords.'
        : (totpOn
          ? 'Enter a code from your authenticator app, or your PIN. It stays unlocked for 15 minutes.'
          : 'Enter your PIN. It stays unlocked for 15 minutes, or until you lock the PC.')),
      pin, pin2 && h('div', { class: 'gap' }), pin2, err,
      h('div', { class: 'actions' },
        h('button', { class: 'btn ghost', onclick: () => { closeModal(); resolve(false); } }, 'Cancel'),
        h('button', { class: 'btn', onclick: submit }, creating ? 'Create PIN' : 'Unlock')),
    );
    pin.focus();
  });
}

async function openTwoFactor() {
  const unlocked = state.lock.unlocked || await withUnlock(() => api.lock.unlock());
  if (!unlocked) return;
  if (state.lock.totpSet) {
    const code = h('input', { class: 'field', inputmode: 'numeric', autocomplete: 'off', placeholder: '6-digit code to turn off' });
    const err = h('div', { class: 'error' });
    openModal(
      h('h3', null, '🔑 Two-factor is on'),
      h('div', { class: 'hint' }, 'Your authenticator app gives a code to unlock Mochi. Your PIN still works too. To turn two-factor off, enter a current code.'),
      code, err,
      h('div', { class: 'actions' },
        h('button', { class: 'btn ghost', onclick: closeModal }, 'Close'),
        h('button', { class: 'btn danger', onclick: async () => {
          const r = await api.lock.totpDisable(code.value.trim());
          if (r.ok) { toast('🔑 Two-factor turned off'); closeModal(); } else { err.textContent = r.error; code.select(); }
        } }, 'Turn off')),
    );
    return;
  }
  const begin = await api.lock.totpBegin();
  if (!begin.ok) { toast('⚠️ ' + begin.error); return; }
  const img = h('img', { class: 'qr', src: begin.qr, alt: 'QR code for your authenticator app' });
  const code = h('input', { class: 'field', inputmode: 'numeric', autocomplete: 'off', placeholder: '6-digit code from the app' });
  const err = h('div', { class: 'error' });
  const confirm = async () => {
    const r = await api.lock.totpConfirm(code.value.trim());
    if (r.ok) { toast('🔑 Two-factor on'); closeModal(); } else { err.textContent = r.error; code.select(); }
  };
  code.addEventListener('keydown', (e) => { if (e.key === 'Enter') confirm(); });
  openModal(
    h('h3', null, '🔑 Set up two-factor'),
    h('div', { class: 'hint' }, 'Scan this with Google Authenticator (or any TOTP app), then enter the 6-digit code to confirm. Keep your PIN as a backup in case your phone is away.'),
    img,
    h('details', { class: 'qr-manual' }, h('summary', null, "Can't scan? Enter the key by hand"), h('code', { class: 'qr-secret' }, begin.secret)),
    code, err,
    h('div', { class: 'actions' },
      h('button', { class: 'btn ghost', onclick: closeModal }, 'Cancel'),
      h('button', { class: 'btn', onclick: confirm }, 'Confirm')),
  );
}

// Runs a secret action; if the main process says a PIN is needed, ask and retry once.
async function withUnlock(action) {
  let r = await action();
  if (r && r.needPin) {
    if (!(await askPin())) return null;
    r = await action();
  }
  if (r && !r.ok && r.error) toast('⚠️ ' + r.error);
  return r && r.ok ? r : null;
}

// ---------- lock ----------
function renderLock() {
  const b = $('#lockBtn');
  b.textContent = state.lock.unlocked ? '🔓' : '🔒';
  b.title = state.lock.unlocked ? 'Unlocked — click to lock now' : 'Locked — click to unlock';
}
async function refreshLock() {
  state.lock = await api.lock.status();
  if (!state.lock.unlocked) {
    state.revealed.clear();
    endImport();
  }
  $('#mini').classList.toggle('locked', !state.lock.unlocked);
  renderLock();
  if (state.tab === 'keys') renderKeys();
}

// ---------- keys ----------
async function loadEntries() {
  state.entries = await api.vault.list();
  renderKeys();
}

function matches(e, q) {
  if (!q) return true;
  const hay = [e.title, e.group, e.username, e.host, e.remark, ...e.envs, ...e.extras.map((x) => x.name)].join(' ').toLowerCase();
  return q.toLowerCase().split(/\s+/).every((w) => hay.includes(w));
}

function visibleEntries() {
  return state.entries.filter((e) => (state.showTrash ? e.deletedAt : !e.deletedAt) && matches(e, state.query));
}

async function copy(id, field, label) {
  const r = await withUnlock(() => api.vault.copy(id, field));
  if (!r) return;
  toast(r.clearsIn ? `📋 ${label} copied · clears in ${r.clearsIn}s` : `📋 ${label} copied`);
}

async function toggleReveal(id, field) {
  const key = `${id}:${field}`;
  if (state.revealed.has(key)) { state.revealed.delete(key); renderKeys(); return; }
  const r = await withUnlock(() => api.vault.reveal(id, field));
  if (!r) return;
  state.revealed.set(key, r.value);
  renderKeys();
  setTimeout(() => { if (state.revealed.get(key) === r.value) { state.revealed.delete(key); renderKeys(); } }, REVEAL_MS);
}

function plainRow(label, value, id, field) {
  return h('div', { class: 'row' },
    h('span', { class: 'label', title: label }, label),
    h('span', { class: 'value', title: 'Click to copy', onclick: () => copy(id, field, label) }, value),
    h('button', { class: 'mini-icon', title: 'Copy', onclick: () => copy(id, field, label) }, '📋'));
}

function secretRow(label, id, field) {
  const shown = state.revealed.get(`${id}:${field}`);
  return h('div', { class: 'row' },
    h('span', { class: 'label', title: label }, label),
    h('span', { class: 'value ' + (shown != null ? 'shown' : 'masked'), title: 'Click to copy', onclick: () => copy(id, field, label) },
      shown != null ? shown : '••••••••'),
    h('button', { class: 'mini-icon', title: shown != null ? 'Hide' : 'Show for 10s', onclick: () => toggleReveal(id, field) }, shown != null ? '🙈' : '👁'),
    h('button', { class: 'mini-icon', title: 'Copy', onclick: () => copy(id, field, label) }, '📋'));
}

// Keys saved before this option existed fall back to their name.
function isRdp(e) {
  return e.rdp !== undefined ? e.rdp : /\brdp\b|remote/i.test(`${e.title} ${e.group}`);
}

async function runCommand(e) {
  const r = await withUnlock(() => api.vault.run(e.id));
  if (!r) return;
  toast('▶ Opening a terminal to run it…');
}

async function connect(e, host) {
  const r = await withUnlock(() => api.vault.connect(e.id, host));
  if (!r) return;
  if (r.chooseHost) { chooseHost(e, r.chooseHost); return; }
  if (r.mode === 'auto') toast(`🖥 Connecting to ${r.host}…`);
  if (r.mode === 'saved') toast('🖥 Using the login saved in Windows · password copied');
  if (r.mode === 'paste') toast('🖥 Paste the password if Windows asks');
}

function chooseHost(e, groups) {
  const list = h('div', { class: 'host-list' });
  const pick = (host) => { closeModal(); connect(e, host); };
  const matching = () => {
    const q = search.value.trim().toLowerCase();
    return groups
      .map((g) => ({ ...g, hosts: g.hosts.filter((host) => `${g.label} ${host}`.toLowerCase().includes(q)) }))
      .filter((g) => g.hosts.length);
  };
  const draw = () => {
    const shown = matching();
    list.replaceChildren(...shown.flatMap((g) => [
      g.label && h('div', { class: 'host-group' }, h('span', { class: `chip ${g.label}` }, g.label), h('span', { class: 'count' }, g.hosts.length)),
      h('div', { class: `host-grid ${g.label}` }, g.hosts.map((host) =>
        h('button', { class: 'btn ghost', onclick: () => pick(host) }, host))),
    ].filter(Boolean)));
    if (!shown.length) list.append(h('div', { class: 'hint' }, 'No server matches.'));
  };
  const search = h('input', {
    class: 'search', placeholder: 'Search…  (Enter connects if only one is left)',
    oninput: draw,
    onkeydown: (ev) => {
      // Only an exact single match: Enter must never land on a PROD server by accident.
      const hosts = matching().flatMap((g) => g.hosts);
      if (ev.key === 'Enter' && hosts.length === 1) pick(hosts[0]);
    },
  });
  draw();
  openModal(
    h('h3', null, `🖥 ${e.title}`),
    search,
    list,
    h('div', { class: 'actions' }, h('button', { class: 'btn ghost', onclick: closeModal }, 'Cancel')),
  );
}

let dragId = null;
function entryCard(e, draggable) {
  const rows = [];
  if (e.username) rows.push(plainRow('user', e.username, e.id, 'username'));
  if (e.hasPassword) rows.push(secretRow('pass', e.id, 'password'));
  if (e.hostCount > 1) {
    rows.push(h('div', { class: 'row' }, h('span', { class: 'label' }, 'host'), h('span', { class: 'host-count' }, `${e.hostCount} servers`)));
  } else if (e.host) {
    rows.push(plainRow('host', e.host, e.id, 'host'));
  }
  e.extras.forEach((x, i) => rows.push(x.secret ? secretRow(x.name, e.id, `extra:${i}`) : plainRow(x.name, x.value, e.id, `extra:${i}`)));
  if (e.hasPrev && !state.showTrash) {
    const open = state.showPrev.has(e.id);
    rows.push(h('div', { class: 'prev-toggle', onclick: () => { open ? state.showPrev.delete(e.id) : state.showPrev.add(e.id); renderKeys(); } },
      open ? '▾ previous password' : '▸ previous password'));
    if (open) rows.push(secretRow('prev', e.id, 'prevPassword'));
  }

  const actions = state.showTrash
    ? [h('button', { class: 'mini-icon', title: 'Restore', onclick: () => restoreEntry(e) }, '♻️'),
       h('button', { class: 'mini-icon', title: 'Delete forever', onclick: () => purgeEntry(e) }, '💥')]
    : [h('button', { class: 'mini-icon', title: 'Edit', onclick: () => editEntry(e) }, '✏️'),
       h('button', { class: 'mini-icon', title: 'Move to Trash', onclick: () => trashEntry(e) }, '🗑')];

  const card = h('div', { class: 'card', draggable: draggable ? 'true' : null },
    h('div', { class: 'card-head' },
      !state.showTrash && h('button', { class: 'mini-icon', title: e.fav ? 'Unpin' : 'Pin to top', onclick: async () => { await api.vault.fav(e.id); loadEntries(); } }, e.fav ? '⭐' : '☆'),
      h('span', { class: 'card-title', title: e.title }, e.title),
      e.envs.map((tag) => h('span', { class: 'chip ' + tagClass(tag) }, tag)),
      e.vpn && h('span', { class: 'chip', title: 'Ctrl+Alt+V types this login into FortiClient' }, '🔌'),
      actions),
    rows,
    e.remark && h('div', { class: 'remark' }, e.remark),
    !state.showTrash && isRdp(e) && h('button', { class: 'btn connect', onclick: () => connect(e) }, '🖥 Connect'),
    !state.showTrash && e.hasCommand && h('button', { class: 'btn connect run', onclick: () => runCommand(e) }, '▶ Run command'));

  if (draggable) {
    card.addEventListener('dragstart', () => { dragId = e.id; });
    card.addEventListener('dragover', (ev) => { ev.preventDefault(); card.classList.add('drag-over'); });
    card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
    card.addEventListener('drop', async (ev) => {
      ev.preventDefault();
      card.classList.remove('drag-over');
      if (!dragId || dragId === e.id) return;
      const ids = state.entries.map((x) => x.id).filter((id) => id !== dragId);
      ids.splice(ids.indexOf(e.id), 0, dragId);
      dragId = null;
      await api.vault.reorder(ids);
      loadEntries();
    });
  }
  return card;
}

function renderKeys() {
  const root = $('#tab-keys');
  const focused = document.activeElement && document.activeElement.id === 'search';
  const caret = focused ? document.activeElement.selectionStart : null;

  const search = h('input', {
    id: 'search', class: 'search', placeholder: state.showTrash ? 'Search trash…' : 'Search…  (Enter = copy password)', value: state.query,
    oninput: (ev) => { state.query = ev.target.value; renderKeys(); },
    onkeydown: (ev) => {
      if (ev.key === 'Escape') { state.query = ''; renderKeys(); }
      if (ev.key === 'Enter') {
        const first = visibleEntries().find((x) => x.hasPassword);
        if (first) copy(first.id, 'password', `${first.title} password`);
      }
    },
  });
  const toolbar = h('div', { class: 'toolbar' }, search,
    state.showTrash
      ? h('button', { class: 'btn ghost', onclick: () => { state.showTrash = false; renderKeys(); } }, '← Back')
      : h('button', { class: 'btn', onclick: () => editEntry(null) }, '+ Add'));

  const list = visibleEntries();
  const body = [];
  if (state.showTrash) {
    body.push(h('div', { class: 'hint' }, '🗑 Trash — items are deleted for good after 30 days.'));
    list.forEach((e) => body.push(entryCard(e, false)));
    if (!list.length) body.push(h('div', { class: 'empty' }, h('div', { class: 'big' }, '✨'), 'Trash is empty'));
  } else if (!state.entries.some((e) => !e.deletedAt)) {
    body.push(h('div', { class: 'empty' }, h('div', { class: 'big' }, '🍡'), 'No keys yet.', h('br'), 'Click “+ Add” to save your first password.'));
  } else {
    const groups = new Map();
    const favs = list.filter((e) => e.fav);
    if (favs.length) groups.set('⭐ Favorites', favs);
    for (const e of list.filter((x) => !x.fav)) {
      if (!groups.has(e.group)) groups.set(e.group, []);
      groups.get(e.group).push(e);
    }
    const canDrag = !state.query;
    for (const [name, items] of groups) {
      const collapsed = state.collapsed.has(name) && !state.query;
      body.push(h('div', { class: 'group-head', onclick: () => { collapsed ? state.collapsed.delete(name) : state.collapsed.add(name); renderKeys(); } },
        collapsed ? '▸' : '▾', name, h('span', { class: 'count' }, `(${items.length})`)));
      if (!collapsed) items.forEach((e) => body.push(entryCard(e, canDrag)));
    }
    if (!list.length) body.push(h('div', { class: 'empty' }, 'Nothing matches “' + state.query + '”'));
  }
  root.replaceChildren(toolbar, ...body);
  if (focused) { search.focus(); search.setSelectionRange(caret, caret); }
}

function generatePassword(len = 20) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*-_=+?';
  const out = [];
  const buf = new Uint32Array(1);
  while (out.length < len) {
    crypto.getRandomValues(buf);
    // Rejection sampling avoids modulo bias.
    if (buf[0] < Math.floor(2 ** 32 / chars.length) * chars.length) out.push(chars[buf[0] % chars.length]);
  }
  return out.join('');
}

// Tags are stored in each key's `envs` field and in each link's label.
function tagOf(label) {
  return envOf(label) || (label || '').trim();
}

function tagClass(tag) {
  const known = envOf(tag);
  if (known || !tag) return known;
  const sum = [...tag].reduce((total, ch) => total + ch.codePointAt(0), 0);
  return `tag-${sum % TAG_COLORS}`;
}

function linkTags() {
  return [...new Set((state.doc.links || []).flatMap((p) => p.items.filter((i) => i.url && i.label).map((i) => tagOf(i.label))))];
}

// Every tag in use. One that nothing uses any more drops off this list.
function allTags() {
  return [...new Set([...state.entries.filter((x) => !x.deletedAt).flatMap((x) => x.envs), ...linkTags()])];
}

function tagPicker(selected) {
  const chosen = new Set(selected);
  const known = [...new Set([...allTags(), ...selected])];
  const box = h('div', { class: 'tag-picker' });
  const input = h('input', { class: 'field tag-input', placeholder: 'Add a tag…', maxlength: TAG_MAX_LENGTH });

  const paint = () => box.replaceChildren(
    ...known.map((tag) => h('button', {
      class: `chip tag-choice ${tagClass(tag)}${chosen.has(tag) ? ' selected' : ''}`,
      title: chosen.has(tag) ? 'Click to remove' : 'Click to add',
      onclick: () => { if (!chosen.delete(tag)) chosen.add(tag); paint(); },
    }, tag)),
    input,
  );
  // Commas let a pasted list become several tags. "prod" reuses "PROD".
  const addTyped = () => {
    for (const part of input.value.split(',')) {
      const text = part.trim().slice(0, TAG_MAX_LENGTH);
      if (!text) continue;
      const same = known.find((tag) => tag.toLowerCase() === text.toLowerCase());
      if (!same) known.push(text);
      chosen.add(same || text);
    }
    input.value = '';
  };
  input.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' && ev.key !== ',') return;
    ev.preventDefault();
    addTyped();
    paint();
    input.focus();
  });
  paint();
  return { el: box, read: () => { addTyped(); return [...chosen]; } };
}

// `e` may be an unsaved draft (no id) with prefilled fields; onDone(saved) runs on Save or Cancel.
function editEntry(e, onDone) {
  const isNew = !e || !e.id;
  const leave = () => { closeModal(); if (onDone) onDone(false); };
  const groups = [...new Set(state.entries.map((x) => x.group))];
  const title = h('input', { class: 'field', value: e ? e.title : '', placeholder: 'e.g. AFIN-USER-VPN' });
  const group = h('input', { class: 'field', value: e ? e.group : '', placeholder: 'VPN, RDP, DB…', list: 'groups' });
  const groupList = h('datalist', { id: 'groups' }, groups.map((g) => h('option', { value: g })));
  const tags = tagPicker(e ? e.envs : []);
  const username = h('input', { class: 'field', value: e ? e.username : '', placeholder: 'username or domain\\user' });
  const host = h('textarea', { class: 'field host-box', value: e ? e.host : '', rows: 2, placeholder: 'server / URL. For several, paste a list:\nPROD 10.0.0.1, 10.0.0.2\nUAT 10.0.1.1' });
  const rdp = h('input', { type: 'checkbox', checked: e ? isRdp(e) : false });
  const commandBox = h('textarea', { class: 'field host-box', value: e ? e.command || '' : '', rows: 3, placeholder: 'Run command (optional). One per line, e.g.:\ncd C:\\path\\to\\project\ngit switch my-branch\nnpm start' });
  const vpnLogin = h('input', { type: 'checkbox', checked: Boolean(e && e.vpn) });
  const password = h('input', { class: 'field', type: 'password', autocomplete: 'new-password', value: e && e.password,
    placeholder: isNew ? 'required' : 'leave blank to keep current' });
  const remark = h('textarea', { class: 'field', value: e ? e.remark : '', placeholder: 'Remark (optional)', rows: 2 });
  const extrasBox = h('div');
  const err = h('div', { class: 'error' });

  const addExtra = (x = { name: '', value: '', secret: false }) => {
    const name = h('input', { class: 'field name', value: x.name, placeholder: 'name' });
    const value = h('input', { class: 'field', type: x.secret ? 'password' : 'text', value: x.value,
      placeholder: x.secret && !isNew ? 'unchanged' : 'value' });
    const secret = h('input', { type: 'checkbox', checked: x.secret, title: 'Secret (masked)',
      onchange: () => { value.type = secret.checked ? 'password' : 'text'; } });
    const row = h('div', { class: 'extra' }, name, value, h('label', { title: 'Secret (masked)' }, secret, '🔒'),
      h('button', { class: 'mini-icon', title: 'Remove', onclick: () => row.remove() }, '✕'));
    row.read = () => ({ name: name.value, value: value.value, secret: secret.checked });
    extrasBox.append(row);
  };
  (e ? e.extras : []).forEach(addExtra);

  const save = async () => {
    const r = await api.vault.save({
      id: e ? e.id : undefined,
      title: title.value, group: group.value, envs: tags.read(),
      username: username.value, host: host.value, password: password.value, remark: remark.value, rdp: rdp.checked, vpn: vpnLogin.checked, command: commandBox.value,
      extras: [...extrasBox.children].map((row) => row.read()),
    });
    if (!r.ok) { err.textContent = r.error; return; }
    closeModal();
    toast(isNew ? '✨ Saved' : '✨ Updated');
    loadEntries();
    if (onDone) onDone(true);
  };

  openModal(
    h('h3', null, isNew ? '🔑 New key' : '✏️ Edit key'),
    h('label', null, 'Title *'), title,
    h('label', null, 'Group'), group, groupList,
    h('label', null, 'Tags'),
    tags.el,
    h('label', null, 'Username'), username,
    h('label', null, isNew ? 'Password *' : 'New password'),
    h('div', { class: 'inline' }, password,
      h('button', { class: 'mini-icon', title: 'Show / hide', onclick: () => { password.type = password.type === 'password' ? 'text' : 'password'; } }, '👁'),
      h('button', { class: 'mini-icon', title: 'Generate a strong password', onclick: () => { password.value = generatePassword(); password.type = 'text'; } }, '🎲')),
    !isNew && e.hasPassword && h('div', { class: 'hint' }, 'Changing it keeps the old one under “previous password”.'),
    h('label', null, 'Host'), host,
    h('label', { class: 'check' }, rdp, '🖥 Remote Desktop server (adds a Connect button)'),
    h('label', { class: 'check' }, vpnLogin, '🔌 VPN login (Ctrl+Alt+V types it into FortiClient)'),
    h('label', null, '▶ Run command'), commandBox,
    h('label', null, 'Extra fields'), extrasBox,
    h('button', { class: 'btn ghost', onclick: () => addExtra() }, '+ field'),
    h('label', null, 'Remark'), remark,
    err,
    h('div', { class: 'actions' },
      h('button', { class: 'btn ghost', onclick: leave }, 'Cancel'),
      h('button', { class: 'btn', onclick: save }, 'Save')),
  );
}

async function trashEntry(e) {
  await api.vault.trash(e.id);
  await loadEntries();
  toast(`🗑 “${e.title}” moved to Trash`, async () => { await api.vault.restore(e.id); loadEntries(); });
}

async function restoreEntry(e) {
  await api.vault.restore(e.id);
  await loadEntries();
  toast(`♻️ “${e.title}” restored`);
}

function purgeEntry(e) {
  openModal(
    h('h3', null, '💥 Delete forever?'),
    h('div', { class: 'hint' }, `“${e.title}” and its passwords will be gone for good. This cannot be undone.`),
    h('div', { class: 'actions' },
      h('button', { class: 'btn ghost', onclick: closeModal }, 'Cancel'),
      h('button', { class: 'btn danger', onclick: async () => { closeModal(); await api.vault.purge(e.id); loadEntries(); } }, 'Delete forever')),
  );
}

// ---------- today ----------
function saveDoc() {
  updateBadge();
  return api.notes.save(state.doc);
}

// Mochi badge: open tasks today; happy face when everything is done.
function updateBadge() {
  const today = state.doc.days[0];
  const todos = today ? today.items.filter((i) => i.raw === undefined) : [];
  const open = todos.filter((i) => !i.done).length;
  const badge = $('#miniBadge');
  badge.textContent = open > 9 ? '9+' : String(open);
  badge.classList.toggle('hidden', open === 0);
  const happy = todos.length > 0 && open === 0;
  if (happy && state.docLoaded && !$('#mini').classList.contains('happy')) bounceMascot();
  state.docLoaded = true;
  $('#mini').classList.toggle('happy', happy);
  $('#mini').title = state.thirsty ? WATER_TITLE : open ? `${open} task${open > 1 ? 's' : ''} left · click to open · drag to move` : 'Click to open · drag to move';
}

function isEditingIn(rootSel) {
  const a = document.activeElement;
  return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA') && a.closest(rootSel) && a.dataset.keep !== '1';
}

function todayLabel(date) {
  const d = new Date(date + 'T00:00:00');
  return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
}

function todoRow(day, item) {
  const text = h('span', { class: 'text', title: 'Double-click to edit' }, item.text);
  const row = h('div', { class: 'todo' + (item.done ? ' done' : '') },
    h('input', { type: 'checkbox', checked: item.done, onchange: async (ev) => { item.done = ev.target.checked; await saveDoc(); renderToday(); } }),
    text,
    h('button', { class: 'mini-icon', title: 'Delete', onclick: async () => {
      const idx = day.items.indexOf(item);
      day.items.splice(idx, 1);
      await saveDoc();
      renderToday();
      toast('🗑 Task deleted', async () => { day.items.splice(idx, 0, item); await saveDoc(); renderToday(); });
    } }, '✕'));
  text.addEventListener('dblclick', () => {
    const input = h('input', { class: 'field', value: item.text });
    let finished = false;
    const finish = async (keep) => {
      if (finished) return;
      finished = true;
      input.dataset.keep = '1'; // let renderToday run while this input still has focus
      if (keep && input.value.trim()) { item.text = input.value.trim(); await saveDoc(); }
      renderToday();
    };
    input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') finish(true); if (ev.key === 'Escape') finish(false); });
    input.addEventListener('blur', () => finish(true));
    text.replaceWith(input);
    input.focus();
  });
  return row;
}

function standupText(today, yesterday) {
  const lines = ['Yesterday:'];
  const done = yesterday ? yesterday.items.filter((i) => i.done) : [];
  lines.push(...(done.length ? done.map((i) => `- ${i.text}`) : ['- (nothing logged)']));
  lines.push('', 'Today:');
  const todos = today.items.filter((i) => i.raw === undefined);
  lines.push(...(todos.length ? todos.map((i) => `- ${i.done ? '✅ ' : ''}${i.text}`) : ['- (nothing planned yet)']));
  return lines.join('\n');
}

function renderToday() {
  if (isEditingIn('#tab-today')) { state.pendingNotesRender = true; return; }
  const root = $('#tab-today');
  const [today, yesterday] = state.doc.days;
  if (!today) { root.replaceChildren(h('div', { class: 'empty' }, 'Loading…')); return; }

  const todos = today.items.filter((i) => i.raw === undefined);
  const doneCount = todos.filter((i) => i.done).length;
  const add = h('input', { class: 'search', placeholder: 'Add a task… (Enter)', 'data-keep': '1' });
  add.addEventListener('keydown', async (ev) => {
    if (ev.key !== 'Enter' || !add.value.trim()) return;
    today.items.push({ done: false, text: add.value.trim() });
    add.value = '';
    await saveDoc();
    renderToday();
    $('#tab-today input.search').focus();
  });

  const yDone = yesterday ? yesterday.items.filter((i) => i.done) : [];
  root.replaceChildren(...[
    h('div', { class: 'day-title' }, todayLabel(today.date)),
    h('div', { class: 'hint' }, todos.length ? `${doneCount} of ${todos.length} done${doneCount === todos.length ? ' 🎉' : ''}` : 'Fresh day! Unfinished tasks carry over automatically.'),
    h('div', { class: 'toolbar' }, add,
      h('button', { class: 'btn ghost', title: 'Copy a Yesterday/Today summary for your standup',
        onclick: async () => { await navigator.clipboard.writeText(standupText(today, yesterday)); toast('📋 Standup copied'); } }, '📋 Standup')),
    today.items.map((i) => (i.raw !== undefined ? h('div', { class: 'raw' }, i.raw) : todoRow(today, i))),
    yesterday && h('div', { class: 'section-head', onclick: () => { state.yesterdayOpen = !state.yesterdayOpen; renderToday(); } },
      `${state.yesterdayOpen ? '▾' : '▸'} Done on ${todayLabel(yesterday.date)} (${yDone.length})`),
    yesterday && state.yesterdayOpen && (yDone.length
      ? h('ul', { class: 'yesterday' }, yDone.map((i) => h('li', null, i.text)))
      : h('div', { class: 'hint' }, 'Nothing checked off that day.')),
  ].flat().filter((c) => c != null && c !== false));
}

// ---------- links ----------

function envOf(label) {
  const m = (label || '').toUpperCase().match(/\b(PROD|UAT|DEV|SIT)\b/);
  return m ? m[1] : '';
}

function visibleProjects() {
  const words = state.linkQuery.toLowerCase().split(/\s+/).filter(Boolean);
  const filtering = words.length || state.linkEnv !== 'All';
  return (state.doc.links || [])
    .map((p) => {
      const items = p.items
        .filter((i) => i.raw === undefined)
        .filter((i) => state.linkEnv === 'All' || tagOf(i.label) === state.linkEnv)
        .filter((i) => words.every((w) => `${p.project} ${i.label} ${i.url}`.toLowerCase().includes(w)));
      return { p, items };
    })
    .filter(({ items }) => items.length || !filtering);
}

async function openLink(url) {
  const r = await api.links.open(url);
  if (!r.ok) toast('⚠️ ' + r.error);
}

function linkDotState(url) {
  return state.linkStatus[url] || { state: 'checking', detail: 'Checking…' };
}

function paintDot(dot) {
  const { state: status, detail } = linkDotState(dot.dataset.url);
  dot.className = 'link-dot ' + status;
  dot.title = detail;
}

function onLinkStatus(result) {
  state.linkStatus[result.url] = result;
  document.querySelectorAll('.link-dot').forEach((dot) => { if (dot.dataset.url === result.url) paintDot(dot); });
}

// Dots only update on the Links tab, so nothing is requested until it's open.
async function checkLinks(force = false) {
  const urls = (state.doc.links || []).flatMap((p) => p.items.filter((i) => i.url).map((i) => i.url));
  if (force) state.linkStatus = {};
  document.querySelectorAll('.link-dot').forEach(paintDot);
  const known = await api.links.check(urls, force);
  Object.values(known).forEach(onLinkStatus);
}

function linkRow(item) {
  const dot = h('span', { class: 'link-dot', 'data-url': item.url });
  paintDot(dot);
  return h('div', { class: 'row' },
    dot,
    h('span', { class: 'chip link-label ' + tagClass(item.label), title: item.label || 'link' }, item.label || '🔗'),
    h('span', { class: 'value link', title: `${item.url}\nClick to open`, onclick: () => openLink(item.url) }, item.url.replace(/^https?:\/\//i, '')),
    h('button', { class: 'mini-icon', title: 'Copy link', onclick: async () => { await navigator.clipboard.writeText(item.url); toast('📋 Link copied'); } }, '📋'));
}

function renderLinks() {
  const root = $('#tab-links');
  const focused = document.activeElement && document.activeElement.id === 'linkSearch';
  const caret = focused ? document.activeElement.selectionStart : null;
  const filterTags = ['All', ...linkTags()];
  if (!filterTags.includes(state.linkEnv)) state.linkEnv = 'All';
  const list = visibleProjects();

  const search = h('input', {
    id: 'linkSearch', class: 'search', placeholder: 'Search…  (Enter = open)', value: state.linkQuery,
    oninput: (ev) => { state.linkQuery = ev.target.value; renderLinks(); },
    onkeydown: (ev) => {
      if (ev.key === 'Escape') { state.linkQuery = ''; renderLinks(); }
      if (ev.key === 'Enter') {
        const first = list.find((x) => x.items.length);
        if (first) openLink(first.items[0].url);
      }
    },
  });
  const filters = h('div', { class: 'filters' }, filterTags.map((env) =>
    h('button', { class: 'filter' + (state.linkEnv === env ? ' active' : ''), onclick: () => { state.linkEnv = env; renderLinks(); } }, env)),
    h('button', { class: 'filter link-refresh', title: 'Check links again', onclick: () => checkLinks(true) }, '↻'));

  let body;
  if (!(state.doc.links || []).length) {
    body = h('div', { class: 'empty' }, h('div', { class: 'big' }, '🔗'), 'No links yet.', h('br'), 'Click “+ Project” to add your links, with a tag for each one.');
  } else if (!list.length) {
    body = h('div', { class: 'empty' }, 'Nothing matches.');
  } else {
    const showRaw = state.linkEnv === 'All' && !state.linkQuery;
    body = list.map(({ p, items }) => {
      const raw = showRaw ? p.items.filter((i) => i.raw !== undefined).map((i) => i.raw.trim()).join('\n') : '';
      return h('div', { class: 'card' },
        h('div', { class: 'card-head' },
          h('span', { class: 'card-title', title: p.project }, p.project),
          h('button', { class: 'mini-icon', title: 'Edit project', onclick: () => editProject(p) }, '✏️')),
        items.map(linkRow),
        !items.length && h('div', { class: 'hint' }, 'No links yet — click ✏️ to add some.'),
        raw && h('div', { class: 'remark' }, raw));
    });
  }
  root.replaceChildren(
    h('div', { class: 'toolbar' }, search, h('button', { class: 'btn', onclick: () => editProject(null) }, '+ Project')),
    filters,
    ...[body].flat(),
  );
  if (focused) { search.focus(); search.setSelectionRange(caret, caret); }
}

function editProject(p, onDone) {
  const isNew = !p || p.draft;
  const leave = () => { closeModal(); if (onDone) onDone(false); };
  const name = h('input', { class: 'field', value: p ? p.project : '', placeholder: 'e.g. Customer Sync API' });
  const rowsBox = h('div');
  const err = h('div', { class: 'error' });

  const addRow = (it = { label: '', url: '' }) => {
    const label = h('input', { class: 'field name', value: it.label, placeholder: 'Tag', list: 'linkLabels' });
    const url = h('input', { class: 'field', value: it.url, placeholder: 'https://…' });
    const row = h('div', { class: 'extra' }, label, url,
      h('button', { class: 'mini-icon', title: 'Remove', onclick: () => row.remove() }, '✕'));
    row.read = () => {
      const u = url.value.trim();
      // Bare hosts like "cs.uat.local/api" get https:// added.
      return { label: label.value.replace(/:/g, '').trim(), url: u && !/^[a-z][\w+.-]*:\/\//i.test(u) && !/^www\./i.test(u) ? `https://${u}` : u };
    };
    rowsBox.append(row);
  };
  const existing = p ? p.items.filter((i) => i.raw === undefined) : [];
  if (existing.length) existing.forEach(addRow);
  else ['PROD', 'UAT', 'DEV'].forEach((label) => addRow({ label, url: '' }));

  const save = async () => {
    const items = [...rowsBox.children].map((row) => row.read()).filter((i) => i.url);
    const bad = items.find((i) => /\s/.test(i.url));
    if (!name.value.trim()) { err.textContent = 'Project name is required'; return; }
    if (bad) { err.textContent = `“${bad.url}” has a space in it`; return; }
    if (isNew) {
      state.doc.links = state.doc.links || [];
      state.doc.links.push({ project: name.value.trim(), items });
    } else {
      p.project = name.value.trim();
      p.items = [...items, ...p.items.filter((i) => i.raw !== undefined)];
    }
    await saveDoc();
    closeModal();
    renderLinks();
    toast(isNew ? '✨ Project added' : '✨ Updated');
    if (onDone) onDone(true);
  };
  const remove = async () => {
    const idx = state.doc.links.indexOf(p);
    state.doc.links.splice(idx, 1);
    await saveDoc();
    closeModal();
    renderLinks();
    toast(`🗑 “${p.project}” deleted`, async () => { state.doc.links.splice(idx, 0, p); await saveDoc(); renderLinks(); });
  };

  openModal(
    h('h3', null, isNew ? '🔗 New project' : '🔗 Edit project'),
    h('label', null, 'Project *'), name,
    h('label', null, 'Links'), rowsBox,
    h('datalist', { id: 'linkLabels' }, allTags().map((l) => h('option', { value: l }))),
    h('button', { class: 'btn ghost', onclick: () => addRow() }, '+ link'),
    h('div', { class: 'hint' }, 'Labels with PROD / UAT / DEV can be filtered. Empty rows are skipped.'),
    err,
    h('div', { class: 'actions' },
      !isNew && h('button', { class: 'btn danger left', onclick: remove }, 'Delete'),
      h('button', { class: 'btn ghost', onclick: leave }, 'Cancel'),
      h('button', { class: 'btn', onclick: save }, 'Save')),
  );
}

// ---------- notes ----------
function editNote(note, onDone) {
  const isNew = !note || note.draft;
  const leave = () => { closeModal(); if (onDone) onDone(false); };
  const title = h('input', { class: 'field', value: note ? note.title : '', placeholder: 'Title' });
  const body = h('textarea', { class: 'field', value: note ? note.body : '', rows: 9, placeholder: 'Write anything… (markdown is fine)' });
  const save = async () => {
    if (!title.value.trim() && !body.value.trim()) { leave(); return; }
    if (isNew) state.doc.notes.unshift({ title: title.value.trim() || 'Untitled', body: body.value.trim() });
    else { note.title = title.value.trim() || 'Untitled'; note.body = body.value.trim(); }
    await saveDoc();
    closeModal();
    renderNotes();
    if (onDone) onDone(true);
  };
  const remove = async () => {
    const idx = state.doc.notes.indexOf(note);
    state.doc.notes.splice(idx, 1);
    await saveDoc();
    closeModal();
    renderNotes();
    toast('🗑 Note deleted', async () => { state.doc.notes.splice(idx, 0, note); await saveDoc(); renderNotes(); });
  };
  openModal(
    h('h3', null, isNew ? '📝 New note' : '📝 Edit note'),
    title, h('div', { class: 'gap' }), body,
    h('div', { class: 'hint' }, '🙅 No passwords here — notes.md is plain text. Use 🔑 Keys instead.'),
    h('div', { class: 'actions' },
      !isNew && h('button', { class: 'btn danger left', onclick: remove }, 'Delete'),
      h('button', { class: 'btn ghost', onclick: leave }, 'Cancel'),
      h('button', { class: 'btn', onclick: save }, 'Save')),
  );
}

function renderNotes() {
  const root = $('#tab-notes');
  root.replaceChildren(...[
    h('div', { class: 'toolbar' },
      h('button', { class: 'btn', onclick: () => editNote(null) }, '+ Note'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn ghost', title: 'Open the folder with notes.md', onclick: () => api.notes.open() }, '📂 notes.md')),
    h('div', { class: 'hint' }, '✨ Messy? Ask Claude Code: “reorganize my notes.md”. Changes show up here automatically.'),
    state.doc.notes.length
      ? state.doc.notes.map((n) => h('div', { class: 'card note', onclick: () => editNote(n) },
          h('div', { class: 'card-title' }, n.title),
          n.body && h('div', { class: 'body' }, n.body)))
      : h('div', { class: 'empty' }, h('div', { class: 'big' }, '📝'), 'No notes yet.'),
  ].flat().filter((c) => c != null && c !== false));
}

// ---------- menu / backup ----------
function askMaster(confirmTwice) {
  return new Promise((resolve) => {
    const p1 = h('input', { class: 'field', type: 'password', placeholder: 'Master password (8+ characters)' });
    const p2 = confirmTwice ? h('input', { class: 'field', type: 'password', placeholder: 'Repeat master password' }) : null;
    const err = h('div', { class: 'error' });
    const ok = () => {
      if (confirmTwice && p1.value !== p2.value) { err.textContent = 'Passwords do not match'; return; }
      closeModal(); resolve(p1.value);
    };
    openModal(
      h('h3', null, confirmTwice ? '💾 Export backup' : '📥 Import backup'),
      h('div', { class: 'hint' }, confirmTwice
        ? 'The backup file is encrypted with this master password. Without it the file is useless — write it down somewhere safe.'
        : 'Entries with the same ID are replaced; others are added.'),
      p1, p2 && h('div', { class: 'gap' }), p2, err,
      h('div', { class: 'actions' },
        h('button', { class: 'btn ghost', onclick: () => { closeModal(); resolve(null); } }, 'Cancel'),
        h('button', { class: 'btn', onclick: ok }, 'Continue')),
    );
  });
}

async function onMenu(act) {
  $('#menu').classList.add('hidden');
  if (act === 'trash') { switchTab('keys'); state.showTrash = true; state.query = ''; renderKeys(); }
  if (act === 'openNotes') api.notes.open();
  if (act === 'mascots') openMascots();
  if (act === 'sticky') openImport();
  if (act === 'water') openWater();
  if (act === 'rename') openRename();
  if (act === 'twofactor') openTwoFactor();
  if (act === 'autostart') {
    const r = await api.win.setAutostart(!state.autostart);
    if (!r.ok) { toast('⚠️ ' + r.error); return; }
    showAutostart(r.on);
    toast(r.on ? '🚀 Mochi will start with Windows' : 'Mochi won\'t start with Windows');
  }
  if (act === 'vpnLight') api.vpn.light(!state.vpnLight);
  if (act === 'export') {
    const m = await askMaster(true);
    if (!m) return;
    const r = await api.backup.export(m);
    if (r.ok) toast('💾 Backup saved'); else if (!r.canceled) toast('⚠️ ' + r.error);
  }
  if (act === 'import') {
    const m = await askMaster(false);
    if (!m) return;
    const r = await api.backup.import(m);
    if (r.ok) { toast(`📥 Imported ${r.count} keys`); loadEntries(); } else if (!r.canceled) toast('⚠️ ' + r.error);
  }
}

function showName(name) {
  $('#brand').textContent = name;
  $('#brand').title = name;
  document.title = name; // Electron copies this to the taskbar.
}

function openRename() {
  const input = h('input', { class: 'field', value: $('#brand').textContent, maxlength: 30 });
  const save = async () => {
    const r = await api.win.rename(input.value);
    if (!r.ok) { toast('⚠️ ' + r.error); return; }
    showName(r.name);
    closeModal();
  };
  input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') save(); });
  openModal(
    h('h3', null, '✏️ Rename'),
    h('div', { class: 'hint' }, 'Shown in the title bar and on the taskbar. Emoji work too. Leave it empty to go back to the original name.'),
    input,
    h('div', { class: 'actions' },
      h('button', { class: 'btn ghost', onclick: closeModal }, 'Cancel'),
      h('button', { class: 'btn', onclick: save }, 'Save')),
  );
  input.select();
}

function showAutostart(on) {
  state.autostart = on;
  $('#autostartBtn').textContent = (on ? '✅' : '⬜') + ' Start with Windows';
}

// ---------- VPN ----------
function showVpn(s) {
  const pill = $('#vpnPill');
  const menuItem = $('#vpnLightBtn');
  state.vpnLight = s.light !== false;
  menuItem.classList.toggle('hidden', !s.known);
  menuItem.textContent = state.vpnLight ? '🔌 Hide VPN light' : '🔌 Show VPN light';
  pill.classList.toggle('hidden', !s.known || !state.vpnLight);
  pill.classList.toggle('up', s.connected);
  pill.classList.toggle('down', s.dropped);
  pill.title = s.connected ? 'VPN connected' : 'VPN not connected: click to open FortiClient';
  if (s.dropped && !$('#mini').classList.contains('vpn-down')) bounceMascot();
  $('#mini').classList.toggle('vpn-down', s.dropped);
  // Main forgets link results whenever this changes, so ask again.
  const vpnKey = `${s.known}:${s.connected}`;
  if (vpnKey !== state.vpnKey) {
    state.vpnKey = vpnKey;
    state.linkStatus = {};
    if (state.tab === 'links') checkLinks();
  }
}

async function openFortiClient() {
  if ($('#vpnPill').classList.contains('up')) return;
  const r = await api.vpn.open();
  toast(r.ok ? 'Click the Username box, then press Ctrl+Alt+V' : '⚠️ ' + r.error);
}

async function onVpnMessage({ text, unlock }) {
  await setMini(false);
  toast(text);
  if (unlock) withUnlock(() => api.lock.unlock());
}

// ---------- sticky notes import ----------
const importer = { notes: null, index: 0 };
const KIND_ICON = { secret: '🔑', url: '🔗', user: '👤', text: '📝' };

// Drops the plain-text notes from memory; also runs when the vault locks.
function endImport() {
  if (!importer.notes) return;
  importer.notes = null;
  closeModal();
}

async function openImport() {
  const r = await withUnlock(() => api.sticky.scan());
  if (!r) return;
  if (r.errors.length) toast('⚠️ ' + r.errors.join(' · '));
  if (!r.notes.length) { toast('No Sticky Notes found'); return; }
  importer.notes = r.notes.map((n) => ({ ...n, items: n.items.map((i) => ({ ...i, on: true, used: false })) }));
  const next = importer.notes.findIndex((n) => !n.reviewed);
  importer.index = next === -1 ? importer.notes.length : next;
  showImport();
}

function pickedLines(n) {
  return n.items.filter((i) => i.on && !i.used);
}

function afterImportStep(used) {
  return (saved) => {
    if (saved) used.forEach((i) => { i.used = true; });
    showImport();
  };
}

function importToKey(n) {
  const picked = pickedLines(n);
  const secret = picked.find((i) => i.kind === 'secret');
  if (!secret) { toast('Tick a line marked as a password 🔑'); return; }
  const [title, ...others] = picked.filter((i) => i.kind === 'text');
  const user = picked.find((i) => i.kind === 'user');
  const url = picked.find((i) => i.kind === 'url');
  const label = title ? title.text : '';
  editEntry({
    title: label.replace(/\s*\((?:PROD|UAT|DEV)\b[^)]*\)\s*$/i, ''),
    group: '',
    envs: ['PROD', 'UAT', 'DEV'].filter((env) => new RegExp(`\\b${env}\\b`, 'i').test(label)),
    username: user ? user.text : '',
    host: url ? url.text : '',
    password: secret.text,
    remark: others.map((i) => i.text).join('\n'),
    extras: [],
  }, afterImportStep([secret, title, user, url, ...others].filter(Boolean)));
}

function importToLinks(n) {
  const picked = pickedLines(n);
  const urls = picked.filter((i) => i.kind === 'url');
  if (!urls.length) { toast('Tick a line marked as a link 🔗'); return; }
  const title = picked.find((i) => i.kind === 'text');
  const items = urls.map((i) => {
    const m = i.text.match(/(?:https?:\/\/|www\.)\S+/i);
    return { label: i.text.slice(0, m.index).replace(/[\s:=-]+$/, ''), url: m[0] };
  });
  editProject({ draft: true, project: title ? title.text : '', items }, afterImportStep([title, ...urls].filter(Boolean)));
}

function importToNote(n) {
  // Lines marked as passwords never go to notes.md, which is plain text.
  const lines = pickedLines(n).filter((i) => i.kind !== 'secret');
  if (!lines.length) { toast('Tick some lines that are not passwords'); return; }
  const [title, ...rest] = lines;
  editNote({ draft: true, title: title.text, body: rest.map((i) => i.text).join('\n') }, afterImportStep(lines));
}

function importLine(item) {
  const secret = item.kind === 'secret';
  return h('div', { class: 'imp-line' + (item.used ? ' used' : '') },
    h('input', { type: 'checkbox', checked: item.on && !item.used, disabled: item.used, onchange: (ev) => { item.on = ev.target.checked; } }),
    h('span', { class: 'imp-kind' }, item.used ? '✅' : KIND_ICON[item.kind]),
    h('span', { class: 'imp-text' + (secret ? ' masked' : '') }, secret ? '••••••••' : item.text),
    !item.used && h('button', {
      class: 'mini-icon',
      title: secret ? 'Not a password: show this line' : 'This is a password: hide this line',
      onclick: () => { item.kind = secret ? 'text' : 'secret'; showImport(); },
    }, secret ? '👁' : '🔒'));
}

function showImport() {
  const { notes, index } = importer;
  if (!notes) return;
  if (index >= notes.length) { showImportDone(); return; }
  const n = notes[index];
  const meta = [n.source, n.from, n.modifiedAt ? new Date(n.modifiedAt).toLocaleDateString() : ''].filter(Boolean).join(' · ');
  const go = async (step) => {
    if (step > 0) await api.sticky.reviewed(n.id);
    importer.index = Math.max(0, index + step);
    showImport();
  };
  openModal(
    h('h3', null, `🗒 Note ${index + 1} of ${notes.length}`),
    h('div', { class: 'hint' }, meta),
    n.hasPicture && h('div', { class: 'hint' }, '🖼 This note also has a picture, which is not imported.'),
    h('div', { class: 'hint' }, 'Tick the lines for one login, then send them. Repeat until the note is cleared.'),
    h('div', { class: 'imp-lines' }, n.items.map(importLine)),
    h('div', { class: 'imp-send' },
      h('button', { class: 'btn', onclick: () => importToKey(n) }, '🔑 Key'),
      h('button', { class: 'btn', onclick: () => importToLinks(n) }, '🔗 Link'),
      h('button', { class: 'btn', onclick: () => importToNote(n) }, '📝 Note')),
    h('div', { class: 'actions' },
      h('button', { class: 'btn ghost left', onclick: endImport }, 'Stop'),
      index > 0 && h('button', { class: 'btn ghost', onclick: () => go(-1) }, '◂ Back'),
      h('button', { class: 'btn ghost', onclick: () => go(1) }, 'Next ▸')),
  );
}

function showImportDone() {
  openModal(
    h('h3', null, '🎉 All notes reviewed'),
    h('div', { class: 'hint' }, 'Your Sticky Notes are unchanged. Mochi only reads them, so finish up by hand:'),
    h('ol', { class: 'imp-steps' },
      h('li', null, 'Export a backup: ⋯ → 💾 Export backup'),
      h('li', null, 'Delete the notes with passwords inside Sticky Notes (Win+Alt+S)'),
      h('li', null, 'Delete the copies in your LINE chats'),
      h('li', null, 'Change the passwords that were exposed, PROD first')),
    h('div', { class: 'actions' },
      h('button', { class: 'btn ghost left', onclick: async () => { await api.sticky.reset(); importer.notes = null; openImport(); } }, 'Start over'),
      h('button', { class: 'btn', onclick: endImport }, 'Done')),
  );
}

// ---------- mascots ----------
function bounceMascot() {
  const el = $('#mini');
  el.classList.remove('bounce');
  void el.offsetWidth; // Restarts the animation if it is already running.
  el.classList.add('bounce');
  clearTimeout(state.bounceTimer);
  state.bounceTimer = setTimeout(() => el.classList.remove('bounce'), BOUNCE_MS);
}

function setAsleep(asleep) {
  const el = $('#mini');
  const woke = el.classList.contains('asleep') && !asleep;
  el.classList.toggle('asleep', asleep);
  if (woke) bounceMascot();
}

function showThirsty(thirsty) {
  state.thirsty = thirsty;
  $('#mini').classList.toggle('thirsty', thirsty);
  $('#waterBtn').classList.toggle('hidden', !thirsty);
  updateBadge();
}

function onWaterDue({ message }) {
  showThirsty(true);
  bounceMascot();
  if (widgetOpen()) toast('💧 ' + message);
}

async function sipped() {
  await api.water.sip();
  onSipped();
}

function onSipped() {
  showThirsty(false);
  bounceMascot();
  toast('💧 Nice! See you next sip');
}

async function openWater() {
  const { minutes, message: saved } = await api.water.status();
  let chosen = minutes;
  const message = h('input', { class: 'field', value: saved, maxlength: 60, placeholder: 'What your mascot says' });
  const custom = h('input', { class: 'field', type: 'number', min: 5, max: 240, placeholder: 'Other (min)', value: WATER_CHOICES.includes(minutes) ? '' : minutes });
  const buttons = WATER_CHOICES.map((m) => h('button', { class: 'filter', onclick: () => { chosen = m; custom.value = ''; paint(); } }, m ? `${m} min` : 'Off'));
  const paint = () => buttons.forEach((b, i) => b.classList.toggle('active', !custom.value && WATER_CHOICES[i] === chosen));
  custom.addEventListener('input', paint);
  paint();
  const save = async () => {
    const r = await api.water.set(custom.value || chosen, message.value);
    if (!r.ok) { toast('⚠️ ' + r.error); return; }
    showThirsty(false);
    closeModal();
    toast(r.minutes ? `💧 Reminder every ${r.minutes} min` : '💧 Water reminder off');
  };
  openModal(
    h('h3', null, '💧 Water reminder'),
    h('div', { class: 'hint' }, 'Your mascot reminds you to take a sip. A few sips every 30 to 60 minutes is a common habit.'),
    h('div', { class: 'water-choices' }, buttons, custom),
    h('label', null, 'Your mascot says'),
    h('div', { class: 'water-say' }, message,
      h('button', { class: 'btn ghost', onclick: () => api.water.preview(message.value) }, 'Try it')),
    h('div', { class: 'actions' },
      h('button', { class: 'btn ghost', onclick: closeModal }, 'Cancel'),
      h('button', { class: 'btn', onclick: save }, 'Save')),
  );
}

function showMascot(m) {
  const img = $('.mascot-img');
  $('#mini').classList.toggle('picture', m.id !== 'mochi');
  if (m.dataUrl) img.src = m.dataUrl; else img.removeAttribute('src');
}

async function useMascot(id) {
  const r = await api.mascot.use(id);
  if (!r.ok) { toast('⚠️ ' + r.error); return; }
  showMascot(r);
  closeModal();
  setMini(true);
}

async function addMascots() {
  const r = await api.mascot.add();
  if (!r.ok) { if (!r.canceled) toast('⚠️ ' + r.error); return; }
  if (r.errors.length) toast('⚠️ ' + r.errors.join(' · '));
  if (r.added.length) useMascot(r.added[0]); else openMascots();
}

async function openMascots() {
  const { current, items } = await api.mascot.list();
  const tiles = [{ id: 'mochi' }, ...items].map((m) => {
    // Delete takes two clicks: ✕ then "Delete?".
    const del = m.id !== 'mochi' && h('button', { class: 'del', title: 'Delete this mascot' }, '✕');
    if (del) {
      del.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        if (!del.classList.contains('confirm')) { del.classList.add('confirm'); del.textContent = 'Delete?'; return; }
        const r = await api.mascot.remove(m.id);
        if (!r.ok) { toast('⚠️ ' + r.error); return; }
        showMascot(r.current);
        openMascots();
      });
    }
    return h('div', { class: 'mascot-tile' + (m.id === current ? ' selected' : ''), title: m.id === 'mochi' ? 'Mochi (built-in)' : m.id, onclick: () => useMascot(m.id) },
      m.id === 'mochi' ? h('span', { class: 'emoji' }, '🍡') : h('img', { src: m.dataUrl, alt: '' }),
      del);
  });
  openModal(
    h('h3', null, '🐾 Mascots'),
    h('div', { class: 'hint' }, 'Pick who sits on your desktop when the widget is shrunk. PNG, GIF or WebP with a transparent background looks best — animated GIFs move too!'),
    h('div', { class: 'mascot-grid' }, tiles),
    h('div', { class: 'actions' },
      h('button', { class: 'btn ghost', onclick: closeModal }, 'Close'),
      h('button', { class: 'btn', onclick: addMascots }, '+ Add mascot')),
  );
}

// ---------- shell ----------
function switchTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab').forEach((s) => s.classList.toggle('active', s.id === `tab-${tab}`));
  if (tab === 'keys') renderKeys();
  if (tab === 'links') { renderLinks(); checkLinks(); }
  if (tab === 'today') renderToday();
  if (tab === 'notes') renderNotes();
}

async function setMini(mini) {
  if (mini) hideToast();
  await api.win.mini(mini);
  $('#app').classList.toggle('hidden', mini);
  $('#mini').classList.toggle('hidden', !mini);
}

// The whole mochi is draggable; a press that barely moves counts as a click.
function wireMochi() {
  const el = $('#mini');
  let last = null;
  let moved = false;
  el.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    last = { x: ev.screenX, y: ev.screenY, startX: ev.screenX, startY: ev.screenY };
    moved = false;
    el.setPointerCapture(ev.pointerId);
  });
  el.addEventListener('pointermove', (ev) => {
    if (!last) return;
    if (!moved && Math.hypot(ev.screenX - last.startX, ev.screenY - last.startY) < 4) return;
    moved = true;
    el.classList.add('dragging');
    api.win.moveBy(ev.screenX - last.x, ev.screenY - last.y);
    last.x = ev.screenX;
    last.y = ev.screenY;
  });
  const end = () => {
    if (!last) return;
    last = null;
    el.classList.remove('dragging');
    if (moved) return;
    if (state.thirsty) sipped(); else setMini(false);
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', () => { last = null; el.classList.remove('dragging'); });
}

function wire() {
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  $('#miniBtn').addEventListener('click', () => setMini(true));
  wireMochi();
  $('#menuBtn').addEventListener('click', (ev) => { ev.stopPropagation(); $('#menu').classList.toggle('hidden'); });
  document.addEventListener('click', (ev) => { if (!ev.target.closest('#menu')) $('#menu').classList.add('hidden'); });
  document.querySelectorAll('#menu button').forEach((b) => b.addEventListener('click', () => onMenu(b.dataset.act)));
  $('#lockBtn').addEventListener('click', async () => {
    if (state.lock.unlocked) { await api.lock.lock(); return; }
    await withUnlock(() => api.lock.unlock());
  });
  $('#modal').addEventListener('mousedown', (ev) => { if (ev.target.id === 'modal') closeModal(); });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !$('#modal').classList.contains('hidden')) closeModal();
    if (ev.ctrlKey && ev.key.toLowerCase() === 'f') {
      ev.preventDefault();
      if (state.tab === 'links') $('#linkSearch').focus();
      else { switchTab('keys'); $('#search').focus(); }
    }
    if (ev.ctrlKey && ev.key.toLowerCase() === 'n') {
      ev.preventDefault();
      if (state.tab === 'notes') editNote(null);
      else if (state.tab === 'keys') editEntry(null);
      else if (state.tab === 'links') editProject(null);
    }
  });
  document.addEventListener('focusout', () => {
    setTimeout(() => {
      if (state.pendingNotesRender && !isEditingIn('#tab-today')) { state.pendingNotesRender = false; renderToday(); }
    }, 0);
  });

  api.lock.onChange(() => refreshLock());
  api.vpn.onStatus(showVpn);
  api.vpn.onMessage(onVpnMessage);
  api.win.onNotice(toast);
  api.win.onIdle(setAsleep);
  api.water.onDue(onWaterDue);
  api.water.onSipped(onSipped);
  $('#waterBtn').addEventListener('click', sipped);
  api.links.onStatus(onLinkStatus);
  $('#vpnPill').addEventListener('click', openFortiClient);
  api.notes.onChange((doc) => {
    state.doc = doc;
    updateBadge();
    renderToday();
    renderNotes();
    renderLinks();
    if (state.tab === 'links') checkLinks();
  });
}

async function init() {
  wire();
  showMascot(await api.mascot.current());
  showVpn(await api.vpn.status());
  showAutostart((await api.win.autostart()).on);
  const { mini, name } = await api.win.state();
  showName(name);
  $('#app').classList.toggle('hidden', mini);
  $('#mini').classList.toggle('hidden', !mini);
  state.doc = await api.notes.get();
  updateBadge();
  await refreshLock();
  await loadEntries();
  renderLinks();
  renderToday();
  renderNotes();
}

init();
