'use strict';
/* =========================================================================
   B2B Link — customer portal. Uses only the /api/portal endpoints, so a
   customer's browser never receives data that belongs to other customers.
   ========================================================================= */
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(+n || 0);
const num = (n, d = 2) => new Intl.NumberFormat('en-IE', { maximumFractionDigits: d }).format(+n || 0);
const fmtDate = s => s ? new Date(s + 'T12:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
const round2 = n => Math.round((+n || 0) * 100) / 100;
const STATUS = { pending: 'Awaiting your confirmation', new: 'Received', production: 'In production', ready: 'Ready', shipped: 'Shipped', delivered: 'Delivered', paid: 'Paid', unpaid: 'Unpaid', partial: 'Partially paid', overdue: 'Overdue', credit: 'Credit note' };
const badge = s => `<span class="badge b-${esc(s)}">${esc(STATUS[s] || s)}</span>`;
const TRACK = ['new', 'production', 'ready', 'shipped', 'delivered'];
let P = null;            // bootstrap data
let tab = 'catalog', cat = '', q = '';

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, { method, credentials: 'same-origin', headers: { 'X-Requested-With': 'BizOrganiser', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => null);
  if (!res.ok) { const e = new Error(data?.error || `HTTP ${res.status}`); e.status = res.status; throw e; }
  return data;
}
function toast(msg, kind = 'ok') {
  const el = document.createElement('div'); el.className = 'toast ' + kind; el.textContent = msg;
  $('toast-root').appendChild(el); setTimeout(() => el.classList.add('out'), 2800); setTimeout(() => el.remove(), 3200);
}

/* ---------- cart (kept in this browser, per customer) ---------- */
const cartKey = () => 'b2b.cart.' + (P?.customer.id || '');
function getCart() { try { return JSON.parse(localStorage.getItem(cartKey()) || '[]'); } catch { return []; } }
function setCart(c) { try { localStorage.setItem(cartKey(), JSON.stringify(c)); } catch { /* storage blocked: cart lives until reload */ } CART = c; }
let CART = [];

/* ---------- auth screens ---------- */
function screen(html) { $('b2b').innerHTML = `<div class="auth"><form class="auth-card" id="f">${html}<p class="auth-err text-bad" id="err"></p></form></div>`; $('b2b').querySelector('input')?.focus(); return $('f'); }
const brand = sub => `<div class="brand"><span class="logo" style="background:#f59e0b">B2B</span><div><strong>B2B Link</strong><small>${esc(sub)}</small></div></div>`;
function showLogin() {
  const f = screen(`${brand('Customer portal — sign in')}
    <div class="field"><label for="em">Email</label><input id="em" type="email" autocomplete="username" required></div>
    <div class="field"><label for="pw">Password</label><input id="pw" type="password" autocomplete="current-password" required></div>
    <button class="btn primary">Sign in</button><p class="muted sm">No login yet? Ask your account manager to create one.</p>`);
  f.onsubmit = async e => { e.preventDefault(); try { await api('/api/login', { method: 'POST', body: { email: $('em').value, password: $('pw').value } }); boot(); } catch (err) { $('err').textContent = err.message; } };
}
function pwFields() {
  return `<div class="field"><label for="cur">Current password</label><input id="cur" type="password" autocomplete="current-password" required></div>
    <div class="field"><label for="n1">New password</label><input id="n1" type="password" autocomplete="new-password" minlength="10" required><small>At least 10 characters, with letters and numbers.</small></div>
    <div class="field"><label for="n2">Repeat new password</label><input id="n2" type="password" autocomplete="new-password" required></div>`;
}
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
  try { user = (await api('/api/me')).user; } catch (e) { return e.status === 401 ? showLogin() : ($('b2b').innerHTML = `<div class="empty-state"><h2>Can't reach the server</h2><p>${esc(e.message)}</p></div>`); }
  if (user.mustChange) return showPwChange(user);
  if (user.role !== 'customer') { $('b2b').innerHTML = `<div class="empty-state"><h2>This is the customer portal</h2><p>You are signed in as staff. <a href="/">Open BizOrganiser</a> or <a href="#" onclick="logout()">sign out</a>.</p></div>`; return; }
  try { P = await api('/api/portal/bootstrap'); } catch (e) { $('b2b').innerHTML = `<div class="empty-state"><h2>Your account isn't ready</h2><p>${esc(e.message)}</p><button class="btn" onclick="logout()">Sign out</button></div>`; return; }
  CART = getCart().filter(i => P.products.some(p => p.id === i.productId));
  tab = (location.hash.slice(2) || 'catalog');
  render();
}
window.addEventListener('hashchange', () => { if (P) { tab = location.hash.slice(2) || 'catalog'; render(); window.scrollTo(0, 0); } });
async function refresh() { P = await api('/api/portal/bootstrap'); render(); }

