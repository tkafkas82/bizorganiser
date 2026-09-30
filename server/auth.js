'use strict';
/* =========================================================================
   Authentication: scrypt password hashing, cookie sessions, login
   throttling. Everything is stored in the database, so it works the same
   with one server or many serverless instances.
   ========================================================================= */
const crypto = require('crypto');

const SESSION_HOURS = 12;
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const STAFF_ROLES = ['admin', 'sales', 'production', 'accounting'];
const ALL_ROLES = [...STAFF_ROLES, 'customer'];

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 64, SCRYPT);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const [alg, salt, hash] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const calc = crypto.scryptSync(String(pw), Buffer.from(salt, 'hex'), 64, SCRYPT);
  const want = Buffer.from(hash, 'hex');
  return want.length === calc.length && crypto.timingSafeEqual(calc, want);
}
function passwordProblem(pw) {
  pw = String(pw || '');
  if (pw.length < 10) return 'Password must be at least 10 characters.';
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return 'Password must contain letters and numbers.';
  return '';
}
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const randomPassword = () => crypto.randomBytes(12).toString('base64url').replace(/[-_]/g, 'x') + '7a';
function httpError(status, message) { const e = new Error(message); e.status = status; e.expose = true; return e; }

class Auth {
  constructor(store, { secureCookies = false } = {}) { this.store = store; this.secure = secureCookies; }
  q(sql, args, ex) { return this.store.run(sql, args, ex); }
  one(sql, args, ex) { return this.store.get(sql, args, ex); }

  /* ---------- users ---------- */
  publicUser(u) {
    return u && { id: u.id, name: u.name, email: u.email, role: u.role, customerId: u.customer_id || '', active: !!Number(u.active), mustChange: !!Number(u.must_change), lastLogin: u.last_login };
  }
  async listUsers() { return (await this.store.all('select * from users order by name')).map(u => this.publicUser(u)); }
  getUser(id, ex) { return this.one('select * from users where id = ?', [id], ex); }
  async activeAdmins(exceptId, ex) { return Number((await this.one("select count(*) n from users where role = 'admin' and active = 1 and id != ?", [exceptId], ex)).n); }

  async createUser({ id, name, email, role, customerId, password, mustChange = true }, ex) {
    if (!name || !email) throw httpError(400, 'Name and email are required.');
    if (!ALL_ROLES.includes(role)) throw httpError(400, 'Unknown role.');
    if (role === 'customer' && !customerId) throw httpError(400, 'A customer login must be linked to a customer.');
    const prob = passwordProblem(password); if (prob) throw httpError(400, prob);
    email = email.trim().toLowerCase();
    if (await this.one('select 1 x from users where email = ?', [email], ex)) throw httpError(409, 'A user with this email already exists.');
    id = id || 'u' + crypto.randomBytes(6).toString('hex');
    await this.q('insert into users (id, name, email, role, customer_id, pass_hash, active, must_change, created_at) values (?, ?, ?, ?, ?, ?, 1, ?, ?)',
      [id, name.trim(), email, role, role === 'customer' ? customerId : null, hashPassword(password), mustChange ? 1 : 0, new Date().toISOString()], ex);
    return this.publicUser(await this.getUser(id, ex));
  }
  async updateUser(id, { name, email, role, customerId, active }) {
    const u = await this.getUser(id); if (!u) throw httpError(404, 'User not found.');
    const next = { name: name ?? u.name, email: (email ?? u.email).trim().toLowerCase(), role: role ?? u.role, customer_id: (customerId ?? u.customer_id) || null, active: active === undefined ? Number(u.active) : (active ? 1 : 0) };
    if (!ALL_ROLES.includes(next.role)) throw httpError(400, 'Unknown role.');
    if (next.role === 'customer' && !next.customer_id) throw httpError(400, 'A customer login must be linked to a customer.');
    if (u.role === 'admin' && (next.role !== 'admin' || !next.active) && await this.activeAdmins(id) === 0) throw httpError(400, 'Keep at least one active administrator.');
    if (await this.one('select id from users where email = ? and id != ?', [next.email, id])) throw httpError(409, 'Another user already has this email.');
    await this.q('update users set name = ?, email = ?, role = ?, customer_id = ?, active = ? where id = ?', [next.name, next.email, next.role, next.role === 'customer' ? next.customer_id : null, next.active, id]);
    if (!next.active) await this.q('delete from sessions where user_id = ?', [id]);
    return this.publicUser(await this.getUser(id));
  }
  async deleteUser(id, byUserId) {
    if (id === byUserId) throw httpError(400, "You can't delete your own account.");
    const u = await this.getUser(id); if (!u) throw httpError(404, 'User not found.');
    if (u.role === 'admin' && await this.activeAdmins(id) === 0) throw httpError(400, 'Keep at least one active administrator.');
    await this.q('delete from sessions where user_id = ?', [id]);
    await this.q('delete from users where id = ?', [id]);
  }
  async setPassword(id, password, { mustChange = false } = {}) {
    const prob = passwordProblem(password); if (prob) throw httpError(400, prob);
    await this.q('update users set pass_hash = ?, must_change = ? where id = ?', [hashPassword(password), mustChange ? 1 : 0, id]);
    await this.q('delete from sessions where user_id = ?', [id]); // log out everywhere
  }

