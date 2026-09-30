'use strict';
/* =========================================================================
   Minimal SMTP client (no dependencies): implicit TLS (465) or STARTTLS
   (587/25), AUTH LOGIN / PLAIN, UTF-8 subject and body.
   ========================================================================= */
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');

const clean = s => String(s ?? '').replace(/[\r\n]+/g, ' ').trim();
const encWord = s => /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
const wrap76 = b64 => b64.replace(/.{1,76}/g, '$&\r\n');
const addrOnly = s => { const m = String(s).match(/<([^>]+)>/); return clean(m ? m[1] : s); };
const isEmail = s => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(addrOnly(s));

function buildMessage({ from, to, subject, text, replyTo }) {
  const domain = addrOnly(from).split('@')[1] || 'localhost';
  const headers = [
    `From: ${clean(from)}`, `To: ${clean(to)}`, `Subject: ${encWord(clean(subject))}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${crypto.randomBytes(12).toString('hex')}@${domain}>`,
    ...(replyTo ? [`Reply-To: ${clean(replyTo)}`] : []),
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64',
  ];
  // base64 body lines never start with ".", so no dot-stuffing is needed
  return headers.join('\r\n') + '\r\n\r\n' + wrap76(Buffer.from(String(text ?? '').replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64'));
}

class SmtpConnection {
  constructor(socket) { this.buf = ''; this.waiters = []; this.lines = []; this.attach(socket); }
  attach(socket) {
    if (this.socket) this.socket.removeAllListeners('data');
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.on('data', d => { this.buf += d; this.pump(); });
    socket.on('error', e => { this.error = e; this.flushErr(e); });
    socket.on('close', () => this.flushErr(new Error('SMTP connection closed')));
  }
  flushErr(e) { while (this.waiters.length) this.waiters.shift().reject(e); }
  pump() {
    let i;
    while ((i = this.buf.indexOf('\r\n')) >= 0) {
      const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 2);
      this.lines.push(line);
      if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) {
        const lines = this.lines; this.lines = [];
        const w = this.waiters.shift();
        if (w) w.resolve({ code: +line.slice(0, 3), lines });
      }
    }
  }
  read() { return new Promise((resolve, reject) => { if (this.error) return reject(this.error); this.waiters.push({ resolve, reject }); this.pump(); }); }
  async cmd(line, expect) {
    if (line !== null) this.socket.write(line + '\r\n');
    const r = await this.read();
    const ok = Array.isArray(expect) ? expect.includes(r.code) : r.code === expect;
    if (!ok) throw new Error(`SMTP ${line ? line.split(' ')[0] : 'greeting'} failed: ${r.lines.join(' ')}`);
    return r;
  }
}

function connect(opts) {
  return new Promise((resolve, reject) => {
    const s = opts.secure
      ? tls.connect({ host: opts.host, port: opts.port, servername: opts.host, rejectUnauthorized: opts.rejectUnauthorized !== false })
      : net.connect({ host: opts.host, port: opts.port });
    s.setTimeout(20000, () => s.destroy(new Error('SMTP timeout')));
    s.once(opts.secure ? 'secureConnect' : 'connect', () => resolve(s));
    s.once('error', reject);
  });
}

/**
 * Send one email. cfg: {host, port, secure, user, pass, from, rejectUnauthorized}
 */
async function sendMail(cfg, msg) {
  if (!cfg?.host) throw new Error('SMTP is not configured');
  const port = +cfg.port || (cfg.secure ? 465 : 587);
  const secure = cfg.secure ?? port === 465;
  const from = msg.from || cfg.from;
  if (!isEmail(from)) throw new Error('Invalid sender address');
  if (!isEmail(msg.to)) throw new Error(`Invalid recipient address "${msg.to}"`);
  const socket = await connect({ host: cfg.host, port, secure, rejectUnauthorized: cfg.rejectUnauthorized });
  const c = new SmtpConnection(socket);
  try {
    await c.cmd(null, 220);
    const helo = `EHLO ${cfg.heloName || 'bizorganiser.local'}`;
    let ehlo = await c.cmd(helo, 250);
    if (!secure) {
      if (!ehlo.lines.some(l => /STARTTLS/i.test(l))) {
        if (cfg.user && !cfg.allowInsecure) throw new Error('Server does not offer STARTTLS; refusing to send the password in clear text');
      } else {
        await c.cmd('STARTTLS', 220);
        const tlsSock = await new Promise((resolve, reject) => {
          const t = tls.connect({ socket, servername: cfg.host, rejectUnauthorized: cfg.rejectUnauthorized !== false }, () => resolve(t));
          t.once('error', reject);
        });
        c.attach(tlsSock);
        ehlo = await c.cmd(helo, 250);
      }
    }
    if (cfg.user) {
      const caps = ehlo.lines.join(' ');
      if (/AUTH[^\n]*\bLOGIN\b/i.test(caps) || !/AUTH[^\n]*\bPLAIN\b/i.test(caps)) {
        await c.cmd('AUTH LOGIN', 334);
        await c.cmd(Buffer.from(cfg.user).toString('base64'), 334);
        await c.cmd(Buffer.from(cfg.pass || '').toString('base64'), 235);
      } else {
        await c.cmd('AUTH PLAIN ' + Buffer.from(`\0${cfg.user}\0${cfg.pass || ''}`).toString('base64'), 235);
      }
    }
    await c.cmd(`MAIL FROM:<${addrOnly(from)}>`, 250);
    await c.cmd(`RCPT TO:<${addrOnly(msg.to)}>`, [250, 251]);
    await c.cmd('DATA', 354);
    c.socket.write(buildMessage({ ...msg, from }) + '\r\n');
    const r = await c.cmd('.', 250);
    c.socket.write('QUIT\r\n');
    return { response: r.lines.join(' ') };
  } finally {
    setTimeout(() => c.socket.destroy(), 500);
  }
}

module.exports = { sendMail, buildMessage, isEmail };
