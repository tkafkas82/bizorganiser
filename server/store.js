'use strict';
/* =========================================================================
   Store: records in libSQL (SQLite / Turso) + an in-memory working copy.

   Works with many server instances at once (Vercel):
   - every record has a version, every change a global sequence number;
   - before a request uses the in-memory copy it compares the stored
     sequence number and pulls in changes written by other instances;
   - every write runs in a database write transaction: refresh, apply the
     change in memory, persist the difference, commit. SQLite serialises
     write transactions, so numbering and conflict checks stay exact.

   The business helpers from public/js/core.js + seed.js (pricing, totals,
   numbering, stock, demo data) run in a vm sandbox so the browser and the
   server share one implementation.
   ========================================================================= */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { withRetry } = require('./db');

const COLLECTIONS = ['customers', 'suppliers', 'products', 'supplierPrices', 'priceLists', 'reps', 'activities', 'quotes', 'orders',
  'workOrders', 'deliveries', 'invoices', 'purchaseOrders', 'bills', 'emails', 'stockMoves', 'rfqs'];
const SINGLES = ['settings', 'counters'];           // single-document "collections"
const NUMBERED = { quotes: 'quote', orders: 'order', workOrders: 'wo', purchaseOrders: 'po', invoices: 'invoice', deliveries: 'delivery', bills: 'bill' };

function makeSandbox(publicDir) {
  const noop = () => {};
  const el = () => ({ innerHTML: '', textContent: '', value: '', classList: { toggle: noop, add: noop, remove: noop, contains: () => false }, style: {}, dataset: {}, querySelector: () => el(), querySelectorAll: () => [], addEventListener: noop, appendChild: noop, focus: noop, remove: noop });
  const ctx = {
    console, Intl, Date, Math, JSON, setTimeout: noop,
    localStorage: { getItem: () => null, setItem: noop },
    location: { hash: '' }, history: { replaceState: noop }, window: { addEventListener: noop, scrollTo: noop, print: noop },
    document: { getElementById: () => el(), querySelector: () => el(), querySelectorAll: () => [], addEventListener: noop, createElement: () => el(), body: { classList: { toggle: noop, add: noop, remove: noop } } },
    URL: { createObjectURL: noop, revokeObjectURL: noop }, Blob: function () {}, MutationObserver: function () { this.observe = noop; },
  };
  vm.createContext(ctx);
  for (const f of ['core.js', 'seed.js']) vm.runInContext(fs.readFileSync(path.join(publicDir, 'js', f), 'utf8'), ctx, { filename: f });
  vm.runInContext('globalThis.__setDB = d => { db = d; };', ctx);
  // `const` helpers are not properties of the sandbox global: expose the ones the server uses
  vm.runInContext(`Object.assign(globalThis, { uid, clone, esc, sum, round2, money, num, today, addDays, fmtDate, byId, nameOf,
    lineNet, paidOf, isCredit, creditsOf, creditedOf, balanceOf, invNet, fillTpl });`, ctx);
  return ctx;
}

class Store {
  constructor(client, publicDir) {
    this.c = client;
    this.S = makeSandbox(publicDir);
    this.snap = new Map();   // "col/id" -> JSON as persisted
    this.ver = new Map();    // "col/id" -> version
    this.seq = 0;
    this.db = null;
    this.mailPending = false;
    this._queue = Promise.resolve();
  }