  /* ---------- throttling (5 failures -> 5 minutes lock, per email and per network address) ---------- */
  async throttled(keys) {
    for (const k of keys) { const r = await this.one('select until from login_failures where key = ?', [k]); if (r && Number(r.until) > Date.now()) return true; }
    return false;
  }
  async fail(keys) {
    for (const k of keys) {
      await this.q(`insert into login_failures (key, n, until) values (?, 1, 0)
        on conflict(key) do update set n = case when login_failures.n + 1 >= 5 then 0 else login_failures.n + 1 end,
        until = case when login_failures.n + 1 >= 5 then ? else login_failures.until end`, [k, Date.now() + 5 * 60 * 1000]);
    }
  }

  /* ---------- login / sessions ---------- */
  async login(email, password, ip) {
    email = String(email || '').trim().toLowerCase();
    const keys = [`e:${email}`, `i:${ip}`];
    if (await this.throttled(keys)) throw httpError(429, 'Too many failed attempts. Try again in a few minutes.');
    const u = await this.one('select * from users where email = ?', [email]);
    const ok = u && Number(u.active) && verifyPassword(password, u.pass_hash);
    if (!u) verifyPassword(password, 'scrypt$00$00'); // similar timing for unknown users
    if (!ok) { await this.fail(keys); throw httpError(401, 'Wrong email or password.'); }
    for (const k of keys) await this.q('delete from login_failures where key = ?', [k]);
    return this.createSession(u, ip);
  }
  async createSession(u, ip) {
    const token = crypto.randomBytes(32).toString('base64url');
    await this.q('insert into sessions (token_hash, user_id, expires_at, created_at, ip) values (?, ?, ?, ?, ?)', [sha256(token), u.id, Date.now() + SESSION_HOURS * 3600e3, new Date().toISOString(), ip]);
    await this.q('update users set last_login = ? where id = ?', [new Date().toISOString(), u.id]);
    return { token, user: this.publicUser(u) };
  }
  async logout(token) { if (token) await this.q('delete from sessions where token_hash = ?', [sha256(token)]); }
  /** Resolve the session cookie to a user (sliding expiry). */
  async userFromToken(token) {
    if (!token) return null;
    const s = await this.one(`select s.token_hash, s.expires_at, u.* from sessions s join users u on u.id = s.user_id where s.token_hash = ?`, [sha256(token)]);
    if (!s || Number(s.expires_at) < Date.now() || !Number(s.active)) return null;
    const fresh = Date.now() + SESSION_HOURS * 3600e3;
    if (fresh - Number(s.expires_at) > 3600e3) await this.q('update sessions set expires_at = ? where token_hash = ?', [fresh, s.token_hash]);
    return s;
  }
  async cleanup() {
    await this.q('delete from sessions where expires_at < ?', [Date.now()]);
    await this.q('delete from login_failures where until < ? and n = 0', [Date.now()]);
  }
  cookie(token, maxAge = SESSION_HOURS * 3600) {
    return `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${this.secure ? '; Secure' : ''}`;
  }
}

module.exports = { Auth, hashPassword, verifyPassword, passwordProblem, randomPassword, httpError, STAFF_ROLES, ALL_ROLES };
