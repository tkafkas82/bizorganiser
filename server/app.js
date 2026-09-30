'use strict';
/* =========================================================================
   BizOrganiser application: REST/JSON API under /api.

   Runs in two ways with the same code:
     - locally / on a VM:  server/server.js (also serves ./public)
     - on Vercel:          api/index.js (Vercel serves ./public itself)
   Data lives in libSQL: a local SQLite file or Turso (see db.js).
   ========================================================================= */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { openDatabase, initSchema } = require('./db');
const { Store, COLLECTIONS, NUMBERED } = require('./store');
const { Auth, randomPassword, verifyPassword, httpError, STAFF_ROLES } = require('./auth');
const mail = require('./mail');
const mydata = require('./mydata');
const couriers = require('./couriers');

const ROOT = path.resolve(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const DATA = path.resolve(process.env.BIZ_DATA_DIR || path.join(ROOT, 'data'));
const ON_VERCEL = !!process.env.VERCEL;
const MAX_UPLOAD = ON_VERCEL ? 4 * 1024 * 1024 : 25 * 1024 * 1024;   // Vercel limits request bodies to 4.5 MB

/* ---------- runtime settings (local file; on Vercel fixed) ---------- */
function runtimeConfig() {
  let file = {};
  try { file = JSON.parse(fs.readFileSync(path.join(DATA, 'config.json'), 'utf8')); } catch { /* none */ }
  return {
    host: process.env.HOST || file.host || '127.0.0.1',
    port: +(process.env.PORT || file.port || 8080),
    secureCookies: ON_VERCEL || !!file.secureCookies,
    trustProxy: ON_VERCEL || !!file.trustProxy,
    legacy: file,   // older versions kept integration settings here
  };
}
const RUNTIME = runtimeConfig();

/* ---------- integration settings: stored in the database, secrets encrypted ---------- */
const DEFAULT_INTEGRATIONS = {
  smtp: { host: '', port: 587, secure: false, user: '', pass: '', from: '' },
  mydata: { mode: 'simulate', userId: '', subscriptionKey: '' },
  couriers: couriers.DEFAULT_CONFIG,
};
const SECRET_PATHS = ['smtp.pass', 'mydata.subscriptionKey', ...couriers.SECRET_PATHS];
const MASK = '********';
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
function deepMerge(base, over) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(over || {})) out[k] = isObj(v) && isObj(base?.[k]) ? deepMerge(base[k], v) : v;
  return out;
}
const getPath = (o, p) => p.split('.').reduce((a, k) => a?.[k], o);
const setPath = (o, p, v) => { const ks = p.split('.'); const last = ks.pop(); ks.reduce((a, k) => (a[k] = a[k] || {}), o)[last] = v; };
const SECRET_KEY = process.env.BIZ_SECRET_KEY ? crypto.createHash('sha256').update(process.env.BIZ_SECRET_KEY).digest() : null;
function seal(obj) {
  const s = JSON.stringify(obj);
  if (!SECRET_KEY) return 'plain:' + s;
  const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', SECRET_KEY, iv);
  const enc = Buffer.concat([c.update(s, 'utf8'), c.final()]);
  return 'gcm:' + Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}
function unseal(v) {
  if (!v) return {};
  if (v.startsWith('plain:')) return JSON.parse(v.slice(6));
  if (!SECRET_KEY) throw httpError(500, 'The integration settings are encrypted: set the BIZ_SECRET_KEY environment variable.');
  const b = Buffer.from(v.slice(4), 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', SECRET_KEY, b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'));
}
async function getIntegrations() { return deepMerge(DEFAULT_INTEGRATIONS, unseal(await store.getMeta('integrations'))); }
async function saveIntegrations(cfg) { await store.setMeta('integrations', seal({ smtp: cfg.smtp, mydata: cfg.mydata, couriers: cfg.couriers })); }
function maskedConfig(cfg) {
  const c = JSON.parse(JSON.stringify({ smtp: cfg.smtp, mydata: cfg.mydata, couriers: cfg.couriers }));
  for (const p of SECRET_PATHS) if (getPath(c, p)) setPath(c, p, MASK);
  return c;
}
const integrationStatus = cfg => ({ email: cfg.smtp.host ? 'live' : 'simulate', mydata: cfg.mydata.mode, couriers: couriers.status(cfg.couriers) });

/* ---------- storage & auth ---------- */
const { client, where, remote } = openDatabase(DATA);
const store = new Store(client, PUB);
const S = store.S;                          // shared business helpers (core.js)
const auth = new Auth(store, { secureCookies: RUNTIME.secureCookies });
let setupProblem = '';

async function init() {
  await initSchema(client, remote);
  await store.loadAll();
  await firstRun();
  await ensureSettingsDefaults();
  if (!(await store.getMeta('integrations')) && isObj(RUNTIME.legacy.smtp)) {   // move settings from an older config.json
    await saveIntegrations(deepMerge(DEFAULT_INTEGRATIONS, RUNTIME.legacy));
  }
  if (ON_VERCEL && !SECRET_KEY) console.warn('BIZ_SECRET_KEY is not set: integration passwords are stored unencrypted in the database.');
}
let ready = null;
const ensureReady = () => (ready = ready || init().catch(e => { ready = null; throw e; }));

/** Add settings introduced by newer versions (templates, shop…) without touching existing values. */
async function ensureSettingsDefaults() {
  const def = S.defaultSettings();
  const fill = (a, b) => { let ch = false; for (const [k, v] of Object.entries(b)) { if (a[k] === undefined) { a[k] = JSON.parse(JSON.stringify(v)); ch = true; } else if (isObj(v) && isObj(a[k]) && k !== 'templates') ch = fill(a[k], v) || ch; } return ch; };
  const needs = (() => { const probe = JSON.parse(JSON.stringify(store.db.settings)); return fill(probe, def) || Object.keys(def.templates).some(k => !probe.templates[k]); })();
  if (!needs) return;
  await store.write('system', () => {
    const cur = store.db.settings; fill(cur, def);
    for (const [k, t] of Object.entries(def.templates)) if (!cur.templates[k]) cur.templates[k] = t;
  });
}

