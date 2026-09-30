'use strict';
/* =========================================================================
   BizOrganiser — core: storage, utilities, UI helpers, router, shell
   ========================================================================= */

/* ---------- server connection & sync ----------
   The browser keeps a working copy of the data (`db`). Every change is
   detected by comparing records with the last version the server confirmed,
   and sent to /api/sync with that version (optimistic concurrency). Changes
   made by other users arrive through /api/changes polling.                  */
let db = null;
const SYNC_COLS = ['customers', 'suppliers', 'products', 'supplierPrices', 'priceLists', 'reps', 'activities', 'quotes', 'orders',
  'workOrders', 'deliveries', 'invoices', 'purchaseOrders', 'bills', 'emails', 'stockMoves', 'rfqs'];
const SYNC = { snap: new Map(), vers: new Map(), seq: 0, polls: 0, timer: null, inflight: null, me: null, integrations: {}, state: 'ok' };
const keyOf = (col, id) => col + '/' + id;

async function api(path, { method = 'GET', body, raw } = {}) {
  const opts = { method, headers: { 'X-Requested-With': 'BizOrganiser' }, credentials: 'same-origin' };
  if (raw) { opts.body = raw; opts.headers['Content-Type'] = raw.type || 'application/octet-stream'; }
  else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  let res;
  try { res = await fetch(path, opts); } catch (e) { const err = new Error('Cannot reach the server — check your connection.'); err.status = 0; throw err; }
  const data = (res.headers.get('content-type') || '').includes('json') ? await res.json().catch(() => null) : null;
  if (!res.ok) {
    const e = new Error(data?.error || `Server error (HTTP ${res.status})`); e.status = res.status; e.data = data;
    if (res.status === 401 && path !== '/api/login' && path !== '/api/me') showLogin('Your session has ended. Please sign in again.');
    throw e;
  }
  return data;
}
function takeSnapshot() {
  SYNC.snap.clear();
  for (const col of SYNC_COLS) for (const r of db[col]) SYNC.snap.set(keyOf(col, r.id), JSON.stringify(r));
  SYNC.snap.set('settings/settings', JSON.stringify(db.settings));
}
function computeDiff() {
  const changes = [], alive = new Set();
  const add = (col, id, data) => {
    const k = keyOf(col, id); alive.add(k);
    const json = JSON.stringify(data);
    if (SYNC.snap.get(k) !== json) changes.push({ col, id, data, base: SYNC.vers.get(k) || 0, json });
  };
  for (const col of SYNC_COLS) for (const r of db[col]) if (r && r.id) add(col, r.id, r);
  if (me().role === 'admin') add('settings', 'settings', db.settings);
  else alive.add('settings/settings');
  for (const k of SYNC.snap.keys()) {
    if (alive.has(k)) continue;
    const i = k.indexOf('/');
    changes.push({ col: k.slice(0, i), id: k.slice(i + 1), data: null, base: SYNC.vers.get(k) || 0, json: null });
  }
  return changes;
}
function localSet(col, data) {
  if (col === 'settings') { db.settings = data; return; }
  const i = db[col].findIndex(r => r.id === data.id);
  if (i >= 0) db[col][i] = data; else db[col].push(data);
}
function localRemove(col, id) { if (db[col]) db[col] = db[col].filter(r => r.id !== id); }
/** Apply a server copy of a record (after conflicts, integrations or feed). */
function applyServerRecord(col, id, data, version) {
  const k = keyOf(col, id);
  if (version) SYNC.vers.set(k, version);
  if (data == null) { localRemove(col, id); SYNC.snap.delete(k); }
  else { localSet(col, data); SYNC.snap.set(k, JSON.stringify(data)); }
  if (ED && ED.doc.id === id && !ED.dirty) ED.doc = clone(data || ED.doc);
}
function setSyncState(state, msg = '') {
  SYNC.state = state;
  const el = document.getElementById('sync-state'); if (!el) return;
  el.className = 'sync ' + state;
  el.textContent = { ok: '● Saved', saving: '● Saving…', error: '● Not saved' }[state];
  el.title = msg || (state === 'error' ? 'Changes are kept in this tab and retried automatically.' : '');
}
function saveDB() { setSyncState('saving'); clearTimeout(SYNC.timer); SYNC.timer = setTimeout(syncNow, 120); }
/** Push local changes now; resolves when the server has answered. */
async function syncNow() {
  clearTimeout(SYNC.timer);
  while (SYNC.inflight) await SYNC.inflight;
  const changes = computeDiff();
  if (!changes.length) { setSyncState('ok'); return true; }
  setSyncState('saving');
  let ok = false;
  SYNC.inflight = (async () => {
    try {
      const r = await api('/api/sync', { method: 'POST', body: { changes: changes.map(({ json, ...c }) => c) } });
      const sent = new Map(changes.map(c => [keyOf(c.col, c.id), c]));
      let redraw = false;
      for (const a of r.applied) {
        const k = keyOf(a.col, a.id); SYNC.vers.set(k, a.version);
        if (a.deleted) { SYNC.snap.delete(k); continue; }
        if (a.data) { applyServerRecord(a.col, a.id, a.data, a.version); redraw = true; continue; }
        const c = sent.get(k);
        if (c.json === null) SYNC.snap.delete(k); else SYNC.snap.set(k, c.json);
      }
      for (const c of r.conflicts) { applyServerRecord(c.col, c.id, c.data, c.version); redraw = true; }
      const why = r.rejected.map(x => x.reason).filter((v, i, a) => a.indexOf(v) === i);
      if (why.length) toast(why.join(' · '), 'err');
      else if (r.conflicts.length) toast(`${r.conflicts.length} record(s) were changed by someone else — reloaded the latest version`, 'warn');
      if (r.counters) db.counters = r.counters;
      setSyncState('ok'); ok = true;
      if (redraw) rerenderSafe();
    } catch (e) {
      setSyncState('error', e.message);
      if (e.status !== 401) SYNC.timer = setTimeout(syncNow, 5000);
    }
  })();
  await SYNC.inflight; SYNC.inflight = null;
  return ok;
}
async function pollChanges() {
  if (document.hidden || !db || SYNC.inflight) return;
  try {
    const r = await api('/api/changes?since=' + SYNC.seq + (++SYNC.polls % 8 === 0 ? '&users=1' : ''));
    let changed = false;
    for (const c of r.changes) {
      const k = keyOf(c.col, c.id);
      if ((SYNC.vers.get(k) || 0) >= c.version) continue;
      if (c.col === 'counters') { db.counters = c.data || db.counters; SYNC.vers.set(k, c.version); continue; }
      if (!SYNC_COLS.includes(c.col) && c.col !== 'settings') continue;
      const local = c.col === 'settings' ? db.settings : byId(c.col, c.id);
      if ((local ? JSON.stringify(local) : undefined) !== SYNC.snap.get(k)) continue; // unsent local edit: the next sync resolves it
      applyServerRecord(c.col, c.id, c.deleted ? null : c.data, c.version);
      changed = true;
    }
    if (r.users) db.users = r.users;
    SYNC.seq = r.seq;
    if (SYNC.state === 'error') syncNow();
    if (changed) rerenderSafe();
  } catch { /* offline: try again next tick */ }
}
/** Re-render unless the user is in the middle of typing or has a dialog open. */
function rerenderSafe() {
  const a = document.activeElement;
  const typing = a && a.closest?.('#view') && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName);
  if (document.getElementById('modal-root').innerHTML || typing) { SYNC.pendingRender = true; return; }
  render();
}
async function loadData() {
  const d = await api('/api/data');
  db = { version: 1, settings: d.settings, counters: d.counters || {}, users: d.users, session: { userId: d.me.id } };
  for (const c of SYNC_COLS) db[c] = d[c] || [];
  SYNC.vers = new Map(Object.entries(d.versions || {}));
  SYNC.seq = d.seq; SYNC.me = d.me; SYNC.integrations = d.integrations || {}; SYNC.maxUpload = d.limits?.maxUpload || 25 * 1024 * 1024;
  if (!db.users.some(u => u.id === d.me.id)) db.users.push(d.me);
  takeSnapshot();
}
/** Upload one file to the server; returns {id, name, size, type}. */
function uploadFile(file) {
  return api('/api/files?name=' + encodeURIComponent(file.name), { method: 'POST', raw: file });
}

