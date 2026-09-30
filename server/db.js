'use strict';
/* =========================================================================
   Database connection (libSQL).
     - On Vercel / any cloud: Turso — set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN
     - Locally: a SQLite file, data/bizorganiser.db (same client, same SQL)
   ========================================================================= */
const fs = require('fs');
const path = require('path');
const { createClient } = require('@libsql/client');

const SCHEMA = [
  `create table if not exists records (
     col text not null, id text not null, data text not null,
     version integer not null default 1, seq integer not null,
     deleted integer not null default 0, updated_at text, updated_by text,
     primary key (col, id))`,
  'create index if not exists records_seq on records (seq)',
  'create table if not exists meta (key text primary key, value text not null)',
  `create table if not exists users (
     id text primary key, name text not null, email text not null unique collate nocase,
     role text not null, customer_id text, pass_hash text not null,
     active integer not null default 1, must_change integer not null default 0,
     created_at text, last_login text)`,
  `create table if not exists sessions (
     token_hash text primary key, user_id text not null references users(id) on delete cascade,
     expires_at integer not null, created_at text, ip text)`,
  'create table if not exists files (id text primary key, name text, size integer, type text, created_at text, created_by text)',
  'create table if not exists file_blobs (id text primary key, data blob not null)',
  'create table if not exists audit (id integer primary key autoincrement, at text, user_id text, action text, detail text)',
  'create table if not exists login_failures (key text primary key, n integer not null, until integer not null)',
  'create table if not exists rate_events (key text not null, at integer not null)',
  'create index if not exists rate_events_key on rate_events (key, at)',
];

function openDatabase(dataDir) {
  const url = process.env.TURSO_DATABASE_URL || process.env.LIBSQL_URL;
  if (url) {
    return { client: createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN }), where: url.replace(/\?.*$/, ''), remote: true };
  }
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'bizorganiser.db');
  // One connection per process: writes are serialised by the store anyway, and a pool of
  // local connections can keep an outdated read snapshot under concurrent load.
  return { client: createClient({ url: 'file:' + file.replace(/\\/g, '/'), concurrency: 1 }), where: file, remote: false };
}

async function initSchema(client, remote) {
  if (!remote) { await client.execute('pragma journal_mode = wal'); await client.execute('pragma busy_timeout = 5000'); }
  await client.execute('pragma foreign_keys = on').catch(() => {});
  for (const s of SCHEMA) await client.execute(s);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
/** Retry when another writer holds the database lock. */
async function withRetry(fn, tries = 6) {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) {
      if (i < tries - 1 && /SQLITE_BUSY|database is locked|locked/i.test(String(e?.message || e?.code))) { await sleep(80 * 2 ** i + Math.random() * 50); continue; }
      throw e;
    }
  }
}

module.exports = { openDatabase, initSchema, withRetry };