async function firstRun() {
  if (await store.get('select 1 x from users limit 1')) return;
  let pw = process.env.ADMIN_PASSWORD;
  if (!pw && ON_VERCEL) {
    setupProblem = 'Setup needed: add the ADMIN_EMAIL and ADMIN_PASSWORD environment variables in Vercel (Settings → Environment Variables), then redeploy.';
    console.error(setupProblem); return;
  }
  const generated = !pw; pw = pw || randomPassword();
  const adminEmail = (process.env.ADMIN_EMAIL || 'admin@demoprint.example').toLowerCase();
  let created = [];
  await store.write('system', async tx => {
    if (await store.get('select 1 x from users limit 1', [], tx)) return;   // another instance was faster
    const demo = store.isEmpty() && process.env.BIZ_DEMO !== '0';
    if (demo) store.setData(S.seedDB());
    const mk = (id, name, email, role, customerId) => auth.createUser({ id, name, email, role, customerId, password: pw, mustChange: true }, tx).then(u => created.push(u));
    await mk('u1', 'Admin User', adminEmail, 'admin');
    if (demo) {
      await mk('u2', 'Sofia (Sales)', 'sales@demoprint.example', 'sales');
      await mk('u3', 'Kostas (Production)', 'production@demoprint.example', 'production');
      await mk('u4', 'Anna (Accounting)', 'accounts@demoprint.example', 'accounting');
      const c = store.db.customers.find(x => x.id === 'c4') || store.db.customers[0];
      await mk(null, c.name + ' (portal)', 'portal@knossos.example', 'customer', c.id);
    }
  });
  if (!created.length) return;
  const list = created.map(u => `  ${u.role.padEnd(11)} ${u.email}`).join('\n');
  if (generated) {
    const text = `BizOrganiser — first-run credentials (${new Date().toISOString()})\n\nTemporary password for every account below: ${pw}\n` +
      `Each user must choose a new password at first login.\n\n${list}\n\nDelete this file after you have signed in.\n`;
    try { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(path.join(DATA, 'FIRST-RUN-CREDENTIALS.txt'), text, { mode: 0o600 }); } catch { /* read-only file system */ }
    console.log('\n' + text);
  } else console.log(`Created accounts (password from ADMIN_PASSWORD, must be changed at first sign-in):\n${list}`);
}

/* ---------- HTTP helpers ---------- */
const nowIso = () => new Date().toISOString();
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  // inline handlers are used by the UI, so 'unsafe-inline' is required for scripts
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  ...(RUNTIME.secureCookies ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
};
function send(res, status, body, headers = {}) { res.writeHead(status, { ...SEC_HEADERS, ...headers }); res.end(body); }
const json = (res, status, obj, headers = {}) => send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
function readBody(req, limit) {
  if (Buffer.isBuffer(req.rawBody)) { if (req.rawBody.length > limit) throw httpError(413, 'Request too large.'); return Promise.resolve(req.rawBody); }
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    let over = false;
    req.on('data', c => {
      if (over) return;                       // keep draining so the 413 answer can still be sent
      size += c.length;
      if (size > limit) { over = true; chunks.length = 0; reject(httpError(413, `Request too large (limit ${Math.round(limit / 1048576)} MB).`)); }
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJSON(req, limit = 5e6) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { throw httpError(400, 'Invalid JSON.'); }
}
function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
  return out;
}
const clientIp = req => (RUNTIME.trustProxy && (String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.headers['x-real-ip'])) || req.socket?.remoteAddress || '';
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);

/** Keep work going after the response on Vercel (waitUntil); run normally elsewhere. */
function later(promise) {
  promise.catch(e => console.error('background task failed:', e));
  if (ON_VERCEL) { try { require('@vercel/functions').waitUntil(promise); } catch { /* not available */ } }
}

/* ---------- email: claim, send, record (safe with several instances) ---------- */
let mailBusy = false;
async function pumpMail() {
  if (mailBusy) return; mailBusy = true;
  try {
    for (let round = 0; round < 20; round++) {
      const batch = await store.write('mailer', () => {
        const stale = Date.now() - 10 * 60e3;
        const list = store.db.emails.filter(e => e.status === 'queued' || (e.status === 'sending' && Date.parse(e.claimedAt || 0) < stale)).slice(0, 5);
        list.forEach(e => { e.status = 'sending'; e.claimedAt = nowIso(); });
        return list.map(e => ({ ...e }));
      });
      if (!batch.length) break;
      const cfg = await getIntegrations();
      const results = [];
      for (const e of batch) {
        if (!cfg.smtp.host) { results.push([e.id, { status: 'simulated', note: 'SMTP not configured — not delivered' }]); continue; }
        try {
          await mail.sendMail(cfg.smtp, { from: cfg.smtp.from || store.db.settings.company.email, to: e.to, subject: e.subject, text: e.body, replyTo: store.db.settings.company.email });
          results.push([e.id, { status: 'sent', sentAt: nowIso(), error: null }]);
        } catch (err) { results.push([e.id, { status: 'failed', error: err.message }]); }
      }
      await store.write('mailer', () => {
        for (const [id, patch] of results) {
          const e = store.byId('emails', id); if (!e) continue;
          Object.assign(e, patch); delete e.claimedAt; if (patch.error === null) delete e.error;
        }
      });
    }
  } finally { mailBusy = false; store.mailPending = false; }
}