  /* ---------- plain SQL helpers (tables outside the record store) ---------- */
  async all(sql, args = [], ex = this.c) { return (await ex.execute({ sql, args })).rows; }
  async get(sql, args = [], ex = this.c) { return (await ex.execute({ sql, args })).rows[0]; }
  /**
   * Writes. Inside a write() transaction pass its tx. Otherwise the write is
   * queued behind any open transaction of this instance: the local SQLite
   * driver waits for locks synchronously, so a second in-process writer would
   * block the transaction that holds the lock (a deadlock).
   */
  run(sql, args = [], ex) {
    if (ex) return ex.execute({ sql, args });
    return this.exclusive(() => withRetry(() => this.c.execute({ sql, args })));
  }
  batchWrite(stmts) { return this.exclusive(() => withRetry(() => this.c.batch(stmts, 'write'))); }
  async getMeta(k, ex = this.c) { return (await this.get('select value from meta where key = ?', [k], ex))?.value; }
  setMetaStmt(k, v) { return { sql: 'insert into meta (key, value) values (?, ?) on conflict(key) do update set value = excluded.value', args: [k, String(v)] }; }
  setMeta(k, v, ex) { return this.run(this.setMetaStmt(k, v).sql, this.setMetaStmt(k, v).args, ex); }
  audit(userId, action, detail) {
    return this.run('insert into audit (at, user_id, action, detail) values (?, ?, ?, ?)', [new Date().toISOString(), userId || null, action, typeof detail === 'string' ? detail : JSON.stringify(detail ?? '')])
      .catch(e => console.error('audit failed', e.message));
  }

  /** Run fn exclusively within this instance (other instances are serialised by the database). */
  exclusive(fn) {
    const run = this._queue.then(fn, fn);
    this._queue = run.catch(() => {});
    return run;
  }

  /* ---------- loading ---------- */
  emptyDb() {
    const db = { version: 1, settings: this.S.defaultSettings(), counters: {}, session: {}, users: [] };
    for (const c of COLLECTIONS) db[c] = [];
    return db;
  }
  async loadAll(ex = this.c) {
    this.db = this.emptyDb(); this.snap.clear(); this.ver.clear();
    const rows = await this.all('select col, id, data, version, deleted from records', [], ex);
    for (const r of rows) this.applyRow(r);
    this.seq = +(await this.getMeta('seq', ex) || 0);
    this.S.__setDB(this.db);
  }
  applyRow(r) {
    const key = `${r.col}/${r.id}`;
    this.ver.set(key, Number(r.version));
    if (SINGLES.includes(r.col)) {
      if (!Number(r.deleted)) { this.db[r.col] = JSON.parse(r.data); this.snap.set(key, r.data); }
      return;
    }
    const arr = this.db[r.col]; if (!arr) return;
    const i = arr.findIndex(x => x.id === r.id);
    if (Number(r.deleted)) { if (i >= 0) arr.splice(i, 1); this.snap.delete(key); return; }
    const data = JSON.parse(r.data);
    if (i >= 0) arr[i] = data; else arr.push(data);
    this.snap.set(key, r.data);
  }
  /** Bring the in-memory copy up to date with the database. */
  async refresh(ex = this.c) {
    if (!this.db) return this.loadAll(ex);
    const cur = +(await this.getMeta('seq', ex) || 0);
    if (cur === this.seq) return;
    if (cur < this.seq) return this.loadAll(ex);          // database was reset/replaced
    const rows = await this.all('select col, id, data, version, deleted from records where seq > ? order by seq', [this.seq], ex);
    for (const r of rows) this.applyRow(r);
    this.seq = cur;
  }
  /** Use before reading the in-memory data. */
  read() { return this.exclusive(() => this.refresh()); }

  /**
   * Change data safely: fn(tx) mutates this.db in memory (it may also run
   * SQL on tx), then all differences are persisted in the same transaction.
   * after() runs once the change is committed, still exclusively.
   */
  write(userId, fn, after) {
    return this.exclusive(() => withRetry(async () => {
      let phase = 'begin';
      const tx = await this.c.transaction('write').catch(e => { if (process.env.BIZ_DEBUG) console.error('[write] failed at begin', e.extendedCode); throw e; });
      let result;
      try {
        phase = 'refresh'; await this.refresh(tx);
        phase = 'fn'; result = await fn(tx);
        phase = 'persist'; const changes = await this.persist(tx, userId);
        phase = 'commit'; await tx.commit();
        if (changes.some(c => c.col === 'emails')) this.mailPending = true;
      } catch (e) {
        if (process.env.BIZ_DEBUG) console.error('[write] failed at', phase, e.extendedCode || e.message);
        try { await tx.rollback(); } catch { /* already closed */ }
        await this.loadAll();          // memory may hold the half-applied change
        throw e;
      } finally { try { tx.close(); } catch { /* ignore */ } }
      return after ? after(result) : result;
    }));
  }

