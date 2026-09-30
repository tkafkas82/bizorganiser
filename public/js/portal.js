'use strict';
/* =========================================================================
   B2B Link — customer-facing ordering portal (24/7 ordering, customer
   pricing, live stock, rep ordering on behalf of customers)
   ========================================================================= */

const PORTAL = { cart: {} }; // customerId -> [{productId, qty}]
const ORDER_TRACK = ['pending', 'new', 'production', 'ready', 'shipped', 'delivered'];

function portalCustomer() {
  let c = byId('customers', db.session.portalCustomerId);
  if (!c) { c = db.customers[0]; if (c) db.session.portalCustomerId = c.id; }
  return c;
}
const portalRep = () => byId('reps', db.session.portalRep);
const portalCart = () => (PORTAL.cart[db.session.portalCustomerId] = PORTAL.cart[db.session.portalCustomerId] || []);

page('portal', {
  title: 'B2B Link',
  perm: () => 'portal',
  render(tab = 'catalog') {
    const c = portalCustomer();
    if (!c) return `<div class="empty-state"><h2>No customers yet</h2><p>Add a customer first. <a href="#/customers">Customers</a></p></div>`;
    const rep = portalRep(); const cart = portalCart();
    const n = sum(cart, x => x.qty > 0 ? 1 : 0);
    const T = (k, l) => `<a href="#/portal/${k}" class="${tab === k ? 'active' : ''}">${l}</a>`;
    const head = `<header class="portal-head">
      <div class="brand"><span class="logo">B2B</span><div><strong>${esc(db.settings.company.name)}</strong><small>B2B Link — order 24/7</small></div></div>
      <nav class="ptabs">${T('catalog', 'Catalogue')}${T('cart', `Cart${n ? ` <span class="pill">${n}</span>` : ''}`)}${T('orders', 'My orders')}${T('account', 'Account')}</nav>
      <div class="portal-who">
        <label>Customer <select onchange="db.session.portalCustomerId=this.value;saveDB();rerender()">${opt(db.customers, c.id)}</select></label>
        <label>Acting as <select onchange="db.session.portalRep=this.value;saveDB();rerender()"><option value="">Preview as the customer</option>${db.reps.map(r => `<option value="${r.id}" ${rep?.id === r.id ? 'selected' : ''}>Rep: ${esc(r.name)}</option>`).join('')}</select></label>
        <a class="btn sm" href="#/dashboard">← Back to BizOrganiser</a>
      </div></header>
      ${rep ? '' : `<div class="note">Staff preview of the B2B portal. Customers use their own login at <a href="/b2b/" target="_blank">/b2b/</a> (create logins in <a href="#/settings/users">Settings → Users</a>). Pick a sales rep under “Acting as” to place orders on a customer's behalf.</div>`}
      ${rep ? `<div class="note">You're signed in as sales rep <b>${esc(rep.name)}</b> on behalf of <b>${esc(c.name)}</b>. Orders you place wait for the customer to confirm, and your commission (${rep.commission}%) is recorded.</div>` : ''}`;
    let body;
    if (tab === 'cart') body = portalCartView(c, cart, rep);
    else if (tab === 'orders') body = portalOrders(c, rep);
    else if (tab === 'account') body = portalAccount(c);
    else body = portalCatalog(c);
    return `<div class="portal">${head}<div class="portal-body">${body}</div></div>`;
  },
});

function portalCatalog(c) {
  const cat = UI.portalCat || '';
  const prods = db.products.filter(p => p.b2b && p.kind !== 'material');
  const cats = [...new Set(prods.map(p => p.category))].sort();
  const pl = byId('priceLists', c.priceListId);
  return `<div class="toolbar"><div class="chips"><button class="chip ${!cat ? 'active' : ''}" onclick="UI.portalCat='';rerender()">All</button>${cats.map(x => `<button class="chip ${cat === x ? 'active' : ''}" onclick="UI.portalCat='${esc(x)}';rerender()">${esc(x)}</button>`).join('')}</div>
    <span class="spacer"></span><input class="filter" placeholder="Search products…" oninput="portalFilter(this.value)"></div>
    ${pl ? `<p class="muted sm">Your prices: <b>${esc(pl.name)}</b></p>` : ''}
    <div class="pgrid">${prods.filter(p => !cat || p.category === cat).map(p => {
      const price = priceFor(c, p);
      const stock = p.kind === 'service' ? '<span class="stock ok">Available</span>' : p.stock <= 0 ? '<span class="stock out">Out of stock — backorder</span>' : p.stock <= p.minStock ? `<span class="stock low">Low stock (${num(p.stock)})</span>` : `<span class="stock ok">In stock (${num(p.stock)})</span>`;
      return `<div class="pcard" data-text="${esc((p.name + ' ' + p.sku + ' ' + p.category + ' ' + p.description).toLowerCase())}">
        ${productThumb(p, 'lg')}
        <div class="pcard-body"><small class="muted">${esc(p.category)} · ${esc(p.sku)}</small><h4>${esc(p.name)}</h4>
        ${p.description ? `<p class="sm">${esc(p.description)}</p>` : ''}
        <div class="price">${money(price)} <small>/ ${esc(p.unit)} + VAT</small>${price < p.price ? ` <s class="muted sm">${money(p.price)}</s>` : ''}</div>${stock}
        <div class="add"><input type="number" min="1" step="1" value="1" id="pq-${p.id}" class="num w-sm"><button class="btn primary sm" onclick="portalAdd('${p.id}')">Add to cart</button></div></div></div>`;
    }).join('')}</div>`;
}
function portalFilter(q) {
  q = q.toLowerCase();
  document.querySelectorAll('.pcard').forEach(el => { el.hidden = !el.dataset.text.includes(q); });
}
function portalAdd(pid) {
  const qty = +document.getElementById('pq-' + pid).value || 1;
  const cart = portalCart(); const it = cart.find(x => x.productId === pid);
  if (it) it.qty += qty; else cart.push({ productId: pid, qty });
  toast(`Added ${qty} × ${nameOf('products', pid)}`); rerender();
}
function portalQty(pid, v) {
  const cart = portalCart(); const it = cart.find(x => x.productId === pid);
  if (it) it.qty = Math.max(0, +v || 0);
  PORTAL.cart[db.session.portalCustomerId] = cart.filter(x => x.qty > 0);
  rerender();
}
function portalCartView(c, cart, rep) {
  if (!cart.length) return `<div class="empty-state"><h2>Your cart is empty</h2><p><a href="#/portal/catalog" class="btn primary">Browse the catalogue</a></p></div>`;
  const lines = cart.map(it => { const p = byId('products', it.productId); return { productId: p.id, desc: p.name, qty: it.qty, unitCost: p.cost, price: priceFor(c, p), discount: 0, p }; });
  const t = totals(lines);
  return card('Cart', table([
    { label: '', render: l => productThumb(l.p) },
    { label: 'Product', render: l => `<b>${esc(l.desc)}</b>${l.p.kind !== 'service' && l.p.stock < l.qty ? `<br><small class="text-warn">Only ${num(Math.max(0, l.p.stock))} in stock — the rest will be backordered</small>` : ''}` },
    { label: 'Unit price', cls: 'num', render: l => money(l.price) },
    { label: 'Qty', cls: 'num', render: l => `<input type="number" min="0" class="num w-sm" value="${l.qty}" onchange="portalQty('${l.productId}',this.value)">` },
    { label: 'Amount', cls: 'num', render: l => money(lineNet(l)) },
  ], lines, { foot: `<tfoot><tr><td colspan="4">Net</td><td class="num">${money(t.net)}</td></tr><tr><td colspan="4">VAT ${db.settings.vatRate}%</td><td class="num">${money(t.vat)}</td></tr><tr class="grand"><td colspan="4">Total</td><td class="num">${money(t.total)}</td></tr></tfoot>` })) +
    card('Checkout', `<div class="form-grid">
      ${fieldHTML({ name: 'p_address', label: 'Delivery address', full: true }, `${c.address}, ${c.city}`)}
      ${fieldHTML({ name: 'p_pay', label: 'Payment', type: 'select', options: PAY_METHODS }, c.paymentTerms ? 'bank' : 'cod')}
      ${fieldHTML({ name: 'p_ref', label: 'Your reference / PO no.' }, '')}
      ${fieldHTML({ name: 'p_notes', label: 'Notes', type: 'textarea', full: true }, '')}
    </div><div class="btn-row"><span class="spacer"></span><button class="btn primary" onclick="portalPlaceOrder()">${rep ? 'Prepare order for customer to confirm' : 'Place order'}</button></div>`);
}
function portalPlaceOrder() {
  const c = portalCustomer(); const rep = portalRep(); const cart = portalCart();
  if (!cart.length) return;
  const lines = cart.map(it => { const p = byId('products', it.productId); return { productId: p.id, desc: p.name, qty: it.qty, unitCost: p.cost, price: priceFor(c, p), discount: 0 }; });
  const ref = document.getElementById('f_p_ref').value.trim();
  const notes = [ref && `Customer ref: ${ref}`, `Deliver to: ${document.getElementById('f_p_address').value}`, document.getElementById('f_p_notes').value.trim()].filter(Boolean).join('\n');
  const o = { id: uid(), number: nextNo('order'), customerId: c.id, repId: rep?.id || c.repId, date: today(), dueDate: addDays(today(), 5), lines, notes, source: 'b2b', paymentMethod: document.getElementById('f_p_pay').value, status: rep ? 'pending' : 'new', createdByRep: rep?.id, ...totals(lines) };
  applyStock(lines, -1, o.number + ' (B2B)'); db.orders.push(o);
  autoEmail('b2bOrder', db.settings.company.email, { customer: c.name, number: o.number, total: money(o.total) }, o.number);
  if (rep) logEmail({ to: c.email, subject: `Please confirm order ${o.number}`, body: `Dear ${c.name},\n\n${rep.name} has prepared order ${o.number} (${money(o.total)}) for you. Please review and confirm it on the B2B portal.\n\n${db.settings.company.name}`, ref: o.number, customerId: c.id, auto: true });
  else orderConfirmedEmail(o);
  PORTAL.cart[c.id] = [];
  saveDB(); toast(rep ? `Order ${o.number} sent to the customer to confirm` : `Order ${o.number} placed — thank you!`); go('portal/orders');
}
function portalOrders(c, rep) {
  const orders = db.orders.filter(o => o.customerId === c.id && o.status !== 'cancelled').sort((a, b) => b.date.localeCompare(a.date));
  if (!orders.length) return `<div class="empty">No orders yet.</div>`;
  return orders.map(o => {
    const idx = ORDER_TRACK.indexOf(o.status); const dl = byId('deliveries', o.deliveryId);
    return `<section class="card porder"><header><h2>${esc(o.number)} <small class="muted">${fmtDate(o.date)}</small></h2><div class="card-actions">${badge(o.status)}${o.source === 'b2b' ? '' : ' <span class="tag">by phone/email</span>'}</div></header>
      <ol class="track">${ORDER_TRACK.slice(o.status === 'pending' ? 0 : 1).map(s => `<li class="${ORDER_TRACK.indexOf(s) <= idx ? 'done' : ''}">${STATUS[s]}</li>`).join('')}</ol>
      <p>${esc(o.lines.map(l => `${num(l.qty, 2)}× ${l.desc}`).join(' · '))}</p>
      <div class="btn-row"><b>${money(o.total)}</b>${dl ? `<span class="muted">${esc(dl.courier)} · tracking <span class="mono">${esc(dl.tracking)}</span></span>` : ''}<span class="spacer"></span>
      ${o.status === 'pending' && !rep ? `<button class="btn primary sm" onclick="portalConfirm('${o.id}')">✓ Confirm order</button>` : ''}
      ${o.status === 'pending' && rep ? '<span class="muted sm">Waiting for customer confirmation</span>' : ''}
      <button class="btn sm" onclick="portalReorder('${o.id}')">↻ Order again</button></div></section>`;
  }).join('');
}
function portalConfirm(id) { const o = byId('orders', id); o.status = 'new'; orderConfirmedEmail(o); saveDB(); toast('Order confirmed'); rerender(); }
function portalReorder(id) {
  const o = byId('orders', id); const cart = portalCart();
  o.lines.filter(l => byId('products', l.productId)?.b2b).forEach(l => { const it = cart.find(x => x.productId === l.productId); if (it) it.qty += l.qty; else cart.push({ productId: l.productId, qty: l.qty }); });
  toast('Items added to cart at your current prices'); go('portal/cart');
}
function portalAccount(c) {
  const year = today().slice(0, 4);
  const inv = db.invoices.filter(i => i.customerId === c.id && !i.cancelled).sort((a, b) => b.date.localeCompare(a.date));
  const lines = inv.filter(i => i.date.startsWith(year)).flatMap(i => i.lines.map(l => isCredit(i) ? { ...l, qty: -l.qty } : l));
  const byProd = [...groupBy(lines, l => l.desc)].map(([k, ls]) => ({ label: k, value: sum(ls, lineNet) })).sort((a, b) => b.value - a.value);
  return `<div class="kpis">
    ${kpi(`Purchases ${year}`, money(sum(inv.filter(i => i.date.startsWith(year)), invNet)), 'net')}
    ${kpi('Open balance', money(sum(inv, balanceOf)))}
    ${kpi('Orders', db.orders.filter(o => o.customerId === c.id).length)}
    ${kpi('Price list', esc(nameOf('priceLists', c.priceListId, 'Standard')))}
  </div>
  <div class="grid-2">${card(`What you bought in ${year}`, hbars(byProd))}
  ${card('Invoices', table([
    { label: 'Invoice', render: i => esc(i.number) }, { label: 'Date', render: i => fmtDate(i.date) },
    { label: 'Total', cls: 'num', render: i => money(i.total) }, { label: 'Balance', cls: 'num', render: i => money(balanceOf(i)) },
    { label: 'Status', render: i => badge(invStatus(i)) }, { label: '', render: i => `<button class="btn xs" onclick="printInvoice('${i.id}')">PDF</button>` },
  ], inv, { empty: 'No invoices yet.' }))}</div>`;
}