/* ---------- sync (staff clients) ---------- */
const WRITE_RULES = { settings: ['admin'], priceLists: ['admin', 'sales'], reps: ['admin', 'sales', 'accounting'] };
const canWrite = (role, col) => (WRITE_RULES[col] || STAFF_ROLES).includes(role);
const DELIVERY_SERVER_FIELDS = ['tracking', 'courierRef', 'booked', 'booking', 'labelAvailable', 'courierMode', 'courierError', 'courierStatus', 'events', 'bookedAt'];
const EMAIL_SERVER_FIELDS = ['status', 'sentAt', 'error', 'note', 'claimedAt'];
const serverCopy = (col, id) => ({ col, id, version: store.version(col, id), data: col === 'settings' ? store.db.settings : (store.byId(col, id) || null) });

/** Server-side rules that protect legally or technically important fields. */
function guard(col, existing, rec) {
  if (col === 'invoices') {
    if (existing) {
      rec.mydata = existing.mydata;
      if (existing.mydata?.status === 'transmitted') {
        const changedCore = ['lines', 'net', 'vat', 'total', 'customerId', 'date', 'type', 'number'].some(k => JSON.stringify(existing[k]) !== JSON.stringify(rec[k]));
        if (changedCore) return { reject: 'Invoice is registered in myDATA and can no longer be changed — issue a credit note.' };
        if (rec.cancelled && !existing.cancelled) return { reject: 'A registered invoice cannot be cancelled — issue a credit note.' };
      }
    } else {
      rec.mydata = { status: 'pending' };
      if (rec.type === '5.1' && !store.byId('invoices', rec.creditOf)) return { reject: 'A credit note must refer to an existing invoice.' };
    }
  }
  if (col === 'emails') {
    if (existing) { for (const k of EMAIL_SERVER_FIELDS) { if (existing[k] === undefined) delete rec[k]; else rec[k] = existing[k]; } }
    else { for (const k of EMAIL_SERVER_FIELDS) delete rec[k]; rec.status = 'queued'; }
  }
  if (col === 'deliveries') {
    if (existing?.booked || existing?.booking) for (const k of DELIVERY_SERVER_FIELDS) { if (existing[k] === undefined) delete rec[k]; else rec[k] = existing[k]; }
    else if (!existing) { rec.booked = false; delete rec.booking; }
  }
  return { rec };
}
function deleteGuard(col, existing) {
  if (!existing) return '';
  if (col === 'invoices') return 'Invoices cannot be deleted — cancel them or issue a credit note.';
  if (col === 'deliveries' && existing.booked && existing.courierMode === 'live') return 'This shipment is booked with the courier and cannot be deleted.';
  return '';
}
function applySync(user, changes) {
  const db = store.db;
  const conflicts = [], rejected = [], applied = [];
  for (const ch of changes) {
    const { col, id } = ch || {};
    if (!(COLLECTIONS.includes(col) || col === 'settings')) { rejected.push({ col, id, reason: 'Unknown collection' }); continue; }
    if (typeof id !== 'string' || !/^[\w-]{1,64}$/.test(id)) { rejected.push({ col, id, reason: 'Invalid id' }); continue; }
    if (!canWrite(user.role, col)) { rejected.push({ col, id, reason: 'Your role cannot change this data' }); conflicts.push(serverCopy(col, id)); continue; }
    if ((+ch.base || 0) !== store.version(col, id)) { conflicts.push(serverCopy(col, id)); continue; }
    if (col === 'settings') { if (isObj(ch.data)) db.settings = ch.data; applied.push({ col, id }); continue; }
    const arr = db[col]; const idx = arr.findIndex(r => r.id === id); const existing = idx >= 0 ? arr[idx] : null;
    if (ch.data == null) {
      const why = deleteGuard(col, existing);
      if (why) { rejected.push({ col, id, reason: why }); conflicts.push(serverCopy(col, id)); continue; }
      if (idx >= 0) arr.splice(idx, 1);
      applied.push({ col, id }); continue;
    }
    if (!isObj(ch.data)) { rejected.push({ col, id, reason: 'Invalid record' }); continue; }
    const g = guard(col, existing, { ...ch.data, id });
    if (g.reject) { rejected.push({ col, id, reason: g.reject }); conflicts.push(serverCopy(col, id)); continue; }
    const rec = g.rec;
    if (!existing && NUMBERED[col]) rec.number = S.nextNo(NUMBERED[col]);    // server-side, gap-free numbering
    if (idx >= 0) arr[idx] = rec; else arr.push(rec);
    applied.push({ col, id, sent: JSON.stringify(ch.data) });
  }
  return { applied, conflicts, rejected };
}
function syncResponse(r) {
  return {
    applied: r.applied.map(a => {
      const cur = a.col === 'settings' ? store.db.settings : store.byId(a.col, a.id);
      const out = { col: a.col, id: a.id, version: store.version(a.col, a.id) };
      if (cur && a.sent && JSON.stringify(cur) !== a.sent) out.data = cur;   // server adjusted it (numbering, guards)
      if (!cur && a.col !== 'settings') out.deleted = true;
      return out;
    }),
    conflicts: r.conflicts, rejected: r.rejected, counters: store.db.counters,
  };
}

/* ---------- business operations run on the server ---------- */
function orderEmail(o) {
  const c = store.byId('customers', o.customerId); if (!c) return;
  S.autoEmail('orderConfirmed', c.email, { customer: c.name, number: o.number, total: S.money(o.total), date: S.fmtDate(o.dueDate) }, o.number, c.id);
}
function applyDeliveryStatus(d, status) {
  const FLOW = ['pending', 'picked_up', 'in_transit', 'delivered'];
  if (FLOW.indexOf(status) <= FLOW.indexOf(d.status)) return;
  d.status = status; (d.history = d.history || []).push({ status, at: nowIso() });
  const o = store.byId('orders', d.orderId); const c = store.byId('customers', d.customerId);
  if (o && !['shipped', 'delivered'].includes(o.status)) {
    o.status = 'shipped';
    if (c) S.autoEmail('orderShipped', c.email, { customer: c.name, number: o.number, courier: d.courier, tracking: d.tracking }, o.number, c.id);
  }
  if (status === 'delivered' && o) o.status = 'delivered';
}
function validateLines(lines, allowed) {
  if (!Array.isArray(lines) || !lines.length || lines.length > 100) throw httpError(400, 'Your cart is empty or too large.');
  return lines.map(l => {
    const p = allowed(String(l.productId));
    const qty = Math.round(+l.qty * 100) / 100;
    if (!p) throw httpError(400, 'A product in your cart is no longer available.');
    if (!(qty > 0 && qty <= 100000)) throw httpError(400, `Invalid quantity for ${p.name}.`);
    return { p, qty };
  });
}
function createOrder({ customer, lines, notes, paymentMethod, source, status, repId, userId }) {
  const t = S.today();
  const o = { id: S.uid(), number: S.nextNo('order'), customerId: customer.id, repId: repId || customer.repId || '', date: t, dueDate: S.addDays(t, 5), lines, notes, source, paymentMethod, status, ...S.totals(lines), createdBy: userId };
  S.applyStock(lines, -1, `${o.number} (${source})`);
  store.db.orders.push(o);
  return o;
}