/* ---------- utilities ---------- */
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const clone = o => JSON.parse(JSON.stringify(o));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sum = (arr, f = x => x) => arr.reduce((a, x) => a + (+f(x) || 0), 0);
const round2 = n => Math.round((+n || 0) * 100) / 100;
const money = n => new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(+n || 0);
const num = (n, d = 0) => new Intl.NumberFormat('en-IE', { maximumFractionDigits: d }).format(+n || 0);
const pct = n => (Number.isFinite(n) ? n.toFixed(1) : '0.0') + '%';

const pad = n => String(n).padStart(2, '0');
const isoOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseD = s => { const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return new Date(y, (m || 1) - 1, d || 1); };
const today = () => isoOf(new Date());
const addDays = (s, n) => { const d = parseD(s); d.setDate(d.getDate() + n); return isoOf(d); };
const daysBetween = (a, b) => Math.round((parseD(b) - parseD(a)) / 86400000);
const fmtDate = s => s ? parseD(s).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
const fmtDateTime = s => s ? new Date(s).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';

function lastMonths(n) {
  const out = []; const d = new Date(); d.setDate(1);
  for (let i = n - 1; i >= 0; i--) {
    const x = new Date(d.getFullYear(), d.getMonth() - i, 1);
    out.push({ key: `${x.getFullYear()}-${pad(x.getMonth() + 1)}`, label: x.toLocaleDateString('en-GB', { month: 'short' }) });
  }
  return out;
}
function groupBy(arr, f) {
  const m = new Map();
  for (const x of arr) { const k = f(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }
  return m;
}
const byId = (col, id) => (db[col] || []).find(x => x.id === id);
const nameOf = (col, id, fb = '—') => byId(col, id)?.name ?? fb;

function nextNo(key) {
  const p = db.settings.prefixes[key] || key.toUpperCase();
  db.counters[key] = (db.counters[key] || 0) + 1;
  return `${p}-${String(db.counters[key]).padStart(4, '0')}`;
}

/* ---------- business helpers ---------- */
function priceFor(customer, product) {
  if (!product) return 0;
  const pl = customer && byId('priceLists', customer.priceListId);
  if (pl) {
    const ov = (pl.overrides || []).find(o => o.productId === product.id);
    if (ov) return round2(ov.price);
    return round2(product.price * (1 - (+pl.discount || 0) / 100));
  }
  return round2(product.price);
}
const lineNet = l => round2((+l.qty || 0) * (+l.price || 0) * (1 - (+l.discount || 0) / 100));
function totals(lines) {
  const net = round2(sum(lines, lineNet));
  const cost = round2(sum(lines, l => (+l.qty || 0) * (+l.unitCost || 0)));
  const vat = round2(net * db.settings.vatRate / 100);
  return { net, vat, total: round2(net + vat), cost, margin: round2(net - cost), marginPct: net ? (net - cost) / net * 100 : 0 };
}
function applyStock(lines, sign, ref) {
  for (const l of lines) {
    const p = byId('products', l.productId);
    if (!p || p.kind === 'service' || !(+l.qty)) continue;
    p.stock = round2(p.stock + sign * (+l.qty));
    db.stockMoves.unshift({ id: uid(), productId: p.id, qty: sign * (+l.qty), reason: ref || '', date: new Date().toISOString() });
  }
}
const paidOf = inv => round2(sum(inv.payments || [], p => p.amount));
const isCredit = inv => inv.type === '5.1';
/** Credit notes issued against an invoice (not cancelled). */
const creditsOf = inv => (db.invoices || []).filter(c => c.creditOf === inv.id && !c.cancelled);
const creditedOf = inv => round2(sum(creditsOf(inv), c => c.total));
const balanceOf = inv => isCredit(inv) || inv.cancelled ? 0 : round2(inv.total - paidOf(inv) - creditedOf(inv));
/** Signed amounts: credit notes reduce revenue. */
const invNet = inv => (isCredit(inv) ? -1 : 1) * (+inv.net || 0);
const invCost = inv => (isCredit(inv) ? -1 : 1) * (+inv.cost || 0);
const invVat = inv => (isCredit(inv) ? -1 : 1) * (+inv.vat || 0);
function invStatus(inv) {
  if (inv.cancelled) return 'cancelled';
  if (isCredit(inv)) return 'credit';
  const bal = balanceOf(inv);
  if (bal <= 0.005) return 'paid';
  if (inv.dueDate && inv.dueDate < today()) return 'overdue';
  return paidOf(inv) > 0 ? 'partial' : 'unpaid';
}

/* ---------- email (simulated outbox) ---------- */
const fillTpl = (s, vars) => String(s).replace(/\{\{(\w+)\}\}/g, (m, k) => vars[k] ?? m);
function logEmail(e) {
  const rec = { id: uid(), date: new Date().toISOString(), from: db.settings.company.email, ...e, status: 'queued' };
  db.emails.unshift(rec);
  return rec;
}
function autoEmail(key, to, vars, ref, customerId) {
  if (!db.settings.automations[key]) return false;
  return sendTemplate(key, to, vars, ref, customerId);
}
function sendTemplate(key, to, vars, ref, customerId) {
  const t = db.settings.templates[key]; if (!t) return false;
  vars = { company: db.settings.company.name, ...vars };
  logEmail({ to, subject: fillTpl(t.subject, vars), body: fillTpl(t.body, vars), ref, auto: true, template: key, customerId });
  return true;
}

/* ---------- users & roles ---------- */
const ROLES = {
  admin: { label: 'Administrator', pages: '*' },
  sales: { label: 'Sales', pages: ['dashboard', 'calendar', 'customers', 'quotes', 'orders', 'reps', 'deliveries', 'products', 'reports', 'pricelists', 'portal', 'outbox'] },
  production: { label: 'Production', pages: ['dashboard', 'calendar', 'orders', 'production', 'deliveries', 'products', 'suppliers', 'purchasing'] },
  accounting: { label: 'Accounting', pages: ['dashboard', 'calendar', 'customers', 'orders', 'invoices', 'suppliers', 'purchasing', 'reps', 'reports', 'outbox'] },
};
const me = () => byId('users', db.session.userId) || db.users[0];
function can(page) { const r = ROLES[me().role] || ROLES.sales; return r.pages === '*' || r.pages.includes(page); }

/* ---------- status labels ---------- */
const STATUS = {
  draft: 'Draft', sent: 'Sent', accepted: 'Accepted', rejected: 'Rejected', converted: 'Converted',
  pending: 'Awaiting confirmation', new: 'New', production: 'In production', ready: 'Ready', shipped: 'Shipped',
  delivered: 'Delivered', cancelled: 'Cancelled', received: 'Received', todo: 'To do', progress: 'In progress', done: 'Done',
  paid: 'Paid', unpaid: 'Unpaid', partial: 'Partially paid', overdue: 'Overdue', transmitted: 'Transmitted',
  picked_up: 'Picked up', in_transit: 'In transit', awaiting: 'Awaiting reply', answered: 'Answered',
  credit: 'Credit note', queued: 'Sending…', simulated: 'Not sent (simulation)', failed: 'Failed',
};
const badge = s => `<span class="badge b-${esc(s)}">${esc(STATUS[s] || s)}</span>`;

/* ---------- UI: toast ---------- */
function toast(msg, kind = 'ok') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind; el.textContent = msg;
  document.getElementById('toast-root').appendChild(el);
  setTimeout(() => el.classList.add('out'), 2600);
  setTimeout(() => el.remove(), 3000);
  return false;
}