  /** Persist every difference between memory and the last persisted state. */
  async persist(tx, userId) {
    const now = new Date().toISOString();
    const stmts = [], changes = [], next = [];
    let seq = this.seq;
    const write = (col, id, json, deleted) => {
      const key = `${col}/${id}`;
      const v = (this.ver.get(key) || 0) + 1;
      seq++;
      stmts.push({
        sql: `insert into records (col, id, data, version, seq, deleted, updated_at, updated_by) values (?, ?, ?, ?, ?, ?, ?, ?)
              on conflict(col, id) do update set data = excluded.data, version = excluded.version, seq = excluded.seq,
              deleted = excluded.deleted, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        args: [col, id, json, v, seq, deleted ? 1 : 0, now, userId || null],
      });
      next.push([key, v, deleted ? null : json]);
      changes.push({ col, id, version: v, seq, deleted: !!deleted });
    };
    const alive = new Set();
    for (const col of COLLECTIONS) {
      for (const rec of this.db[col]) {
        if (!rec || !rec.id) continue;
        const key = `${col}/${rec.id}`; alive.add(key);
        const json = JSON.stringify(rec);
        if (this.snap.get(key) !== json) write(col, rec.id, json, false);
      }
    }
    for (const col of SINGLES) {
      const key = `${col}/${col}`; alive.add(key);
      const json = JSON.stringify(this.db[col]);
      if (this.snap.get(key) !== json) write(col, col, json, false);
    }
    for (const key of this.snap.keys()) {
      if (alive.has(key)) continue;
      const i = key.indexOf('/');
      write(key.slice(0, i), key.slice(i + 1), this.snap.get(key), true);
    }
    if (!stmts.length) return changes;
    stmts.push(this.setMetaStmt('seq', seq));
    for (let i = 0; i < stmts.length; i += 200) await tx.batch(stmts.slice(i, i + 200));
    for (const [key, v, json] of next) { this.ver.set(key, v); if (json === null) this.snap.delete(key); else this.snap.set(key, json); }
    this.seq = seq;
    return changes;
  }

  /* ---------- whole-dataset operations (call inside write()) ---------- */
  setData(data) {
    const db = this.emptyDb();
    db.settings = data.settings || db.settings;
    db.counters = data.counters || {};
    for (const c of COLLECTIONS) db[c] = Array.isArray(data[c]) ? data[c] : [];
    this.db = db; this.S.__setDB(db);
    this.recountCounters();
  }
  recountCounters() {
    for (const [col, key] of Object.entries(NUMBERED)) {
      const max = Math.max(0, ...this.db[col].map(r => { const m = String(r.number || '').match(/(\d+)\s*$/); return m ? +m[1] : 0; }));
      this.db.counters[key] = Math.max(this.db.counters[key] || 0, max);
    }
  }
  isEmpty() { return this.snap.size === 0; }

  changesSince(seq, limit = 2000) {
    return this.all('select col, id, data, version, deleted, seq from records where seq > ? order by seq limit ?', [seq, limit])
      .then(rows => rows.map(r => ({ col: r.col, id: r.id, version: Number(r.version), seq: Number(r.seq), deleted: !!Number(r.deleted), data: Number(r.deleted) ? null : JSON.parse(r.data) })));
  }
  /** Full snapshot for a staff client (call after read()). */
  snapshot() {
    const versions = {};
    for (const [k, v] of this.ver) if (this.snap.has(k)) versions[k] = v;
    const out = { seq: this.seq, versions, settings: this.db.settings, counters: this.db.counters };
    for (const c of COLLECTIONS) out[c] = this.db[c];
    return out;
  }

  /* ---------- record helpers ---------- */
  byId(col, id) { return this.db[col].find(r => r.id === id); }
  version(col, id) { return this.ver.get(`${col}/${id}`) || 0; }
}

module.exports = { Store, COLLECTIONS, SINGLES, NUMBERED };
