'use strict';
/* =========================================================================
   Client portal: a client follows their projects (phases, payment
   schedule), downloads files the office shared, and sees their invoices.
   Uses only /api/portal endpoints, which return the client's own data.
   ========================================================================= */
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(+n || 0);
const num = (n, d = 2) => new Intl.NumberFormat('en-IE', { maximumFractionDigits: d }).format(+n || 0);
const fmtDate = s => s ? new Date(String(s).slice(0, 10) + 'T12:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
const STATUS = { active: 'In progress', on_hold: 'On hold', completed: 'Completed', cancelled: 'Cancelled', todo: 'Upcoming', progress: 'In progress', done: 'Done', paid: 'Paid', unpaid: 'Unpaid', partial: 'Partially paid', overdue: 'Overdue', credit: 'Credit note', planned: 'Upcoming', due: 'Due', invoiced: 'Invoiced' };
const badge = s => `<span class="badge b-${esc(s)}">${esc(STATUS[s] || s)}</span>`;
let P = null, tab = 'projects';

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, { method, credentials: 'same-origin', headers: { 'X-Requested-With': 'BizOrganiser', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => null);
  if (!res.ok) { const e = new Error(data?.error || `HTTP ${res.status}`); e.status = res.status; throw e; }
  return data;
}
function toast(msg, kind = 'ok') { const el = document.createElement('div'); el.className = 'toast ' + kind; el.textContent = msg; $('toast-root').appendChild(el); setTimeout(() => el.classList.add('out'), 2800); setTimeout(() => el.remove(), 3200); }

/* ---------- sign-in ---------- */
function screen(html) { $('cp').innerHTML = `<div class="auth"><form class="auth-card" id="f">${html}<p class="auth-err text-bad" id="err"></p></form></div>`; $('cp').querySelector('input')?.focus(); return $('f'); }
const brand = sub => `<div class="brand"><span class="logo">A</span><div><strong>Client portal</strong><small>${esc(sub)}</small></div></div>`;
function showLogin() {
  const f = screen(`${brand('Sign in to follow your project')}
    <div class="field"><label for="em">Email</label><input id="em" type="email" autocomplete="username" required></div>
    <div class="field"><label for="pw">Password</label><input id="pw" type="password" autocomplete="current-password" required></div>
    <button class="btn primary">Sign in</button><p class="muted sm">No login yet? Ask your architect to create one.</p>`);
  f.onsubmit = async e => { e.preventDefault(); try { await api('/api/login', { method: 'POST', body: { email: $('em').value, password: $('pw').value } }); boot(); } catch (err) { $('err').textContent = err.message; } };
}
const pwFields = () => `<div class="field"><label for="cur">Current password</label><input id="cur" type="password" autocomplete="current-password" required></div>
  <div class="field"><label for="n1">New password</label><input id="n1" type="password" autocomplete="new-password" minlength="10" required><small>At least 10 characters, with letters and numbers.</small></div>
  <div class="field"><label for="n2">Repeat new password</label><input id="n2" type="password" autocomplete="new-password" required></div>`;
async function changePw() {
  if ($('n1').value !== $('n2').value) throw new Error('The new passwords do not match.');
  await api('/api/me/password', { method: 'POST', body: { current: $('cur').value, password: $('n1').value } });
}
function showPwChange(user) {
  const f = screen(`${brand('Choose a new password')}<p class="note">Welcome, ${esc(user.name)}. Please replace your temporary password.</p>${pwFields()}<button class="btn primary">Save password</button>`);
  f.onsubmit = async e => { e.preventDefault(); try { await changePw(); boot(); } catch (err) { $('err').textContent = err.message; } };
}
async function logout() { try { await api('/api/logout', { method: 'POST' }); } catch { /* ignore */ } location.reload(); }

/* ---------- main ---------- */
async function boot() {
  let user;
  try { user = (await api('/api/me')).user; } catch (e) { return e.status === 401 ? showLogin() : ($('cp').innerHTML = `<div class="empty-state"><h2>Can't reach the server</h2><p>${esc(e.message)}</p></div>`); }
  if (user.mustChange) return showPwChange(user);
  if (user.role !== 'customer') { $('cp').innerHTML = `<div class="empty-state"><h2>This is the client portal</h2><p>You are signed in as staff. <a href="/">Open BizOrganiser</a> or <a href="#" onclick="logout()">sign out</a>.</p></div>`; return; }
  try { P = await api('/api/portal/bootstrap'); } catch (e) { $('cp').innerHTML = `<div class="empty-state"><h2>Your account isn't ready</h2><p>${esc(e.message)}</p><button class="btn" onclick="logout()">Sign out</button></div>`; return; }
  tab = location.hash.slice(2) || 'projects';
  render();
}
window.addEventListener('hashchange', () => { if (P) { tab = location.hash.slice(2) || 'projects'; render(); window.scrollTo(0, 0); } });
function render() {
  const T = (k, l) => `<a href="#/${k}" class="${tab === k ? 'active' : ''}">${l}</a>`;
  const body = tab === 'invoices' ? viewInvoices() : tab === 'account' ? viewAccount() : viewProjects();
  $('cp').innerHTML = `<div class="portal"><header class="portal-head">
      <div class="brand"><span class="logo">A</span><div><strong>${esc(P.company.name)}</strong><small>Client portal</small></div></div>
      <nav class="ptabs">${T('projects', 'My projects')}${T('invoices', 'Invoices')}${T('account', 'Account')}</nav>
      <div class="portal-who"><span>${esc(P.customer.name)}</span><button class="btn sm" onclick="logout()">Sign out</button></div>
    </header><div class="portal-body">${body}</div></div>`;
}
function viewProjects() {
  if (!P.projects.length) return '<div class="empty-state"><h2>No projects yet</h2></div>';
  return P.projects.map(p => {
    const done = p.phases.filter(x => x.status === 'done').length;
    return `<section class="card porder"><header><h2>${esc(p.name)} <small class="muted">${esc(p.number)}</small></h2><div class="card-actions">${badge(p.status)}</div></header>
      <p class="muted">${esc(p.siteAddress || '')}${p.permitNo ? ` · Building permit ${esc(p.permitNo)}` : ''}</p>
      <h4>Progress — ${done} of ${p.phases.length} phases done</h4>
      <ol class="track">${p.phases.map(ph => `<li class="${ph.status === 'done' ? 'done' : ''}" title="${ph.dueDate ? 'Target ' + fmtDate(ph.dueDate) : ''}">${esc(ph.name)}${ph.status === 'progress' ? '<br><small>in progress</small>' : ''}</li>`).join('')}</ol>
      ${p.installments.length ? `<h4>Payment schedule — total fee ${money(p.fee)} + VAT</h4><div class="table-wrap"><table class="tbl"><tbody>
        ${p.installments.map(i => `<tr><td>${esc(i.label)}</td><td class="num">${num(i.percent)}%</td><td class="num">${money(i.amount)}</td><td>${badge(i.status)}</td></tr>`).join('')}</tbody></table></div>` : ''}
      ${p.files.length || p.links.length ? `<h4>Documents</h4><ul class="plain">
        ${p.files.map(f => `<li>📎 <a href="/api/portal/files/${esc(f.fileId)}" target="_blank" rel="noopener">${esc(f.name)}</a> <small class="muted">${esc(f.category || '')} · ${fmtDate(f.addedAt)}</small></li>`).join('')}
        ${p.links.map(l => `<li>🔗 <a href="${esc(/^https?:\/\//i.test(l.url) ? l.url : '#')}" target="_blank" rel="noopener">${esc(l.title)}</a></li>`).join('')}</ul>` : ''}
    </section>`;
  }).join('');
}
function viewInvoices() {
  const open = P.invoices.reduce((a, i) => a + i.balance, 0);
  return `<div class="kpis"><div class="kpi"><div class="kpi-label">Open balance</div><div class="kpi-value">${money(open)}</div></div></div>
    <section class="card"><header><h2>Invoices & receipts</h2></header>${P.invoices.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>Number</th><th>Project</th><th>Date</th><th class="num">Total</th><th class="num">To pay</th><th class="num">Balance</th><th>Status</th><th></th></tr></thead><tbody>
    ${P.invoices.map(i => `<tr><td><b>${esc(i.number)}</b></td><td>${esc(i.project || '')}</td><td>${fmtDate(i.date)}</td><td class="num">${money(i.total)}</td><td class="num">${money(i.payable)}</td><td class="num">${money(i.balance)}</td><td>${badge(i.status)}</td><td><button class="btn xs" onclick="printInvoice('${i.id}')">PDF</button></td></tr>`).join('')}
    </tbody></table></div>` : '<div class="empty">No invoices yet.</div>'}
    ${open > 0 && P.company.iban ? `<p class="muted sm">Pay by bank transfer to ${esc(P.company.name)} · IBAN ${esc(P.company.iban)} · reference: invoice number.</p>` : ''}</section>`;
}
function printInvoice(id) {
  const i = P.invoices.find(x => x.id === id); const c = P.company;
  $('print-area').innerHTML = `<div class="print-doc"><header><div><h1>${esc(c.name)}</h1><div>${esc(c.address)}<br>VAT ${esc(c.vat)} · ${esc(c.taxOffice || '')}</div></div>
    <div class="pd-title"><h2>${esc(i.typeLabel)}</h2><div>No. <b>${esc(i.number)}</b><br>Date ${fmtDate(i.date)}</div></div></header>
    <section class="pd-party"><b>${esc(P.customer.name)}</b><br>${esc(P.customer.address || '')} ${esc(P.customer.city || '')}${P.customer.vat ? '<br>VAT ' + esc(P.customer.vat) : ''}</section>
    <table><tbody>${i.lines.map(l => `<tr><td>${esc(l.desc)}</td><td class="num">${money(l.qty * l.price * (1 - (l.discount || 0) / 100))}</td></tr>`).join('')}</tbody></table>
    <table class="pd-totals"><tr><td>Net</td><td>${money(i.net)}</td></tr><tr><td>VAT</td><td>${money(i.vat)}</td></tr><tr><td>Total</td><td>${money(i.total)}</td></tr>${i.withheld ? `<tr><td>Withholding</td><td>−${money(i.withheld)}</td></tr>` : ''}<tr class="grand"><td>To pay</td><td>${money(i.payable)}</td></tr></table>
    ${i.mark ? `<div class="pd-mydata">myDATA MARK: <b>${esc(i.mark)}</b></div>` : ''}</div>`;
  window.print();
}
function viewAccount() {
  const c = P.customer;
  return `<div class="grid-2"><section class="card"><header><h2>Your details</h2></header><dl class="dl"><dt>Name</dt><dd>${esc(c.name)}</dd><dt>VAT</dt><dd>${esc(c.vat || '—')}</dd><dt>Email</dt><dd>${esc(c.email || '')}</dd><dt>Phone</dt><dd>${esc(c.phone || '')}</dd><dt>Address</dt><dd>${esc(c.address || '')}, ${esc(c.city || '')}</dd></dl>
    <p class="muted sm">To change these details, contact ${esc(P.company.name)} at ${esc(P.company.email)} or ${esc(P.company.phone)}.</p></section>
    <section class="card"><header><h2>Change password</h2></header><form id="pwf" class="form-grid" style="grid-template-columns:1fr">${pwFields()}<div><button class="btn primary">Change password</button></div></form></section></div>`;
}
document.addEventListener('submit', async e => {
  if (e.target.id !== 'pwf') return;
  e.preventDefault();
  try { await changePw(); toast('Password changed'); render(); } catch (err) { toast(err.message, 'err'); }
});
boot();