/* ---------- UI: modal ---------- */
let modalGen = 0;
function openModal(title, body, buttons = [{ label: 'Close' }], opts = {}) {
  const root = document.getElementById('modal-root');
  const gen = ++modalGen;
  root.innerHTML = `<div class="overlay"><div class="modal ${opts.wide ? 'wide' : ''}" role="dialog" aria-label="${esc(title)}">
    <header><h3>${esc(title)}</h3><button class="icon-btn" data-close aria-label="Close">&times;</button></header>
    <div class="modal-body">${body}</div>
    <footer>${buttons.map((b, i) => `<button class="btn ${b.primary ? 'primary' : ''} ${b.danger ? 'danger' : ''}" data-btn="${i}">${esc(b.label)}</button>`).join('')}</footer>
  </div></div>`;
  const close = () => { if (gen === modalGen) { closeModal(); opts.onClose?.(); } };
  root.querySelector('[data-close]').onclick = close;
  root.querySelector('.overlay').addEventListener('mousedown', e => { if (e.target.classList.contains('overlay')) close(); });
  buttons.forEach((b, i) => {
    root.querySelector(`[data-btn="${i}"]`).onclick = () => {
      if (b.onClick && b.onClick() === false) return;
      close();
    };
  });
  opts.onOpen?.(root);
  root.querySelector('input:not([type=hidden]),select,textarea')?.focus();
}
function closeModal() { document.getElementById('modal-root').innerHTML = ''; }
function confirmBox(msg, onYes, label = 'Confirm') {
  openModal('Please confirm', `<p>${esc(msg)}</p>`, [{ label: 'Cancel' }, { label, danger: true, onClick: onYes }]);
}