function render() {
  const n = CART.length;
  const T = (k, l) => `<a href="#/${k}" class="${tab === k ? 'active' : ''}">${l}</a>`;
  const pending = P.orders.filter(o => o.status === 'pending').length;
  const body = tab === 'cart' ? viewCart() : tab === 'orders' ? viewOrders() : tab === 'invoices' ? viewInvoices() : tab === 'account' ? viewAccount() : viewCatalog();
  $('b2b').innerHTML = `<div class="portal"><header class="portal-head">
      <div class="brand"><span class="logo">B2B</span><div><strong>${esc(P.company.name)}</strong><small>B2B Link — order 24/7</small></div></div>
      <nav class="ptabs">${T('catalog', 'Catalogue')}${T('cart', `Cart${n ? ` <span class="pill">${n}</span>` : ''}`)}${T('orders', `Orders${pending ? ` <span class="pill">${pending}</span>` : ''}`)}${T('invoices', 'Invoices')}${T('account', 'Account')}</nav>
      <div class="portal-who"><span>${esc(P.customer.name)}</span><button class="btn sm" onclick="logout()">Sign out</button></div>
    </header>
    ${pending && tab !== 'orders' ? `<div class="note warn" style="margin:12px 24px 0">Your account manager prepared ${pending} order(s) for you. <a href="#/orders">Review and confirm</a>.</div>` : ''}
    <div class="portal-body">${body}</div></div>`;
}
const thumb = p => p.image ? `<img class="thumb lg" src="${esc(p.image)}" alt="">` : `<span class="thumb ph lg" style="background:${color(p.category)}">${esc(p.name.replace(/[^A-Za-z]/g, '').slice(0, 2).toUpperCase())}</span>`;
function color(cat) { let h = 0; for (const ch of String(cat)) h = (h * 31 + ch.charCodeAt(0)) % 360; return `hsl(${h} 55% 45%)`; }
const stockLabel = p => p.availability === 'available' ? '<span class="stock ok">Available</span>' : p.availability === 'out' ? '<span class="stock out">Out of stock — can be backordered</span>' : p.availability === 'low' ? `<span class="stock low">Low stock (${num(p.stock, 0)})</span>` : `<span class="stock ok">In stock (${num(p.stock, 0)})</span>`;