/* ---------- rate limiting (database-backed, works across instances) ---------- */
async function rateLimit(key, max, windowMs) {
  const since = Date.now() - windowMs;
  const n = Number((await store.get('select count(*) n from rate_events where key = ? and at > ?', [key, since])).n);
  if (n >= max) return false;
  await store.run('insert into rate_events (key, at) values (?, ?)', [key, Date.now()]);
  return true;
}

/* ---------- e-shop (public) ---------- */
const shopSettings = () => store.db.settings.shop || {};
const grossPrice = p => p.eshopPrice ? S.round2(p.eshopPrice) : S.round2(p.price * (1 + store.db.settings.vatRate / 100));
function publicShop() {
  const sh = shopSettings(); const c = store.db.settings.company;
  const products = store.db.products.filter(p => p.eshop && p.kind !== 'material').map(p => ({
    id: p.id, sku: p.sku, name: p.name, category: p.category, unit: p.unit, description: p.description || '', image: p.image || '',
    price: grossPrice(p), availability: p.kind === 'service' ? 'available' : p.stock <= 0 ? 'out' : p.stock <= p.minStock ? 'low' : 'in',
  }));
  return {
    enabled: !!sh.enabled, title: sh.title || c.name, tagline: sh.tagline || '', heroTitle: sh.heroTitle || '', heroText: sh.heroText || '',
    accent: /^#[0-9a-f]{6}$/i.test(sh.accent || '') ? sh.accent : '#2458d6', logo: sh.logo || '', about: sh.about || '', terms: sh.terms || '',
    shippingFee: +sh.shippingFee || 0, freeShippingOver: +sh.freeShippingOver || 0, codFee: +sh.codFee || 0,
    payments: { cod: sh.payCod !== false, bank: sh.payBank !== false }, featured: sh.featured || [],
    company: { name: c.name, email: c.email, phone: c.phone, address: c.address, vat: c.vat, iban: c.iban }, vatRate: store.db.settings.vatRate,
    products: sh.enabled ? products : [],
  };
}
function placeShopOrder(body) {
  const sh = shopSettings();
  if (!sh.enabled) throw httpError(403, 'The shop is closed.');
  const cu = body.customer || {};
  const f = { name: str(cu.name, 120), email: str(cu.email, 160).toLowerCase(), phone: str(cu.phone, 40), address: str(cu.address, 200), city: str(cu.city, 80), postalCode: str(cu.postalCode, 12) };
  if (!f.name || !f.address || !f.city || !f.phone) throw httpError(400, 'Please fill in name, phone and delivery address.');
  if (!mail.isEmail(f.email)) throw httpError(400, 'Please enter a valid email address.');
  const pay = body.payment === 'bank' ? 'bank' : 'cod';
  if (pay === 'cod' && sh.payCod === false) throw httpError(400, 'Cash on delivery is not available.');
  if (pay === 'bank' && sh.payBank === false) throw httpError(400, 'Bank transfer is not available.');
  const vat = 1 + store.db.settings.vatRate / 100;
  const items = validateLines(body.lines, id => store.db.products.find(p => p.id === id && p.eshop && p.kind !== 'material'));
  const net4 = g => Math.round(g / vat * 10000) / 10000;
  const lines = items.map(({ p, qty }) => ({ productId: p.id, desc: p.name, qty, unitCost: p.cost, price: net4(grossPrice(p)), discount: 0 }));
  const goodsGross = items.reduce((a, { p, qty }) => a + grossPrice(p) * qty, 0);
  const ship = sh.freeShippingOver && goodsGross >= +sh.freeShippingOver ? 0 : +sh.shippingFee || 0;
  if (ship) lines.push({ productId: '', desc: 'Shipping', qty: 1, unitCost: 0, price: net4(ship), discount: 0 });
  if (pay === 'cod' && +sh.codFee) lines.push({ productId: '', desc: 'Cash on delivery fee', qty: 1, unitCost: 0, price: net4(+sh.codFee), discount: 0 });

  let customer = store.db.customers.find(c => (c.email || '').toLowerCase() === f.email && c.source === 'eshop');
  if (!customer) {
    customer = { id: S.uid(), name: f.name, vat: '', email: f.email, phone: f.phone, address: f.address, city: f.city, postalCode: f.postalCode, region: '', group: 'Retail', repId: '', priceListId: '', paymentTerms: 0, notes: 'Created by the e-shop', createdAt: S.today(), source: 'eshop' };
    store.db.customers.push(customer);
  } else {
    // anonymous input must not overwrite an existing record: only fill blanks (the order carries its own delivery details)
    for (const k of ['phone', 'address', 'city', 'postalCode']) if (!customer[k]) customer[k] = f[k];
  }
  const notes = [`E-shop order · ${f.name} · ${f.phone}`, `Deliver to: ${f.address}, ${f.postalCode} ${f.city}`, str(body.notes, 1000)].filter(Boolean).join('\n');
  const o = createOrder({ customer, lines, notes, paymentMethod: pay, source: 'eshop', status: 'new', userId: 'eshop' });
  orderEmail(o);
  S.autoEmail('eshopOrder', store.db.settings.company.email, { customer: customer.name, number: o.number, total: S.money(o.total) }, o.number);
  const c = store.db.settings.company;
  return { number: o.number, total: o.total, payment: pay, bank: pay === 'bank' ? { iban: c.iban, beneficiary: c.name, reference: o.number } : null };
}