/* ---------- UI: forms ---------- */
const opt = (list, sel, { empty, label = x => x.name, value = x => x.id } = {}) =>
  (empty !== undefined ? `<option value="">${esc(empty)}</option>` : '') +
  list.map(x => `<option value="${esc(value(x))}" ${String(value(x)) === String(sel ?? '') ? 'selected' : ''}>${esc(label(x))}</option>`).join('');
const pairs = (list, label = x => x.name, empty) => [...(empty !== undefined ? [['', empty]] : []), ...list.map(x => [x.id, label(x)])];

function fieldHTML(f, v) {
  const id = 'f_' + f.name; v = v ?? f.default ?? '';
  let input;
  switch (f.type) {
    case 'select':
      input = `<select id="${id}">${f.options.map(([val, lab]) => `<option value="${esc(val)}" ${String(val) === String(v) ? 'selected' : ''}>${esc(lab)}</option>`).join('')}</select>`; break;
    case 'textarea':
      input = `<textarea id="${id}" rows="${f.rows || 3}">${esc(v)}</textarea>`; break;
    case 'checkbox':
      input = `<label class="chk"><input type="checkbox" id="${id}" ${v ? 'checked' : ''}> ${esc(f.hint || 'Yes')}</label>`; break;
    case 'image':
      input = `<div class="img-field"><img id="${id}_prev" src="${esc(v)}" ${v ? '' : 'hidden'} alt=""><input type="hidden" id="${id}" value="${esc(v)}">
        <input type="file" accept="image/*" onchange="pickImage(this,'${id}')"> <button type="button" class="btn sm" onclick="clearImage('${id}')">Remove</button></div>`; break;
    default:
      input = `<input id="${id}" type="${f.type || 'text'}" value="${esc(v)}" ${f.type === 'number' ? `step="${f.step || 'any'}"` : ''} ${f.list ? `list="${id}_dl"` : ''} ${f.placeholder ? `placeholder="${esc(f.placeholder)}"` : ''}>` +
        (f.list ? `<datalist id="${id}_dl">${f.list.map(x => `<option value="${esc(x)}">`).join('')}</datalist>` : '');
  }
  return `<div class="field ${f.full ? 'full' : ''}"><label for="${id}">${esc(f.label)}${f.required ? ' *' : ''}</label>${input}${f.help ? `<small>${esc(f.help)}</small>` : ''}</div>`;
}
function readForm(fields) {
  const o = {};
  for (const f of fields) {
    const el = document.getElementById('f_' + f.name); if (!el) continue;
    o[f.name] = f.type === 'checkbox' ? el.checked : f.type === 'number' ? (el.value === '' ? 0 : +el.value) : el.value.trim();
  }
  return o;
}
function openForm({ title, fields, values = {}, onSave, wide, extra = '', saveLabel = 'Save', buttons = [] }) {
  openModal(title, `<div class="form-grid">${fields.map(f => fieldHTML(f, values[f.name])).join('')}</div>${extra}`, [
    ...buttons, { label: 'Cancel' },
    {
      label: saveLabel, primary: true, onClick: () => {
        const data = readForm(fields);
        const miss = fields.find(f => f.required && (data[f.name] === '' || data[f.name] == null));
        if (miss) return toast(`${miss.label} is required`, 'err');
        return onSave(data);
      }
    }], { wide });
}
function pickImage(input, id) {
  const file = input.files[0]; if (!file) return;
  const img = new Image(); const reader = new FileReader();
  reader.onload = () => {
    img.onload = () => {
      const max = 320, s = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = img.width * s; c.height = img.height * s;
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const url = c.toDataURL('image/jpeg', 0.8);
      document.getElementById(id).value = url;
      const prev = document.getElementById(id + '_prev'); prev.src = url; prev.hidden = false;
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}
function clearImage(id) { document.getElementById(id).value = ''; document.getElementById(id + '_prev').hidden = true; }

/* ---------- UI: tables, tabs, charts ---------- */
function table(cols, rows, { empty = 'Nothing here yet.', href, id = '', foot = '' } = {}) {
  if (!rows.length) return `<div class="empty">${esc(empty)}</div>`;
  return `<div class="table-wrap"><table class="tbl" ${id ? `id="${id}"` : ''}>
    <thead><tr>${cols.map(c => `<th class="${c.cls || ''}">${esc(c.label)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(r => `<tr ${href ? `data-href="${esc(href(r))}" class="clickable"` : ''}>${cols.map(c => `<td class="${c.cls || ''}">${c.render(r)}</td>`).join('')}</tr>`).join('')}</tbody>
    ${foot}</table></div>`;
}
function filterRows(input, tableId) {
  const q = input.value.toLowerCase();
  document.querySelectorAll(`#${tableId} tbody tr`).forEach(tr => { tr.hidden = !tr.textContent.toLowerCase().includes(q); });
}
const searchBox = (tableId, ph = 'Filter…') => `<input class="filter" placeholder="${esc(ph)}" oninput="filterRows(this,'${tableId}')">`;
function tabs(base, items, active) {
  return `<nav class="tabs">${items.map(([k, label]) => `<a href="#/${base}${k ? '/' + k : ''}" class="${k === active ? 'active' : ''}">${esc(label)}</a>`).join('')}</nav>`;
}
function barChart(data, { fmt = money, h = 190 } = {}) {
  const max = Math.max(1, ...data.map(d => d.value));
  return `<div class="bars" style="height:${h}px">${data.map(d => `
    <div class="bar-col" title="${esc(d.label)}: ${esc(fmt(d.value))}">
      <div class="bar-val">${esc(shortMoney(d.value, fmt))}</div>
      <div class="bar-track"><div class="bar" style="height:${(d.value / max * 100).toFixed(1)}%"></div></div>
      <div class="bar-lab">${esc(d.label)}</div>
    </div>`).join('')}</div>`;
}
function shortMoney(v, fmt) {
  if (fmt !== money) return fmt(v);
  return v >= 1000 ? '€' + (v / 1000).toFixed(v >= 10000 ? 0 : 1) + 'k' : '€' + Math.round(v);
}
function hbars(data, { fmt = money } = {}) {
  if (!data.length) return `<div class="empty">No data for this period.</div>`;
  const max = Math.max(1, ...data.map(d => d.value));
  return `<div class="hbars">${data.map(d => `<div class="hbar-row"><span class="hbar-lab" title="${esc(d.label)}">${esc(d.label)}</span>
    <span class="hbar-track"><span class="hbar" style="width:${(d.value / max * 100).toFixed(1)}%"></span></span>
    <span class="hbar-val">${esc(fmt(d.value))}</span></div>`).join('')}</div>`;
}
const kpi = (label, value, sub = '', href = '') =>
  `<${href ? `a href="${href}"` : 'div'} class="kpi"><div class="kpi-label">${esc(label)}</div><div class="kpi-value">${value}</div>${sub ? `<div class="kpi-sub">${sub}</div>` : ''}</${href ? 'a' : 'div'}>`;
const card = (title, body, actions = '') => `<section class="card"><header><h2>${esc(title)}</h2><div class="card-actions">${actions}</div></header>${body}</section>`;

function downloadFile(name, content, type = 'text/plain') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function toCSV(rows) {
  return rows.map(r => r.map(v => { const s = String(v ?? ''); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(',')).join('\n');
}
function printHTML(html) {
  document.getElementById('print-area').innerHTML = html;
  window.print();
}

/* ---------- router ---------- */
const PAGES = {};
const page = (name, def) => { PAGES[name] = def; };
const go = path => { location.hash = '#/' + path; };
const UI = {}; // transient per-page UI state

const NAV = [
  ['Overview', [['dashboard', 'Dashboard'], ['calendar', 'Calendar']]],
  ['CRM & Sales', [['customers', 'Customers'], ['quotes', 'Quotes'], ['orders', 'Orders'], ['reps', 'Sales reps']]],
  ['Operations', [['production', 'Production'], ['deliveries', 'Deliveries'], ['products', 'Products & stock']]],
  ['Purchasing', [['suppliers', 'Suppliers'], ['purchasing', 'Purchasing']]],
  ['Finance', [['invoices', 'Invoices'], ['reports', 'Reports']]],
  ['B2B Link', [['pricelists', 'Price lists'], ['portal', 'B2B portal ↗']]],
  ['System', [['outbox', 'Email outbox'], ['settings', 'Settings']]],
];

function parseHash() {
  const [, name = 'dashboard', ...params] = location.hash.split('/');
  return { name: name || 'dashboard', params: params.map(decodeURIComponent) };
}
function renderShell(active, params = []) {
  const pg = PAGES[active];
  const navKey = typeof pg?.nav === 'function' ? pg.nav(...params) : pg?.nav || active;
  document.getElementById('sidebar').innerHTML = `
    <div class="brand"><span class="logo">B</span><div><strong>BizOrganiser</strong><small>${esc(db.settings.company.name)}</small></div></div>
    ${NAV.map(([sec, items]) => {
      const vis = items.filter(([k]) => can(k));
      return vis.length ? `<div class="nav-sec">${esc(sec)}</div>${vis.map(([k, l]) => `<a href="#/${k}" class="${k === navKey ? 'active' : ''}">${esc(l)}</a>`).join('')}` : '';
    }).join('')}
    <div class="nav-foot">Signed in as ${esc(me().name)}</div>`;
  const u = me();
  document.getElementById('user-menu').innerHTML = `<span class="avatar">${esc(u.name.slice(0, 1))}</span> ${esc(u.name)} <small>${esc(ROLES[u.role]?.label || u.role)}</small>`;
  const due = db.activities.filter(a => !a.done && a.date <= today()).length;
  document.getElementById('bell').innerHTML = `<span class="bell-ico">&#128276;</span>${due ? `<span class="bell-n">${due}</span>` : ''}`;
}
function render() {
  const { name, params } = parseHash();
  const pg = PAGES[name] || PAGES.dashboard;
  const permKey = pg.perm ? pg.perm(...params) : (typeof pg.nav === 'string' ? pg.nav : name);
  document.body.classList.toggle('portal-mode', name === 'portal');
  document.body.classList.remove('nav-open');
  renderShell(PAGES[name] ? name : 'dashboard', params);
  const view = document.getElementById('view');
  if (!can(permKey)) {
    document.getElementById('page-title').textContent = 'No access';
    view.innerHTML = `<div class="empty-state"><h2>No access</h2><p>The <b>${esc(ROLES[me().role].label)}</b> role can't open this page. Ask an administrator if you need access.</p></div>`;
    return;
  }
  document.getElementById('page-title').textContent = typeof pg.title === 'function' ? pg.title(...params) : pg.title;
  try {
    view.innerHTML = pg.render(...params);
    pg.after?.(...params);
  } catch (e) {
    console.error(e);
    view.innerHTML = `<div class="empty-state"><h2>Something went wrong</h2><pre>${esc(e.stack || e.message)}</pre></div>`;
  }
}
const rerender = render;
const notFound = () => `<div class="empty-state"><h2>Not found</h2><p>This record doesn't exist (it may have been deleted).</p></div>`;

/* ---------- global search ---------- */
function globalSearch(q) {
  q = q.trim().toLowerCase();
  const box = document.getElementById('gsearch-results');
  if (q.length < 2) { box.innerHTML = ''; box.hidden = true; return; }
  const hits = [];
  const add = (type, label, sub, href, perm) => { if (can(perm)) hits.push({ type, label, sub, href }); };
  db.customers.filter(c => (c.name + ' ' + c.vat + ' ' + c.email).toLowerCase().includes(q)).slice(0, 5).forEach(c => add('Customer', c.name, c.city, `customer/${c.id}`, 'customers'));
  db.quotes.filter(x => x.number.toLowerCase().includes(q)).slice(0, 3).forEach(x => add('Quote', x.number, nameOf('customers', x.customerId), `edit/quote/${x.id}`, 'quotes'));
  db.orders.filter(x => x.number.toLowerCase().includes(q)).slice(0, 3).forEach(x => add('Order', x.number, nameOf('customers', x.customerId), `edit/order/${x.id}`, 'orders'));
  db.invoices.filter(x => x.number.toLowerCase().includes(q)).slice(0, 3).forEach(x => add('Invoice', x.number, nameOf('customers', x.customerId), `invoice/${x.id}`, 'invoices'));
  db.products.filter(p => (p.name + ' ' + p.sku).toLowerCase().includes(q)).slice(0, 4).forEach(p => add('Product', p.name, p.sku, 'products', 'products'));
  db.suppliers.filter(s => s.name.toLowerCase().includes(q)).slice(0, 3).forEach(s => add('Supplier', s.name, s.city || '', `supplier/${s.id}`, 'suppliers'));
  box.hidden = false;
  box.innerHTML = hits.length ? hits.map(h => `<a href="#/${h.href}"><span class="tag">${h.type}</span> ${esc(h.label)} <small>${esc(h.sub || '')}</small></a>`).join('') : `<div class="empty sm">No results</div>`;
}

/* ---------- login, password, user menu ---------- */
function authScreen(title, body) {
  document.getElementById('app').hidden = true;
  let el = document.getElementById('auth-root');
  if (!el) { el = document.createElement('div'); el.id = 'auth-root'; document.body.appendChild(el); }
  el.innerHTML = `<div class="auth"><form class="auth-card" id="auth-form" autocomplete="on"><div class="brand"><span class="logo">B</span><div><strong>BizOrganiser</strong><small>${esc(title)}</small></div></div>${body}<p class="auth-err text-bad" id="auth-err"></p></form></div>`;
  el.querySelector('input')?.focus();
  return el.querySelector('form');
}
function showLogin(msg = '') {
  if (document.getElementById('auth-form')?.dataset.kind === 'login') return;
  const f = authScreen('Sign in', `${msg ? `<p class="note">${esc(msg)}</p>` : ''}
    <div class="field"><label for="l_email">Email</label><input id="l_email" type="email" autocomplete="username" required></div>
    <div class="field"><label for="l_pw">Password</label><input id="l_pw" type="password" autocomplete="current-password" required></div>
    <button class="btn primary">Sign in</button>`);
  f.dataset.kind = 'login';
  f.onsubmit = async e => {
    e.preventDefault();
    try { await api('/api/login', { method: 'POST', body: { email: f.querySelector('#l_email').value, password: f.querySelector('#l_pw').value } }); location.reload(); }
    catch (err) { document.getElementById('auth-err').textContent = err.message; }
  };
}
function passwordFields() {
  return `<div class="field"><label for="p_cur">Current password</label><input id="p_cur" type="password" autocomplete="current-password" required></div>
    <div class="field"><label for="p_new">New password</label><input id="p_new" type="password" autocomplete="new-password" required minlength="10"><small>At least 10 characters, with letters and numbers.</small></div>
    <div class="field"><label for="p_new2">Repeat new password</label><input id="p_new2" type="password" autocomplete="new-password" required></div>`;
}
async function submitPassword() {
  const v = id => document.getElementById(id).value;
  if (v('p_new') !== v('p_new2')) throw new Error('The new passwords do not match.');
  await api('/api/me/password', { method: 'POST', body: { current: v('p_cur'), password: v('p_new') } });
}
function showPasswordChange(user) {
  const f = authScreen('Choose a new password', `<p class="note">Welcome, ${esc(user.name)}. Please replace your temporary password before you continue.</p>${passwordFields()}
    <div class="btn-row"><button class="btn primary">Save password</button><button type="button" class="btn" onclick="logout()">Sign out</button></div>`);
  f.onsubmit = async e => {
    e.preventDefault();
    try { await submitPassword(); location.reload(); }
    catch (err) { document.getElementById('auth-err').textContent = err.message; }
  };
}
async function logout() {
  if (db) await syncNow().catch(() => {});
  try { await api('/api/logout', { method: 'POST' }); } catch { /* ignore */ }
  location.href = '/';
}
function userMenu() {
  const u = me();
  openModal('Your account', `<dl class="dl"><dt>Name</dt><dd>${esc(u.name)}</dd><dt>Email</dt><dd>${esc(u.email)}</dd><dt>Role</dt><dd>${esc(ROLES[u.role]?.label || u.role)}</dd></dl>
    <h4>Change password</h4><div class="form-grid">${passwordFields()}</div>`, [
    { label: 'Sign out', danger: true, onClick: () => { logout(); } },
    { label: 'Close' },
    {
      label: 'Change password', primary: true, onClick: () => {
        submitPassword().then(() => { closeModal(); toast('Password changed'); }).catch(e => toast(e.message, 'err'));
        return false;
      },
    },
  ]);
}

/* ---------- boot ---------- */
async function boot() {
  let user;
  try { user = (await api('/api/me')).user; }
  catch (e) { if (e.status === 401) return showLogin(); return fatal(e); }
  if (user.mustChange) return showPasswordChange(user);
  if (user.role === 'customer') { location.href = '/b2b/'; return; }
  try { await loadData(); } catch (e) { return fatal(e); }
  window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });
  document.addEventListener('click', e => {
    const tr = e.target.closest('[data-href]');
    if (tr && !e.target.closest('button,a,input,select,textarea,label')) go(tr.dataset.href);
    if (!e.target.closest('.search-wrap')) { const b = document.getElementById('gsearch-results'); b.hidden = true; }
  });
  // re-render postponed while the user was typing or had a dialog open
  const flushRender = () => { if (SYNC.pendingRender) { SYNC.pendingRender = false; rerenderSafe(); } };
  document.addEventListener('focusout', () => setTimeout(flushRender, 50));
  new MutationObserver(() => { if (!document.getElementById('modal-root').innerHTML) flushRender(); })
    .observe(document.getElementById('modal-root'), { childList: true });
  document.getElementById('user-menu').onclick = userMenu;
  const gs = document.getElementById('gsearch');
  gs.oninput = () => globalSearch(gs.value);
  gs.onfocus = () => globalSearch(gs.value);
  document.getElementById('gsearch-results').addEventListener('click', () => { gs.value = ''; document.getElementById('gsearch-results').hidden = true; });
  window.addEventListener('beforeunload', e => {
    if (SYNC.state !== 'ok' || computeDiff().length) { syncNow(); e.preventDefault(); e.returnValue = ''; }
  });
  setInterval(pollChanges, 8000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pollChanges(); });
  render();
}
function fatal(e) {
  document.getElementById('view').innerHTML = `<div class="empty-state"><h2>Can't load BizOrganiser</h2><p>${esc(e.message)}</p><button class="btn primary" onclick="location.reload()">Try again</button></div>`;
}