function viewCatalog() {
  const cats = [...new Set(P.products.map(p => p.category))].sort();
  const list = P.products.filter(p => (!cat || p.category === cat) && (!q || (p.name + ' ' + p.sku + ' ' + p.description).toLowerCase().includes(q)));
  return `<div class="toolbar"><div class="chips"><button class="chip ${!cat ? 'active' : ''}" onclick="cat='';render()">All</button>${cats.map((c, i) => `<button class="chip ${cat === c ? 'active' : ''}" onclick="cat=${esc(JSON.stringify(c))};render()">${esc(c)}</button>`).join('')}</div>
    <span class="spacer"></span><input class="filter" placeholder="Search products…" value="${esc(q)}" oninput="q=this.value.toLowerCase();document.getElementById('grid').innerHTML=gridHTML()"></div>
    <p class="muted sm">Your prices: <b>${esc(P.customer.priceList)}</b> · prices exclude VAT (${P.vatRate}%)</p>
    <div class="pgrid" id="grid">${gridHTML(list)}</div>`;
}
function gridHTML(list) {
  list = list || P.products.filter(p => (!cat || p.category === cat) && (!q || (p.name + ' ' + p.sku + ' ' + p.description).toLowerCase().includes(q)));
  if (!list.length) return '<div class="empty">No products match.</div>';
  return list.map(p => `<div class="pcard">${thumb(p)}<div class="pcard-body"><small class="muted">${esc(p.category)} · ${esc(p.sku)}</small><h4>${esc(p.name)}</h4>
    ${p.description ? `<p class="sm">${esc(p.description)}</p>` : ''}
    <div class="price">${money(p.price)} <small>/ ${esc(p.unit)} + VAT</small>${p.price < p.listPrice ? ` <s class="muted sm">${money(p.listPrice)}</s>` : ''}</div>${stockLabel(p)}
    <div class="add"><input type="number" min="1" step="1" value="1" id="q-${p.id}" class="num w-sm" aria-label="Quantity"><button class="btn primary sm" onclick="addToCart('${p.id}')">Add to cart</button></div></div></div>`).join('');
}
function addToCart(id, qty) {
  qty = qty ?? (+$('q-' + id).value || 1);
  const c = [...CART]; const it = c.find(x => x.productId === id);
  if (it) it.qty = round2(it.qty + qty); else c.push({ productId: id, qty });
  setCart(c); toast(`Added ${num(qty)} × ${P.products.find(p => p.id === id)?.name}`); render();
}
function setQty(id, v) { setCart(CART.map(x => x.productId === id ? { ...x, qty: Math.max(0, +v || 0) } : x).filter(x => x.qty > 0)); render(); }