/* ---------- B2B portal (customer logins) ---------- */
function portalCustomer(user) {
  const c = store.byId('customers', user.customer_id);
  if (!c) throw httpError(403, 'Your login is not linked to a customer account. Please contact us.');
  return c;
}
function portalBootstrap(user) {
  const c = portalCustomer(user);
  const products = store.db.products.filter(p => p.b2b && p.kind !== 'material').map(p => ({
    id: p.id, sku: p.sku, name: p.name, category: p.category, unit: p.unit, description: p.description || '', image: p.image || '', kind: p.kind,
    listPrice: p.price, price: S.priceFor(c, p),
    availability: p.kind === 'service' ? 'available' : p.stock <= 0 ? 'out' : p.stock <= p.minStock ? 'low' : 'in',
    stock: p.kind === 'service' ? null : Math.max(0, p.stock),
  }));
  const orders = store.db.orders.filter(o => o.customerId === c.id && o.status !== 'cancelled').sort((a, b) => b.date.localeCompare(a.date)).map(o => {
    const d = store.byId('deliveries', o.deliveryId);
    return { id: o.id, number: o.number, date: o.date, dueDate: o.dueDate, status: o.status, source: o.source, total: o.total, net: o.net, lines: o.lines.map(l => ({ productId: l.productId, desc: l.desc, qty: l.qty, price: l.price, discount: l.discount })), notes: o.notes, delivery: d ? { courier: d.courier, tracking: d.tracking, status: d.status } : null, preparedByRep: o.createdByRep ? S.nameOf('reps', o.createdByRep) : '' };
  });
  const invoices = store.db.invoices.filter(i => i.customerId === c.id && !i.cancelled).sort((a, b) => b.date.localeCompare(a.date)).map(i => ({
    id: i.id, number: i.number, type: i.type, date: i.date, dueDate: i.dueDate, net: i.net, vat: i.vat, total: i.total, balance: S.balanceOf(i), status: S.invStatus(i),
    lines: i.lines.map(l => ({ desc: l.desc, qty: l.qty, price: l.price, discount: l.discount })), mark: i.mydata?.mark || '', creditOf: i.creditOf || '',
  }));
  const co = store.db.settings.company;
  return {
    company: { name: co.name, email: co.email, phone: co.phone, address: co.address, vat: co.vat, taxOffice: co.taxOffice, iban: co.iban }, vatRate: store.db.settings.vatRate,
    customer: { id: c.id, name: c.name, vat: c.vat, email: c.email, phone: c.phone, address: c.address, city: c.city, paymentTerms: c.paymentTerms, priceList: S.nameOf('priceLists', c.priceListId, 'Standard') },
    products, orders, invoices,
  };
}
function portalPlaceOrder(user, body) {
  const c = portalCustomer(user);
  const items = validateLines(body.lines, id => store.db.products.find(p => p.id === id && p.b2b && p.kind !== 'material'));
  const lines = items.map(({ p, qty }) => ({ productId: p.id, desc: p.name, qty, unitCost: p.cost, price: S.priceFor(c, p), discount: 0 }));
  const ref = str(body.reference, 60);
  const notes = [ref && `Customer ref: ${ref}`, `Deliver to: ${str(body.address, 200) || c.address + ', ' + c.city}`, str(body.notes, 1000)].filter(Boolean).join('\n');
  const o = createOrder({ customer: c, lines, notes, paymentMethod: ['bank', 'card', 'cod', 'cash'].includes(body.paymentMethod) ? body.paymentMethod : 'bank', source: 'b2b', status: 'new', userId: user.id });
  S.autoEmail('b2bOrder', store.db.settings.company.email, { customer: c.name, number: o.number, total: S.money(o.total) }, o.number);
  orderEmail(o);
  return { number: o.number, total: o.total };
}
function portalConfirm(user, id) {
  const c = portalCustomer(user);
  const o = store.byId('orders', id);
  if (!o || o.customerId !== c.id) throw httpError(404, 'Order not found.');
  if (o.status !== 'pending') throw httpError(409, 'This order does not need confirmation.');
  o.status = 'new'; o.confirmedAt = nowIso(); orderEmail(o);
  return { ok: true };
}