function viewCart() {
  if (!CART.length) return `<div class="empty-state"><h2>Your cart is empty</h2><p><a class="btn primary" href="#/catalog">Browse the catalogue</a></p></div>`;
  const lines = CART.map(i => ({ ...i, p: P.products.find(p => p.id === i.productId) })).filter(l => l.p);
  const net = round2(lines.reduce((a, l) => a + round2(l.qty * l.p.price), 0)), vat = round2(net * P.vatRate / 100);
  return `<section class="card"><header><h2>Cart</h2></header><div class="table-wrap"><table class="tbl"><thead><tr><th>Product</th><th class="num">Unit price</th><th class="num">Qty</th><th class="num">Amount</th></tr></thead><tbody>
    ${lines.map(l => `<tr><td><b>${esc(l.p.name)}</b>${l.p.stock !== null && l.p.stock < l.qty ? `<br><small class="text-warn">Only ${num(l.p.stock, 0)} in stock — the rest will be backordered</small>` : ''}</td>
      <td class="num">${money(l.p.price)}</td><td class="num"><input type="number" min="0" class="num w-sm" value="${l.qty}" onchange="setQty('${l.productId}',this.value)" aria-label="Quantity"></td><td class="num">${money(l.qty * l.p.price)}</td></tr>`).join('')}
    </tbody><tfoot><tr><td colspan="3">Net</td><td class="num">${money(net)}</td></tr><tr><td colspan="3">VAT ${P.vatRate}%</td><td class="num">${money(vat)}</td></tr><tr class="grand"><td colspan="3">Total</td><td class="num">${money(net + vat)}</td></tr></tfoot></table></div></section>
    <section class="card"><header><h2>Checkout</h2></header><div class="form-grid">
      <div class="field full"><label for="addr">Delivery address</label><input id="addr" value="${esc(`${P.customer.address}, ${P.customer.city}`)}"></div>
      <div class="field"><label for="pay">Payment</label><select id="pay"><option value="bank">Bank transfer${P.customer.paymentTerms ? ` (${P.customer.paymentTerms} days)` : ''}</option><option value="cod">Cash on delivery</option><option value="card">Card</option></select></div>
      <div class="field"><label for="ref">Your reference / PO number</label><input id="ref" maxlength="60"></div>
      <div class="field full"><label for="notes">Notes</label><textarea id="notes" rows="3" maxlength="1000"></textarea></div>
    </div><div class="btn-row"><span class="muted sm">Final prices are confirmed on your order confirmation email.</span><span class="spacer"></span><button class="btn primary" id="place" onclick="placeOrder()">Place order</button></div></section>`;
}
async function placeOrder() {
  $('place').disabled = true;
  try {
    const r = await api('/api/portal/orders', { method: 'POST', body: { lines: CART.map(({ productId, qty }) => ({ productId, qty })), address: $('addr').value, paymentMethod: $('pay').value, reference: $('ref').value, notes: $('notes').value } });
    setCart([]); toast(`Order ${r.number} placed — thank you!`); location.hash = '#/orders'; await refresh();
  } catch (e) { toast(e.message, 'err'); $('place').disabled = false; }
}
function viewOrders() {
  if (!P.orders.length) return '<div class="empty">No orders yet.</div>';
  return P.orders.map(o => {
    const idx = TRACK.indexOf(o.status);
    return `<section class="card porder"><header><h2>${esc(o.number)} <small class="muted">${fmtDate(o.date)}</small></h2><div class="card-actions">${badge(o.status)}</div></header>
      ${o.status === 'pending' ? `<div class="note warn">Prepared for you by ${esc(o.preparedByRep || 'your account manager')}. Please check and confirm.</div>` : `<ol class="track">${TRACK.map((s, i) => `<li class="${i <= idx ? 'done' : ''}">${STATUS[s]}</li>`).join('')}</ol>`}
      <p>${esc(o.lines.map(l => `${num(l.qty)}× ${l.desc}`).join(' · '))}</p>
      <div class="btn-row"><b>${money(o.total)}</b> <span class="muted sm">incl. VAT</span>${o.delivery ? `<span class="muted">${esc(o.delivery.courier)} · tracking <span class="mono">${esc(o.delivery.tracking || 'pending')}</span></span>` : ''}<span class="spacer"></span>
      ${o.status === 'pending' ? `<button class="btn primary sm" onclick="confirmOrder('${o.id}')">✓ Confirm order</button>` : ''}
      <button class="btn sm" onclick="reorder('${o.id}')">↻ Order again</button></div></section>`;
  }).join('');
}
async function confirmOrder(id) { try { await api(`/api/portal/orders/${encodeURIComponent(id)}/confirm`, { method: 'POST', body: {} }); toast('Order confirmed'); await refresh(); } catch (e) { toast(e.message, 'err'); } }
function reorder(id) {
  const o = P.orders.find(x => x.id === id); let added = 0;
  const c = [...CART];
  for (const l of o.lines) { if (!P.products.some(p => p.id === l.productId)) continue; const it = c.find(x => x.productId === l.productId); if (it) it.qty += l.qty; else c.push({ productId: l.productId, qty: l.qty }); added++; }
  setCart(c); toast(added ? 'Items added to your cart at your current prices' : 'These items are no longer in the catalogue', added ? 'ok' : 'warn'); location.hash = '#/cart';
}
function viewInvoices() {
  const open = P.invoices.reduce((a, i) => a + i.balance, 0);
  return `<div class="kpis"><div class="kpi"><div class="kpi-label">Open balance</div><div class="kpi-value">${money(open)}</div></div>
    <div class="kpi"><div class="kpi-label">Invoices</div><div class="kpi-value">${P.invoices.filter(i => i.type !== '5.1').length}</div></div></div>
    <section class="card"><header><h2>Invoices & credit notes</h2></header>${P.invoices.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>Number</th><th>Date</th><th>Due</th><th class="num">Total</th><th class="num">Balance</th><th>Status</th><th></th></tr></thead><tbody>
    ${P.invoices.map(i => `<tr><td><b>${esc(i.number)}</b></td><td>${fmtDate(i.date)}</td><td>${i.type === '5.1' ? '' : fmtDate(i.dueDate)}</td><td class="num">${money(i.total)}</td><td class="num">${money(i.balance)}</td><td>${badge(i.status)}</td><td><button class="btn xs" onclick="printInvoice('${i.id}')">PDF</button></td></tr>`).join('')}
    </tbody></table></div>` : '<div class="empty">No invoices yet.</div>'}
    ${open > 0 && P.company.iban ? `<p class="muted sm">Pay by bank transfer to ${esc(P.company.name)} · IBAN ${esc(P.company.iban)} · reference: invoice number.</p>` : ''}</section>`;
}
function printInvoice(id) {
  const i = P.invoices.find(x => x.id === id); const c = P.company;
  const lineNet = l => round2(l.qty * l.price * (1 - (l.discount || 0) / 100));
  $('print-area').innerHTML = `<div class="print-doc"><header><div><h1>${esc(c.name)}</h1><div>${esc(c.address)}<br>VAT ${esc(c.vat)} · ${esc(c.taxOffice || '')}<br>${esc(c.phone)} · ${esc(c.email)}</div></div>
    <div class="pd-title"><h2>${i.type === '5.1' ? 'Credit note' : 'Invoice'}</h2><div>No. <b>${esc(i.number)}</b><br>Date ${fmtDate(i.date)}</div></div></header>
    <section class="pd-party"><b>${esc(P.customer.name)}</b><br>${esc(P.customer.address)} ${esc(P.customer.city)}<br>VAT ${esc(P.customer.vat)}</section>
    <table><thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Amount</th></tr></thead><tbody>${i.lines.map(l => `<tr><td>${esc(l.desc)}</td><td class="num">${num(l.qty)}</td><td class="num">${money(l.price)}</td><td class="num">${money(lineNet(l))}</td></tr>`).join('')}</tbody></table>
    <table class="pd-totals"><tr><td>Net</td><td>${money(i.net)}</td></tr><tr><td>VAT</td><td>${money(i.vat)}</td></tr><tr class="grand"><td>Total</td><td>${money(i.total)}</td></tr></table>
    ${i.mark ? `<div class="pd-mydata">myDATA MARK: <b>${esc(i.mark)}</b></div>` : ''}</div>`;
  window.print();
}
function viewAccount() {
  const c = P.customer;
  return `<div class="grid-2"><section class="card"><header><h2>Your company</h2></header><dl class="dl"><dt>Name</dt><dd>${esc(c.name)}</dd><dt>VAT</dt><dd>${esc(c.vat || '—')}</dd><dt>Email</dt><dd>${esc(c.email)}</dd><dt>Phone</dt><dd>${esc(c.phone)}</dd><dt>Address</dt><dd>${esc(c.address)}, ${esc(c.city)}</dd><dt>Price list</dt><dd>${esc(c.priceList)}</dd><dt>Payment terms</dt><dd>${c.paymentTerms ? c.paymentTerms + ' days' : 'Immediate'}</dd></dl>
    <p class="muted sm">To change these details, contact ${esc(P.company.name)} at ${esc(P.company.email)} or ${esc(P.company.phone)}.</p></section>
    <section class="card"><header><h2>Change password</h2></header><form id="pwf" class="form-grid" style="grid-template-columns:1fr">${pwFields()}<div><button class="btn primary">Change password</button></div></form></section></div>`;
}
document.addEventListener('submit', async e => {
  if (e.target.id !== 'pwf') return;
  e.preventDefault();
  try { await changePw(); toast('Password changed'); render(); } catch (err) { toast(err.message, 'err'); }
});
boot();