/* ---------- files (stored in the database) ---------- */
const SAFE_INLINE = /^(image\/(png|jpeg|gif|webp)|application\/pdf)$/;
async function uploadFile(req, user, query) {
  const name = str(query.get('name') || 'file', 180).replace(/[\\/:*?"<>|\r\n]+/g, '_') || 'file';
  const type = str(req.headers['content-type'] || 'application/octet-stream', 100);
  const buf = await readBody(req, MAX_UPLOAD).catch(e => { if (e.status === 413) throw httpError(413, `Files can be at most ${Math.round(MAX_UPLOAD / 1048576)} MB.`); throw e; });
  const id = crypto.randomBytes(16).toString('hex');
  await store.batchWrite([
    { sql: 'insert into file_blobs (id, data) values (?, ?)', args: [id, new Uint8Array(buf)] },
    { sql: 'insert into files (id, name, size, type, created_at, created_by) values (?, ?, ?, ?, ?, ?)', args: [id, name, buf.length, type, nowIso(), user.id] },
  ]);
  return { id, name, size: buf.length, type };
}
async function serveFile(res, id) {
  if (!/^[0-9a-f]{32}$/.test(id)) throw httpError(404, 'Not found.');
  const f = await store.get('select f.name, f.type, b.data from files f join file_blobs b on b.id = f.id where f.id = ?', [id]);
  if (!f) throw httpError(404, 'File not found.');
  const body = Buffer.from(f.data);
  const inline = SAFE_INLINE.test(f.type);
  send(res, 200, body, { 'Content-Type': inline ? f.type : 'application/octet-stream', 'Content-Length': body.length, 'Cache-Control': 'private, max-age=3600',
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}` });
}

/* ---------- routes ---------- */
const routes = [];
const route = (method, pattern, access, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), access, fn });
const recOut = (col, id, key) => () => ({ [key]: store.byId(col, id), version: store.version(col, id) });

// auth
route('POST', '/api/login', 'public', async ({ req, res, body }) => {
  const { token, user } = await auth.login(body.email, body.password, clientIp(req));
  store.audit(user.id, 'login', clientIp(req));
  json(res, 200, { user }, { 'Set-Cookie': auth.cookie(token) });
});
route('POST', '/api/logout', 'public', async ({ req, res }) => { await auth.logout(cookies(req).sid); json(res, 200, { ok: true }, { 'Set-Cookie': auth.cookie('', 0) }); });
route('GET', '/api/me', 'any', async ({ res, user }) => json(res, 200, { user: auth.publicUser(user) }));
route('POST', '/api/me/password', 'any', async ({ req, res, user, body }) => {
  if (!verifyPassword(body.current, user.pass_hash)) throw httpError(400, 'Your current password is not correct.');
  if (body.current === body.password) throw httpError(400, 'Choose a password different from the current one.');
  await auth.setPassword(user.id, body.password);
  const { token } = await auth.createSession(await auth.getUser(user.id), clientIp(req));
  store.audit(user.id, 'password-change', '');
  json(res, 200, { ok: true }, { 'Set-Cookie': auth.cookie(token) });
});

// staff data
route('GET', '/api/data', 'staff', async ({ res, user }) => {
  await store.read();
  const [users, cfg] = await Promise.all([auth.listUsers(), getIntegrations()]);
  json(res, 200, { ...store.snapshot(), me: auth.publicUser(user), users: users.filter(u => u.role !== 'customer'), integrations: integrationStatus(cfg), limits: { maxUpload: MAX_UPLOAD } });
});
route('POST', '/api/sync', 'staff', async ({ res, user, body }) => {
  if (!Array.isArray(body.changes) || body.changes.length > 5000) throw httpError(400, 'Invalid change set.');
  json(res, 200, await store.write(user.id, () => applySync(user, body.changes), syncResponse));
});
route('GET', '/api/changes', 'staff', async ({ res, query }) => {
  const since = +query.get('since') || 0;
  const changes = await store.changesSince(since);
  const seq = changes.length ? changes[changes.length - 1].seq : Math.max(since, +(await store.getMeta('seq') || 0));
  json(res, 200, { changes, seq, users: query.get('users') ? (await auth.listUsers()).filter(u => u.role !== 'customer') : undefined });
});
route('GET', '/api/users', 'staff', async ({ res }) => json(res, 200, { users: await auth.listUsers() }));

// integrations (external calls happen outside the write lock; a "claim" prevents double submission)
route('POST', '/api/mydata/send', 'staff', async ({ res, user, body }) => {
  if (!['admin', 'accounting', 'sales'].includes(user.role)) throw httpError(403, 'Your role cannot send invoices to myDATA.');
  const id = str(body.invoiceId, 64);
  const claim = await store.write(user.id, () => {
    const inv = store.byId('invoices', id);
    if (!inv) throw httpError(404, 'Invoice not found.');
    if (inv.mydata?.status === 'transmitted') return null;
    if (inv.cancelled) throw httpError(400, 'Cancelled invoices are not sent to myDATA.');
    if (inv.mydata?.status === 'sending' && Date.now() - Date.parse(inv.mydata.claimedAt) < 120e3) throw httpError(409, 'This invoice is already being sent — try again in a minute.');
    inv.mydata = { ...(inv.mydata || {}), status: 'sending', claimedAt: nowIso() };
    return JSON.parse(JSON.stringify({ inv, customer: store.byId('customers', inv.customerId), original: inv.creditOf ? store.byId('invoices', inv.creditOf) : null, company: store.db.settings.company, vatRate: store.db.settings.vatRate, kinds: Object.fromEntries(store.db.products.map(p => [p.id, p.kind])) }));
  });
  let patch;
  if (claim) {
    try {
      const r = await mydata.send({ cfg: (await getIntegrations()).mydata, invoice: claim.inv, customer: claim.customer, company: claim.company, vatRate: claim.vatRate, original: claim.original, productKind: pid => claim.kinds[pid] });
      patch = { status: 'transmitted', mark: r.mark, uid: r.uid, qrUrl: r.qrUrl || '', transmittedAt: nowIso(), env: r.env };
      store.audit(user.id, 'mydata-send', { invoice: claim.inv.number, mark: r.mark, env: r.env });
    } catch (e) {
      patch = { status: 'pending', error: e.message, triedAt: nowIso() };
      store.audit(user.id, 'mydata-error', { invoice: claim.inv.number, error: e.message });
    }
  }
  json(res, 200, await store.write(user.id, () => { const inv = store.byId('invoices', id); if (inv && patch) inv.mydata = patch; }, recOut('invoices', id, 'invoice')));
});
route('POST', '/api/courier/book', 'staff', async ({ res, user, body }) => {
  const id = str(body.deliveryId, 64);
  const claim = await store.write(user.id, () => {
    const d = store.byId('deliveries', id); if (!d) throw httpError(404, 'Delivery not found.');
    if (d.booked) return null;
    if (d.booking && Date.now() - Date.parse(d.booking) < 120e3) throw httpError(409, 'This delivery is already being booked.');
    d.booking = nowIso();
    return JSON.parse(JSON.stringify({ d, order: store.byId('orders', d.orderId), customer: store.byId('customers', d.customerId), company: store.db.settings.company }));
  });
  let patch = null;
  if (claim) {
    try {
      const r = await couriers.book({ cfg: (await getIntegrations()).couriers, delivery: claim.d, order: claim.order, customer: claim.customer, company: claim.company, manualTracking: body.tracking });
      patch = { tracking: r.tracking, courierRef: r.ref || '', booked: true, labelAvailable: !!r.labelAvailable, courierMode: r.mode, courierError: '', bookedAt: nowIso() };
      store.audit(user.id, 'courier-book', { delivery: claim.d.number, courier: claim.d.courier, tracking: r.tracking, mode: r.mode });
    } catch (e) { patch = { courierError: e.message }; }
  }
  const out = await store.write(user.id, () => { const d = store.byId('deliveries', id); if (d && patch) { delete d.booking; Object.assign(d, patch); } }, recOut('deliveries', id, 'delivery'));
  if (patch && patch.courierError) return json(res, 400, { error: patch.courierError, ...out });
  json(res, 200, out);
});
route('POST', '/api/courier/track', 'staff', async ({ res, user, body }) => {
  const id = str(body.deliveryId, 64);
  await store.read();
  const d0 = store.byId('deliveries', id); if (!d0) throw httpError(404, 'Delivery not found.');
  if (!d0.booked) throw httpError(400, 'This shipment is not booked with the courier yet.');
  const r = await couriers.track({ cfg: (await getIntegrations()).couriers, delivery: JSON.parse(JSON.stringify(d0)) });
  json(res, 200, await store.write(user.id, () => {
    const d = store.byId('deliveries', id); if (!d) return;
    if (r.events) d.events = r.events;
    if (r.courierStatus) d.courierStatus = r.courierStatus;
    if (r.status) applyDeliveryStatus(d, r.status);
  }, recOut('deliveries', id, 'delivery')));
});
route('GET', '/api/courier/label/:id', 'staff', async ({ res, params }) => {
  await store.read();
  const d = store.byId('deliveries', params.id); if (!d) throw httpError(404, 'Delivery not found.');
  const r = await couriers.label({ cfg: (await getIntegrations()).couriers, delivery: d, order: store.byId('orders', d.orderId), customer: store.byId('customers', d.customerId), company: store.db.settings.company });
  send(res, 200, r.body, { 'Content-Type': r.contentType, 'Content-Disposition': `inline; filename="label-${d.number}.${r.contentType.includes('pdf') ? 'pdf' : 'html'}"`, 'Cache-Control': 'no-store' });
});
route('POST', '/api/courier/close-day', 'staff', async ({ res, user, body }) => {
  const r = await couriers.closeDay({ cfg: (await getIntegrations()).couriers, courier: str(body.courier, 40) });
  store.audit(user.id, 'courier-close-day', r);
  json(res, 200, r);
});
route('POST', '/api/email/retry', 'staff', async ({ res, user, body }) => {
  const id = str(body.id, 64);
  await store.write(user.id, () => {
    const e = store.byId('emails', id); if (!e) throw httpError(404, 'Email not found.');
    if (!['failed', 'simulated'].includes(e.status)) throw httpError(400, 'Only failed or simulated emails can be resent.');
    e.status = 'queued'; delete e.error; delete e.note;
  });
  json(res, 200, { ok: true });
});

// files
route('POST', '/api/files', 'staff', async ({ req, res, user, query }) => json(res, 200, await uploadFile(req, user, query)));
route('GET', '/api/files/:id', 'staff', async ({ res, params }) => serveFile(res, params.id));
route('DELETE', '/api/files/:id', 'staff', async ({ res, params, user }) => {
  if (!/^[0-9a-f]{32}$/.test(params.id)) throw httpError(404, 'Not found.');
  await store.batchWrite([{ sql: 'delete from file_blobs where id = ?', args: [params.id] }, { sql: 'delete from files where id = ?', args: [params.id] }]);
  store.audit(user.id, 'file-delete', params.id);
  json(res, 200, { ok: true });
});

// admin
route('GET', '/api/admin/integrations', 'admin', async ({ res }) => { const cfg = await getIntegrations(); json(res, 200, { config: maskedConfig(cfg), status: integrationStatus(cfg), encrypted: !!SECRET_KEY }); });
route('PUT', '/api/admin/integrations', 'admin', async ({ res, user, body }) => {
  const current = await getIntegrations();
  const next = deepMerge(current, JSON.parse(JSON.stringify({ smtp: body.smtp, mydata: body.mydata, couriers: body.couriers })));
  for (const p of SECRET_PATHS) if (getPath(next, p) === MASK) setPath(next, p, getPath(current, p));
  if (!['simulate', 'test', 'production'].includes(next.mydata.mode)) throw httpError(400, 'Unknown myDATA mode.');
  next.smtp.port = +next.smtp.port || 587; next.smtp.secure = !!next.smtp.secure;
  await saveIntegrations(next);
  store.audit(user.id, 'integrations-update', ['smtp', 'mydata', 'couriers'].filter(k => body[k]).join(','));
  json(res, 200, { config: maskedConfig(next), status: integrationStatus(next), encrypted: !!SECRET_KEY });
});
route('POST', '/api/admin/test-email', 'admin', async ({ res, body }) => {
  const cfg = await getIntegrations();
  await mail.sendMail(cfg.smtp, { from: cfg.smtp.from || store.db.settings.company.email, to: str(body.to, 160), subject: 'BizOrganiser test email', text: 'SMTP is configured correctly.' });
  json(res, 200, { ok: true });
});
route('GET', '/api/admin/users', 'admin', async ({ res }) => json(res, 200, { users: await auth.listUsers() }));
route('POST', '/api/admin/users', 'admin', async ({ res, user, body }) => {
  const u = await auth.createUser({ name: str(body.name, 120), email: str(body.email, 160), role: body.role, customerId: str(body.customerId, 64), password: String(body.password || ''), mustChange: body.mustChange !== false });
  store.audit(user.id, 'user-create', u.email); json(res, 200, { user: u });
});
route('PUT', '/api/admin/users/:id', 'admin', async ({ res, user, body, params }) => {
  const u = await auth.updateUser(params.id, { name: body.name && str(body.name, 120), email: body.email && str(body.email, 160), role: body.role, customerId: body.customerId, active: body.active });
  if (body.password) await auth.setPassword(params.id, String(body.password), { mustChange: body.mustChange !== false });
  store.audit(user.id, 'user-update', u.email); json(res, 200, { user: auth.publicUser(await auth.getUser(params.id)) });
});
route('DELETE', '/api/admin/users/:id', 'admin', async ({ res, user, params }) => { await auth.deleteUser(params.id, user.id); store.audit(user.id, 'user-delete', params.id); json(res, 200, { ok: true }); });
route('POST', '/api/admin/import', 'admin', async ({ res, user, body }) => {
  if (!isObj(body.settings) || !Array.isArray(body.customers)) throw httpError(400, 'This is not a BizOrganiser backup.');
  await store.write(user.id, () => store.setData(body)); store.audit(user.id, 'import', `${body.customers.length} customers`); json(res, 200, { ok: true });
});
route('POST', '/api/admin/reset-demo', 'admin', async ({ res, user }) => { await store.write(user.id, () => store.setData(S.seedDB())); store.audit(user.id, 'reset-demo', ''); json(res, 200, { ok: true }); });
route('POST', '/api/admin/reset-empty', 'admin', async ({ res, user }) => {
  await store.write(user.id, () => { const company = store.db.settings.company; store.setData(S.seedDB(true)); store.db.settings.company = company; });
  store.audit(user.id, 'reset-empty', ''); json(res, 200, { ok: true });
});
route('GET', '/api/admin/audit', 'admin', async ({ res }) => json(res, 200, { entries: await store.all('select * from audit order by id desc limit 300') }));

// B2B portal
route('GET', '/api/portal/bootstrap', 'customer', async ({ res, user }) => { await store.read(); json(res, 200, portalBootstrap(user)); });
route('POST', '/api/portal/orders', 'customer', async ({ res, user, body }) => json(res, 200, await store.write(user.id, () => portalPlaceOrder(user, body))));
route('POST', '/api/portal/orders/:id/confirm', 'customer', async ({ res, user, params }) => json(res, 200, await store.write(user.id, () => portalConfirm(user, params.id))));

// public e-shop
route('GET', '/api/public/shop', 'public', async ({ res }) => { await store.read(); json(res, 200, publicShop()); });
route('POST', '/api/public/orders', 'public', async ({ req, res, body }) => {
  if (body.website) throw httpError(400, 'Rejected.');  // honeypot field
  if (!(await rateLimit('shop:' + clientIp(req), 10, 3600e3))) throw httpError(429, 'Too many orders from your network. Please try again later.');
  json(res, 200, await store.write('eshop', () => placeShopOrder(body)));
});

// scheduled maintenance (Vercel Cron calls this daily with the CRON_SECRET)
route('GET', '/api/cron', 'cron', async ({ res }) => {
  await auth.cleanup();
  await store.run('delete from rate_events where at < ?', [Date.now() - 24 * 3600e3]);
  await pumpMail();
  json(res, 200, { ok: true });
});
route('GET', '/api/health', 'public', async ({ res }) => json(res, 200, { ok: true, database: remote ? 'turso' : 'local', seq: store.seq }));

/* ---------- request handling ---------- */
async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let pathname = url.pathname;
  if (pathname === '/api/index' && url.searchParams.has('__path')) {   // Vercel rewrite form
    pathname = '/api/' + url.searchParams.get('__path'); url.searchParams.delete('__path');
  }
  try {
    await ensureReady();
    const r = routes.find(x => x.method === req.method && x.re.test(pathname));
    if (!r) throw httpError(404, 'Unknown API endpoint.');
    // CSRF protection: every state-changing API call must carry our custom header
    if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'BizOrganiser') throw httpError(403, 'Missing request header.');
    if (r.access === 'cron') {
      const secret = process.env.CRON_SECRET;
      if (!secret || req.headers.authorization !== `Bearer ${secret}`) throw httpError(401, 'Unauthorized.');
    }
    let user = null;
    if (!['public', 'cron'].includes(r.access)) {
      if (setupProblem) throw httpError(503, setupProblem);
      user = await auth.userFromToken(cookies(req).sid);
      if (!user) throw httpError(401, 'Please sign in.');
      const passwordRoute = pathname === '/api/me' || pathname === '/api/me/password';
      if (Number(user.must_change) && !passwordRoute) throw httpError(403, 'You must change your password first.');
      if (r.access === 'staff' && !STAFF_ROLES.includes(user.role)) throw httpError(403, 'Staff only.');
      if (r.access === 'admin' && user.role !== 'admin') throw httpError(403, 'Administrators only.');
      if (r.access === 'customer' && user.role !== 'customer') throw httpError(403, 'Customer portal only.');
    }
    const params = r.re.exec(pathname).groups || {};
    const isUpload = pathname === '/api/files' && req.method === 'POST';
    const limit = pathname === '/api/admin/import' ? (ON_VERCEL ? 4.4e6 : 60e6) : pathname === '/api/sync' ? (ON_VERCEL ? 4.4e6 : 20e6) : 1e6;
    const body = !isUpload && ['POST', 'PUT', 'DELETE'].includes(req.method) ? await readJSON(req, limit) : {};
    await r.fn({ req, res, user, params, query: url.searchParams, body });
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500 && !e.expose) console.error(new Date().toISOString(), req.method, pathname, e);
    if (!res.headersSent) json(res, status, { error: e.expose || status < 500 ? e.message : 'Server error — see the server log.' }, status === 413 ? { Connection: 'close' } : {});
    else res.end();
  } finally {
    if (store.mailPending && !mailBusy) later(pumpMail());
  }
}

module.exports = { handle, ensureReady, SEC_HEADERS, RUNTIME, DATA, PUB, where, store, auth };
