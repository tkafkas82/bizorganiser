'use strict';
/* =========================================================================
   Sales & operations: document editor (quotes / orders / POs), quotes,
   orders (+ daily board, shortages), production, deliveries, invoices
   ========================================================================= */

const DOCS = {
  quote: { col: 'quotes', label: 'Quote', list: 'quotes', party: 'customer' },
  order: { col: 'orders', label: 'Sales order', list: 'orders', party: 'customer' },
  po: { col: 'purchaseOrders', label: 'Purchase order', list: 'purchasing', party: 'supplier' },
};
const INV_TYPES = { '1.1': 'Sales invoice (1.1)', '2.1': 'Service invoice (2.1)', '11.1': 'Retail receipt (11.1)', '5.1': 'Credit note (5.1)' };
const PAY_METHODS = [['bank', 'Bank transfer'], ['card', 'Card'], ['cod', 'Cash on delivery'], ['cash', 'Cash']];

/* ---------- document editor ---------- */
let ED = null;
const blankLine = () => ({ productId: '', desc: '', qty: 1, unitCost: 0, price: 0, discount: 0 });

function createDraft(kind, preset = {}) {
  const t = today();
  const doc = { id: uid(), number: '', date: t, status: kind === 'order' ? 'new' : 'draft', lines: [], notes: '' };
  if (DOCS[kind].party === 'customer') { doc.customerId = ''; doc.repId = ''; } else doc.supplierId = '';
  if (kind === 'quote') doc.validUntil = addDays(t, 30);
  if (kind === 'order') { doc.dueDate = addDays(t, 7); doc.source = 'internal'; doc.paymentMethod = 'bank'; }
  if (kind === 'po') doc.expectedDate = addDays(t, 5);
  Object.assign(doc, clone(preset));
  if (doc.customerId && !doc.repId) doc.repId = byId('customers', doc.customerId)?.repId || '';
  if (!doc.lines.length) doc.lines = [blankLine()];
  ED = { kind, doc, isNew: true, dirty: true };
  go(`edit/${kind}/${doc.id}`);
}
function edLocked() {
  const { kind, doc, isNew } = ED; if (isNew) return false;
  if (kind === 'quote') return !['draft', 'sent'].includes(doc.status);
  if (kind === 'order') return !['pending', 'new'].includes(doc.status);
  return doc.status !== 'draft';
}
function edPriceFor(p) {
  const { kind, doc } = ED;
  if (kind === 'po') { const sp = db.supplierPrices.find(x => x.supplierId === doc.supplierId && x.productId === p.id); return sp ? sp.price : p.cost; }
  return priceFor(byId('customers', doc.customerId), p);
}
function edSet(field, value, re) {
  const d = ED.doc; d[field] = value; ED.dirty = true;
  if (field === 'customerId') {
    const c = byId('customers', value); if (c?.repId) d.repId = c.repId;
    d.lines.forEach(l => { const p = byId('products', l.productId); if (p) l.price = edPriceFor(p); });
  }
  if (field === 'supplierId') d.lines.forEach(l => { const p = byId('products', l.productId); if (p) l.price = edPriceFor(p); });
  if (re) rerender();
}
function edLine(i, f, v) { ED.doc.lines[i][f] = f === 'desc' ? v : (v === '' ? 0 : +v); ED.dirty = true; edUpdateTotals(); }
function edProduct(i, pid) {
  const l = ED.doc.lines[i]; const p = byId('products', pid); l.productId = pid;
  if (p) { l.desc = p.name; l.unitCost = ED.kind === 'po' ? 0 : p.cost; l.price = edPriceFor(p); }
  ED.dirty = true; rerender();
}
function edAddLine() { ED.doc.lines.push(blankLine()); ED.dirty = true; rerender(); }
function edRemove(i) { ED.doc.lines.splice(i, 1); if (!ED.doc.lines.length) ED.doc.lines.push(blankLine()); ED.dirty = true; rerender(); }
function edMarkup() {
  const m = +document.getElementById('ed-markup').value || 0;
  ED.doc.lines.forEach(l => { if (+l.unitCost) l.price = round2(l.unitCost * (1 + m / 100)); });
  ED.dirty = true; rerender(); toast(`Applied ${m}% markup on cost`);
}
function edTotalsHTML() {
  const { kind, doc } = ED; const t = totals(doc.lines);
  return `<table class="totals">
    <tr><td>Net amount</td><td>${money(t.net)}</td></tr>
    <tr><td>VAT ${db.settings.vatRate}%</td><td>${money(t.vat)}</td></tr>
    <tr class="grand"><td>Total</td><td>${money(t.total)}</td></tr>
    ${kind !== 'po' ? `<tr class="muted"><td>Cost</td><td>${money(t.cost)}</td></tr>
    <tr class="${t.margin < 0 ? 'text-bad' : 'text-good'}"><td>Gross margin</td><td>${money(t.margin)} (${pct(t.marginPct)})</td></tr>` : ''}
  </table>`;
}
function edUpdateTotals() {
  ED.doc.lines.forEach((l, i) => { const el = document.getElementById('lt-' + i); if (el) el.textContent = money(lineNet(l)); });
  const t = document.getElementById('ed-totals'); if (t) t.innerHTML = edTotalsHTML();
}
function needSaved() { if (ED.dirty) { toast('Save your changes first', 'err'); return false; } return true; }
const edRec = () => byId(DOCS[ED.kind].col, ED.doc.id);

page('edit', {
  perm: kind => kind === 'po' ? 'purchasing' : kind === 'quote' ? 'quotes' : 'orders',
  nav: kind => DOCS[kind]?.list,
  title: (kind, id) => {
    const cfg = DOCS[kind]; if (!cfg) return 'Document';
    const rec = byId(cfg.col, id);
    return rec ? `${cfg.label} ${rec.number}` : `New ${cfg.label.toLowerCase()}`;
  },
  render(kind, id) {
    const cfg = DOCS[kind]; if (!cfg) return notFound();
    if (!(ED && ED.kind === kind && ED.doc.id === id)) {
      const ex = byId(cfg.col, id); if (!ex) return notFound();
      ED = { kind, doc: clone(ex), isNew: false, dirty: false };
    } else if (!ED.isNew && !ED.dirty) { const ex = byId(cfg.col, id); if (ex) ED.doc = clone(ex); }
    const d = ED.doc, L = edLocked(), dis = L ? 'disabled' : '';
    const isC = cfg.party === 'customer';
    const prods = db.products.filter(p => kind === 'po' ? p.kind !== 'service' : true);
    const cust = isC && byId('customers', d.customerId);

    const head = `<div class="form-grid cols-4">
      <div class="field">${isC
        ? `<label>Customer *</label><select ${dis} onchange="edSet('customerId',this.value,true)">${opt(db.customers, d.customerId, { empty: '— select customer —' })}</select>${cust ? `<small><a href="#/customer/${cust.id}">${esc(cust.city)} · ${esc(nameOf('priceLists', cust.priceListId, 'Standard prices'))}</a></small>` : ''}`
        : `<label>Supplier *</label><select ${dis} onchange="edSet('supplierId',this.value,true)">${opt(db.suppliers, d.supplierId, { empty: '— select supplier —' })}</select>`}</div>
      <div class="field"><label>Date</label><input type="date" ${dis} value="${d.date}" onchange="edSet('date',this.value)"></div>
      ${kind === 'quote' ? `<div class="field"><label>Valid until</label><input type="date" ${dis} value="${d.validUntil}" onchange="edSet('validUntil',this.value)"></div>` : ''}
      ${kind === 'order' ? `<div class="field"><label>Due / delivery date</label><input type="date" value="${d.dueDate}" onchange="edSet('dueDate',this.value)"></div>` : ''}
      ${kind === 'po' ? `<div class="field"><label>Expected delivery</label><input type="date" ${dis} value="${d.expectedDate}" onchange="edSet('expectedDate',this.value)"></div>` : ''}
      ${isC ? `<div class="field"><label>Sales rep</label><select ${dis} onchange="edSet('repId',this.value)">${opt(db.reps, d.repId, { empty: '— none —' })}</select></div>` : ''}
      ${kind === 'order' ? `<div class="field"><label>Payment method</label><select ${dis} onchange="edSet('paymentMethod',this.value)">${PAY_METHODS.map(([v, l]) => `<option value="${v}" ${d.paymentMethod === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>` : ''}
      <div class="field"><label>Status</label><div class="static">${ED.isNew ? badge('draft') + ' <small>not saved yet</small>' : badge(d.status)}${d.source === 'b2b' ? ' <span class="tag">B2B portal</span>' : ''}</div></div>
    </div>`;

    const lines = `<div class="table-wrap"><table class="tbl lines">
      <thead><tr><th style="width:24%">Product / item</th><th>Description</th><th class="num">Qty</th>${isC ? '<th class="num">Unit cost</th>' : ''}<th class="num">Unit price</th>${isC ? '<th class="num">Disc. %</th>' : ''}<th class="num">Line total</th><th></th></tr></thead>
      <tbody>${d.lines.map((l, i) => {
        const p = byId('products', l.productId);
        const stockHint = p && p.kind !== 'service' ? `<small class="${p.stock < (+l.qty || 0) ? 'text-bad' : 'muted'}">stock ${num(p.stock, 2)} ${esc(p.unit)}</small>` : '';
        return `<tr>
        <td><select ${dis} onchange="edProduct(${i},this.value)"><option value="">Custom item…</option>${opt(prods, l.productId, { label: x => `${x.sku} · ${x.name}` })}</select>${stockHint}</td>
        <td><input ${dis} value="${esc(l.desc)}" oninput="edLine(${i},'desc',this.value)" placeholder="Description"></td>
        <td><input ${dis} type="number" step="any" class="num w-sm" value="${l.qty}" oninput="edLine(${i},'qty',this.value)"></td>
        ${isC ? `<td><input ${dis} type="number" step="0.01" class="num w-sm" value="${l.unitCost}" oninput="edLine(${i},'unitCost',this.value)"></td>` : ''}
        <td><input ${dis} type="number" step="0.01" class="num w-sm" value="${l.price}" oninput="edLine(${i},'price',this.value)"></td>
        ${isC ? `<td><input ${dis} type="number" step="any" class="num w-xs" value="${l.discount}" oninput="edLine(${i},'discount',this.value)"></td>` : ''}
        <td class="num" id="lt-${i}">${money(lineNet(l))}</td>
        <td>${L ? '' : `<button class="icon-btn" title="Remove line" onclick="edRemove(${i})">&times;</button>`}</td></tr>`;
      }).join('')}</tbody></table></div>
      ${L ? '' : `<div class="line-tools"><button class="btn sm" onclick="edAddLine()">+ Add line</button>
        ${isC ? `<span class="spacer"></span><label class="inline">Costing: markup <input id="ed-markup" type="number" class="num w-xs" value="120"> % on cost <button class="btn sm" onclick="edMarkup()">Apply to all lines</button></label>` : ''}</div>`}`;

    return `
    <div class="page-actions"><a href="#/${cfg.list}" class="btn">← Back</a><span class="spacer"></span>${edActions()}</div>
    ${card(cfg.label + (d.number ? ' ' + d.number : ''), head)}
    ${card('Lines', lines)}
    <div class="grid-2">
      ${card('Notes', `<textarea ${kind === 'order' ? '' : dis} rows="4" oninput="edSet('notes',this.value)" placeholder="Notes printed on the document">${esc(d.notes)}</textarea>`)}
      ${card('Totals', `<div id="ed-totals">${edTotalsHTML()}</div>`)}
    </div>
    ${ED.isNew ? '' : edRelated()}`;
  },
});
function edActions() {
  const { kind, doc, isNew } = ED; const b = [];
  const B = (label, fn, cls = '') => `<button class="btn ${cls}" onclick="${fn}">${label}</button>`;
  const A = (label, href) => `<a class="btn" href="#/${href}">${label}</a>`;
  if (!(kind !== 'order' && edLocked())) b.push(B(isNew ? 'Create' : 'Save changes', 'edSave()', 'primary'));
  if (!isNew) {
    if (kind === 'quote') {
      if (['draft', 'sent'].includes(doc.status)) b.push(B('✉ Send to customer', 'quoteSend()'), B('✓ Accepted', "quoteStatus('accepted')"), B('✗ Rejected', "quoteStatus('rejected')"));
      if (['draft', 'sent', 'accepted'].includes(doc.status)) b.push(B('→ Convert to order', 'quoteConvert()', 'accent'));
      if (doc.orderId) b.push(A('Open order', `edit/order/${doc.orderId}`));
      b.push(B('Duplicate', 'edDuplicate()'));
    }
    if (kind === 'order') {
      if (doc.status === 'pending') b.push(B('✓ Confirm order', 'orderConfirm()', 'accent'));
      if (doc.status === 'new') b.push(B('⚙ Send to production', 'orderToProduction()', 'accent'));
      if (doc.workOrderId) b.push(B('Work order', `openWorkOrder('${doc.workOrderId}')`));
      if (['new', 'production', 'ready'].includes(doc.status) && !doc.deliveryId) b.push(B('🚚 Create delivery', `createDelivery('${doc.id}')`));
      if (doc.deliveryId) b.push(A('Delivery', 'deliveries'));
      if (!doc.invoiceId && !['pending', 'cancelled'].includes(doc.status) && can('invoices')) b.push(B('€ Issue invoice', `issueInvoice('${doc.id}')`));
      if (doc.invoiceId) b.push(A('Invoice', `invoice/${doc.invoiceId}`));
      if (['pending', 'new'].includes(doc.status)) b.push(B('Cancel order', 'orderCancel()', 'danger'));
      if (doc.quoteId) b.push(A('Quote', `edit/quote/${doc.quoteId}`));
      b.push(B('↻ Reorder', `reorder('${doc.id}')`));
    }
    if (kind === 'po') {
      if (doc.status === 'draft') b.push(B('✉ Send to supplier', 'poSend()', 'accent'));
      if (doc.status === 'sent') b.push(B('📦 Receive goods', 'poReceive()', 'accent'));
      if (['draft', 'sent'].includes(doc.status)) b.push(B('Cancel PO', 'poCancel()', 'danger'));
    }
    b.push(B('🖨 Print / PDF', 'edPrint()'));
  }
  return b.join('');
}
function edRelated() {
  const { kind, doc } = ED;
  const mails = db.emails.filter(e => e.ref === doc.number);
  if (!mails.length) return '';
  return card('Email log', table([
    { label: 'Date', render: e => fmtDateTime(e.date) }, { label: 'To', render: e => esc(e.to) },
    { label: 'Subject', render: e => esc(e.subject) + (e.auto ? ' <span class="tag">auto</span>' : '') },
  ], mails, { href: e => `outbox/${e.id}` }));
}
function edSave() {
  const { kind, doc } = ED; const cfg = DOCS[kind];
  const partyKey = cfg.party === 'customer' ? 'customerId' : 'supplierId';
  if (!doc[partyKey]) return toast(`Select a ${cfg.party} first`, 'err');
  const lines = doc.lines.filter(l => l.productId || l.desc);
  if (!lines.length) return toast('Add at least one line', 'err');
  doc.lines = lines.map(l => ({ ...l, qty: +l.qty || 0, price: +l.price || 0, unitCost: kind === 'po' ? 0 : +l.unitCost || 0, discount: +l.discount || 0 }));
  Object.assign(doc, totals(doc.lines));
  if (ED.isNew) {
    doc.number = nextNo(kind); doc.createdBy = me().id;
    if (kind === 'order') applyStock(doc.lines, -1, doc.number);
    db[cfg.col].push(clone(doc));
    if (kind === 'order' && doc.status === 'new') orderConfirmedEmail(doc);
    ED.isNew = false;
  } else {
    const i = db[cfg.col].findIndex(x => x.id === doc.id); const old = db[cfg.col][i];
    if (kind === 'order' && old.status !== 'cancelled') { applyStock(old.lines, +1, old.number + ' (edit)'); applyStock(doc.lines, -1, doc.number + ' (edit)'); }
    db[cfg.col][i] = clone(doc);
  }
  ED.dirty = false; saveDB(); toast(`${cfg.label} ${doc.number} saved`); rerender();
}
function edDuplicate() {
  const { kind, doc } = ED;
  const preset = { lines: clone(doc.lines), notes: doc.notes };
  if (DOCS[kind].party === 'customer') preset.customerId = doc.customerId; else preset.supplierId = doc.supplierId;
  createDraft(kind, preset);
}
function edPrint() {
  const { kind, doc } = ED;
  const party = kind === 'po' ? byId('suppliers', doc.supplierId) : byId('customers', doc.customerId);
  printHTML(docPrintHTML(DOCS[kind].label, doc, party, kind === 'quote' ? `Valid until ${fmtDate(doc.validUntil)}` : kind === 'po' ? `Requested delivery ${fmtDate(doc.expectedDate)}` : `Due ${fmtDate(doc.dueDate)}`));
}
function docPrintHTML(title, doc, party, extra = '', footer = '') {
  const c = db.settings.company;
  return `<div class="print-doc">
    <header><div><h1>${esc(c.name)}</h1><div>${esc(c.address)}<br>VAT ${esc(c.vat)} · Tax office ${esc(c.taxOffice || '')}<br>${esc(c.phone)} · ${esc(c.email)}</div></div>
    <div class="pd-title"><h2>${esc(title)}</h2><div>No. <b>${esc(doc.number)}</b><br>Date ${fmtDate(doc.date)}<br>${esc(extra)}</div></div></header>
    <section class="pd-party"><small>To</small><br><b>${esc(party?.name || '')}</b><br>${esc(party?.address || '')} ${esc(party?.city || '')}<br>${party?.vat ? 'VAT ' + esc(party.vat) : ''}</section>
    <table><thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Disc.</th><th class="num">Amount</th></tr></thead>
    <tbody>${doc.lines.map(l => `<tr><td>${esc(l.desc)}</td><td class="num">${num(l.qty, 2)}</td><td class="num">${money(l.price)}</td><td class="num">${l.discount ? l.discount + '%' : ''}</td><td class="num">${money(lineNet(l))}</td></tr>`).join('')}</tbody></table>
    <table class="pd-totals"><tr><td>Net</td><td>${money(doc.net)}</td></tr><tr><td>VAT ${db.settings.vatRate}%</td><td>${money(doc.vat)}</td></tr><tr class="grand"><td>Total</td><td>${money(doc.total)}</td></tr></table>
    ${doc.notes ? `<p class="pd-notes">${esc(doc.notes)}</p>` : ''}${footer}
    <p class="pd-foot">IBAN ${esc(c.iban || '')}</p></div>`;
}

/* ---------- quote actions ---------- */
function quoteSend() {
  if (!needSaved()) return;
  const q = edRec(); const c = byId('customers', q.customerId);
  q.status = 'sent'; q.sentAt = new Date().toISOString();
  sendTemplate('quoteSent', c.email, { customer: c.name, number: q.number, total: money(q.total), date: fmtDate(q.validUntil) }, q.number, c.id);
  saveDB(); toast(`Quote email queued to ${c.email}`); rerender();
}
function quoteStatus(s) { if (!needSaved()) return; edRec().status = s; saveDB(); rerender(); }
function quoteConvert() {
  if (!needSaved()) return;
  const q = edRec(); const t = today();
  const o = { id: uid(), number: nextNo('order'), customerId: q.customerId, repId: q.repId, quoteId: q.id, date: t, dueDate: addDays(t, 7), lines: clone(q.lines), notes: q.notes, source: 'internal', paymentMethod: 'bank', status: 'new', ...totals(q.lines), createdBy: me().id };
  applyStock(o.lines, -1, o.number); db.orders.push(o);
  q.status = 'converted'; q.orderId = o.id;
  orderConfirmedEmail(o); saveDB(); toast(`Order ${o.number} created from ${q.number}`); go(`edit/order/${o.id}`);
}

/* ---------- order actions ---------- */
function orderConfirmedEmail(o) {
  const c = byId('customers', o.customerId); if (!c) return;
  autoEmail('orderConfirmed', c.email, { customer: c.name, number: o.number, total: money(o.total), date: fmtDate(o.dueDate) }, o.number, c.id);
}
function orderConfirm() { if (!needSaved()) return; const o = edRec(); o.status = 'new'; orderConfirmedEmail(o); saveDB(); toast('Order confirmed'); rerender(); }
function orderCancel() {
  if (!needSaved()) return;
  confirmBox('Cancel this order? Reserved stock will be released.', () => {
    const o = edRec(); o.status = 'cancelled'; applyStock(o.lines, +1, o.number + ' cancelled'); saveDB(); rerender();
  }, 'Cancel order');
}
function orderToProduction() { if (!needSaved()) return; const w = createWorkOrder(edRec()); saveDB(); toast(`Work order ${w.number} created`); rerender(); }
function createWorkOrder(o) {
  const w = { id: uid(), number: nextNo('wo'), orderId: o.id, customerId: o.customerId, dueDate: o.dueDate, priority: 'normal', assigneeId: '', status: 'todo', attachments: [], notes: o.notes || '', steps: db.settings.productionSteps.map(n => ({ name: n, done: false })) };
  db.workOrders.push(w); o.workOrderId = w.id; o.status = 'production';
  return w;
}

/* ---------- quotes list ---------- */
page('quotes', {
  title: 'Quotes',
  render() {
    const f = UI.quoteStatus || '';
    const rows = db.quotes.filter(q => !f || q.status === f).sort((a, b) => b.date.localeCompare(a.date));
    const decided = db.quotes.filter(q => ['converted', 'accepted', 'rejected'].includes(q.status));
    const won = decided.filter(q => q.status !== 'rejected');
    const open = db.quotes.filter(q => ['draft', 'sent'].includes(q.status));
    return `<div class="kpis">
      ${kpi('Open quotes', open.length, money(sum(open, q => q.net)) + ' net')}
      ${kpi('Win rate', pct(decided.length ? won.length / decided.length * 100 : 0), `${won.length} of ${decided.length} decided`)}
      ${kpi('Avg. margin', pct(sum(db.quotes, q => q.margin) / (sum(db.quotes, q => q.net) || 1) * 100))}
      ${kpi('Expiring in 7 days', open.filter(q => q.validUntil <= addDays(today(), 7)).length)}
    </div>` +
      card('Quotes', table([
        { label: 'Quote', render: q => `<b>${esc(q.number)}</b>` },
        { label: 'Customer', render: q => esc(nameOf('customers', q.customerId)) },
        { label: 'Date', render: q => fmtDate(q.date) },
        { label: 'Valid until', render: q => `<span class="${['draft', 'sent'].includes(q.status) && q.validUntil < today() ? 'text-bad' : ''}">${fmtDate(q.validUntil)}</span>` },
        { label: 'Rep', render: q => esc(nameOf('reps', q.repId)) },
        { label: 'Net', cls: 'num', render: q => money(q.net) },
        { label: 'Margin', cls: 'num', render: q => pct(q.marginPct) },
        { label: 'Status', render: q => badge(q.status) },
      ], rows, { href: q => `edit/quote/${q.id}`, id: 'tbl-q' }),
        `<select onchange="UI.quoteStatus=this.value;rerender()"><option value="">All statuses</option>${['draft', 'sent', 'accepted', 'rejected', 'converted'].map(s => `<option value="${s}" ${f === s ? 'selected' : ''}>${STATUS[s]}</option>`).join('')}</select>
         ${searchBox('tbl-q')} <button class="btn primary" onclick="createDraft('quote')">+ New quote</button>`);
  },
});

/* ---------- orders ---------- */
const OPEN_ORDER = ['pending', 'new', 'production', 'ready'];
page('orders', {
  title: 'Orders',
  render(tab = '') {
    const head = tabs('orders', [['', 'All orders'], ['board', 'Daily board'], ['shortages', 'Shortages']], tab);
    if (tab === 'board') return head + ordersBoard();
    if (tab === 'shortages') return head + shortagesView();
    const f = UI.orderStatus ?? 'open', src = UI.orderSource || '';
    const rows = db.orders.filter(o => (f === 'open' ? OPEN_ORDER.includes(o.status) : !f || o.status === f) && (!src || o.source === src)).sort((a, b) => b.date.localeCompare(a.date));
    return head + card('Orders', table([
      { label: 'Order', render: o => `<b>${esc(o.number)}</b>` },
      { label: 'Customer', render: o => esc(nameOf('customers', o.customerId)) },
      { label: 'Date', render: o => fmtDate(o.date) },
      { label: 'Due', render: o => `<span class="${OPEN_ORDER.includes(o.status) && o.dueDate < today() ? 'text-bad' : ''}">${fmtDate(o.dueDate)}</span>` },
      { label: 'Source', render: o => o.source === 'b2b' ? '<span class="tag">B2B</span>' : 'Internal' },
      { label: 'Total', cls: 'num', render: o => money(o.total) },
      { label: 'Status', render: o => badge(o.status) },
      { label: 'Invoiced', render: o => o.invoiceId ? '✓' : '' },
    ], rows, { href: o => `edit/order/${o.id}`, id: 'tbl-o' }),
      `<select onchange="UI.orderStatus=this.value;rerender()"><option value="open" ${f === 'open' ? 'selected' : ''}>Open orders</option><option value="" ${f === '' ? 'selected' : ''}>All statuses</option>
        ${['pending', 'new', 'production', 'ready', 'shipped', 'delivered', 'cancelled'].map(s => `<option value="${s}" ${f === s ? 'selected' : ''}>${STATUS[s]}</option>`).join('')}</select>
       <select onchange="UI.orderSource=this.value;rerender()"><option value="">All sources</option><option value="internal" ${src === 'internal' ? 'selected' : ''}>Internal</option><option value="b2b" ${src === 'b2b' ? 'selected' : ''}>B2B portal</option></select>
       ${searchBox('tbl-o')} <button class="btn primary" onclick="createDraft('order')">+ New order</button>`);
  },
});
function ordersBoard() {
  const date = UI.boardDate || today(), scope = UI.boardScope || 'date', grp = UI.boardGroup || 'customer';
  const orders = db.orders.filter(o => o.status !== 'cancelled' && (scope === 'date' ? o.date === date : OPEN_ORDER.includes(o.status)));
  const rows = orders.flatMap(o => o.lines.map(l => ({ o, l, p: byId('products', l.productId), c: byId('customers', o.customerId) })));
  const keyOf = r => grp === 'customer' ? (r.c?.name || '—') : grp === 'category' ? (r.p?.category || 'Custom items') : (r.c?.region || '—');
  const groups = [...groupBy(rows, keyOf)].sort((a, b) => a[0].localeCompare(b[0]));
  const controls = `<div class="toolbar">
    <label class="inline">Show <select onchange="UI.boardScope=this.value;rerender()"><option value="date" ${scope === 'date' ? 'selected' : ''}>Orders placed on</option><option value="open" ${scope === 'open' ? 'selected' : ''}>All open orders</option></select></label>
    ${scope === 'date' ? `<input type="date" value="${date}" onchange="UI.boardDate=this.value;rerender()">` : ''}
    <label class="inline">Group by <select onchange="UI.boardGroup=this.value;rerender()">${[['customer', 'Customer'], ['category', 'Product type'], ['region', 'Delivery region']].map(([v, l]) => `<option value="${v}" ${grp === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <span class="muted">${orders.length} orders · ${rows.length} lines · ${money(sum(orders, o => o.net))} net</span></div>`;
  if (!groups.length) return controls + `<div class="empty">No orders for this selection.${scope === 'date' ? ' Try "All open orders".' : ''}</div>`;
  return controls + `<div class="grid-2">${groups.map(([k, rs]) => card(`${k} · ${money(sum(rs, r => lineNet(r.l)))}`, table([
    { label: 'Order', render: r => `<a href="#/edit/order/${r.o.id}">${esc(r.o.number)}</a>` },
    ...(grp !== 'customer' ? [{ label: 'Customer', render: r => esc(r.c?.name || '') }] : []),
    { label: 'Item', render: r => esc(r.l.desc) },
    { label: 'Qty', cls: 'num', render: r => `${num(r.l.qty, 2)} ${esc(r.p?.unit || '')}` },
    { label: 'Status', render: r => badge(r.o.status) },
  ], rs))).join('')}</div>`;
}
function shortageRows() {
  const open = db.orders.filter(o => OPEN_ORDER.includes(o.status));
  const committed = {}, onOrder = {};
  open.forEach(o => o.lines.forEach(l => { committed[l.productId] = (committed[l.productId] || 0) + (+l.qty || 0); }));
  db.purchaseOrders.filter(p => ['draft', 'sent'].includes(p.status)).forEach(p => p.lines.forEach(l => { onOrder[l.productId] = (onOrder[l.productId] || 0) + (+l.qty || 0); }));
  return db.products.filter(p => p.kind !== 'service').map(p => {
    const oo = onOrder[p.id] || 0;
    const need = Math.max(0, Math.ceil(p.minStock * 1.5 - p.stock - oo));
    return { p, committed: committed[p.id] || 0, onOrder: oo, need, short: p.stock < 0 || p.stock + oo < p.minStock };
  }).filter(r => r.short);
}
function shortagesView() {
  const rows = shortageRows();
  return `<div class="note">Stock is reserved when an order is created, so a negative stock means open orders need more than you have. Suggested quantity refills to 1.5× the minimum, minus what's already on order.</div>` +
    card('Shortages & reorder suggestions', table([
      { label: 'Product', render: r => `<b>${esc(r.p.name)}</b><br><small>${esc(r.p.sku)}</small>` },
      { label: 'In stock', cls: 'num', render: r => `<span class="${r.p.stock < 0 ? 'text-bad' : 'text-warn'}">${num(r.p.stock, 2)}</span>` },
      { label: 'In open orders', cls: 'num', render: r => num(r.committed, 2) },
      { label: 'On order (POs)', cls: 'num', render: r => num(r.onOrder, 2) },
      { label: 'Minimum', cls: 'num', render: r => num(r.p.minStock) },
      { label: 'Suggested', cls: 'num', render: r => `<b>${num(r.need)}</b> ${esc(r.p.unit)}` },
    ], rows, { empty: 'No shortages — stock covers all open orders.' }),
      rows.some(r => r.need > 0) && can('purchasing') ? `<button class="btn primary" onclick="autoPurchase(shortageRows().filter(r=>r.need>0).map(r=>({product:r.p, qty:r.need})))">Create purchase orders</button>` : '');
}

/* ---------- production ---------- */
page('production', {
  title: 'Production',
  render() {
    const t = today();
    const cols = [['todo', 'To do'], ['progress', 'In progress'], ['done', 'Done']];
    const list = s => db.workOrders.filter(w => w.status === s)
      .sort((a, b) => s === 'done' ? b.dueDate.localeCompare(a.dueDate) : (a.priority === 'high' ? -1 : 0) - (b.priority === 'high' ? -1 : 0) || a.dueDate.localeCompare(b.dueDate))
      .slice(0, s === 'done' ? 8 : 100);
    const woCard = w => {
      const o = byId('orders', w.orderId);
      return `<div class="wo-card ${w.priority === 'high' ? 'urgent' : ''}" onclick="openWorkOrder('${w.id}')">
        <div class="wo-top"><b>${esc(w.number)}</b>${w.priority === 'high' ? '<span class="tag bad">urgent</span>' : ''}<span class="spacer"></span><small>${esc(o?.number || '')}</small></div>
        <div>${esc(nameOf('customers', w.customerId))}</div>
        <small class="muted">${esc((o?.lines || []).map(l => `${l.qty}× ${l.desc}`).join(', '))}</small>
        <div class="wo-meta"><span class="${w.status !== 'done' && w.dueDate < t ? 'text-bad' : ''}">Due ${fmtDate(w.dueDate)}</span><span>${esc(nameOf('users', w.assigneeId, 'unassigned'))}</span></div>
        ${progress(w)}
        <div class="wo-move">${w.status !== 'todo' ? `<button class="btn xs" onclick="event.stopPropagation();woMove('${w.id}',-1)">‹</button>` : ''}${w.status !== 'done' ? `<button class="btn xs" onclick="event.stopPropagation();woMove('${w.id}',1)">›</button>` : ''}</div>
      </div>`;
    };
    return `<div class="note">Every order sent to production gets a digital work order with a routing sheet (steps), an assignee and attachments. Ticking the last step marks the order <b>Ready</b>.</div>
      <div class="kanban">${cols.map(([s, l]) => `<div class="kcol"><h3>${l} <span class="muted">${db.workOrders.filter(w => w.status === s).length}</span></h3>${list(s).map(woCard).join('') || '<div class="empty sm">Empty</div>'}</div>`).join('')}</div>`;
  },
});
function woSync(w) {
  const n = w.steps.filter(s => s.done).length;
  w.status = n === w.steps.length ? 'done' : n ? 'progress' : 'todo';
  const o = byId('orders', w.orderId);
  if (o) {
    if (w.status === 'done' && o.status === 'production') o.status = 'ready';
    if (w.status !== 'done' && o.status === 'ready') o.status = 'production';
  }
}
function woMove(id, dir) {
  const w = byId('workOrders', id);
  const order = ['todo', 'progress', 'done'];
  const target = order[Math.max(0, Math.min(2, order.indexOf(w.status) + dir))];
  if (target === 'done') w.steps.forEach(s => { s.done = true; });
  if (target === 'todo') w.steps.forEach(s => { s.done = false; });
  if (target === 'progress') { if (w.steps.every(s => s.done)) w.steps[w.steps.length - 1].done = false; if (!w.steps.some(s => s.done)) w.steps[0].done = true; }
  woSync(w); saveDB(); rerender();
}
function woStep(id, i, checked) {
  const w = byId('workOrders', id); w.steps[i].done = checked; w.steps[i].doneAt = checked ? new Date().toISOString() : null;
  woSync(w); saveDB();
  const el = document.getElementById('wo-status'); if (el) el.innerHTML = badge(w.status) + ' ' + progress(w);
}
async function woAttach(id, input) {
  const files = [...input.files];
  const max = SYNC.maxUpload || 25 * 1024 * 1024;
  if (files.some(f => f.size > max)) return toast(`Files must be ${Math.round(max / 1048576)} MB or smaller`, 'err');
  toast(`Uploading ${files.length} file(s)…`);
  for (const f of files) {
    try {
      const up = await uploadFile(f);
      byId('workOrders', id).attachments.push({ fileId: up.id, name: up.name, size: up.size, type: up.type, addedAt: new Date().toISOString(), by: me().id });
    } catch (e) { toast(`${f.name}: ${e.message}`, 'err'); }
  }
  saveDB(); openWorkOrder(id); toast('Upload finished');
}
function woRemoveAttachment(id, i) {
  const w = byId('workOrders', id); const a = w.attachments[i];
  confirmBox(`Delete ${a.name}?`, () => {
    if (a.fileId) api('/api/files/' + a.fileId, { method: 'DELETE' }).catch(e => toast(e.message, 'err'));
    w.attachments.splice(i, 1); saveDB(); openWorkOrder(id);
  }, 'Delete file');
}
const fileLink = a => a.fileId ? `<a href="/api/files/${esc(a.fileId)}" target="_blank" rel="noopener">📎 ${esc(a.name)}</a>` : `📎 ${esc(a.name)} <small class="muted">(name only)</small>`;
function openWorkOrder(id) {
  const w = byId('workOrders', id); if (!w) return;
  const o = byId('orders', w.orderId);
  const body = `
    <div class="wo-head"><div><b>${esc(nameOf('customers', w.customerId))}</b> · order <a href="#/edit/order/${o?.id}" onclick="closeModal()">${esc(o?.number || '')}</a></div><div id="wo-status">${badge(w.status)} ${progress(w)}</div></div>
    <h4>Items</h4><ul class="plain">${(o?.lines || []).map(l => `<li>${num(l.qty, 2)} × ${esc(l.desc)}</li>`).join('')}</ul>
    <h4>Routing sheet</h4>
    <ul class="steps">${w.steps.map((s, i) => `<li><label class="chk"><input type="checkbox" ${s.done ? 'checked' : ''} onchange="woStep('${id}',${i},this.checked)"> ${i + 1}. ${esc(s.name)}</label>${s.doneAt ? `<small class="muted">${fmtDateTime(s.doneAt)}</small>` : ''}</li>`).join('')}</ul>
    <div class="form-grid">
      ${fieldHTML({ name: 'assigneeId', label: 'Assigned to', type: 'select', options: pairs(db.users, x => x.name, '— unassigned —') }, w.assigneeId)}
      ${fieldHTML({ name: 'dueDate', label: 'Due date', type: 'date' }, w.dueDate)}
      ${fieldHTML({ name: 'priority', label: 'Priority', type: 'select', options: [['normal', 'Normal'], ['high', 'Urgent']] }, w.priority)}
      ${fieldHTML({ name: 'notes', label: 'Production notes', type: 'textarea', full: true }, w.notes)}
    </div>
    <h4>Attachments</h4>
    <ul class="plain">${w.attachments.map((a, i) => `<li>${fileLink(a)} <small class="muted">${num(a.size / 1024)} KB</small> <button class="icon-btn" title="Delete" onclick="woRemoveAttachment('${id}',${i})">&times;</button></li>`).join('') || '<li class="muted">No files</li>'}</ul>
    <input type="file" multiple onchange="woAttach('${id}',this)">
    <p class="muted sm">Artwork, proofs, photos — up to ${Math.round((SYNC.maxUpload || 26214400) / 1048576)} MB per file.</p>`;
  openModal(`Work order ${w.number}`, body, [
    { label: '🖨 Routing sheet', onClick: () => { printHTML(routingSheetHTML(w)); return false; } },
    { label: 'Close' },
    { label: 'Save', primary: true, onClick: () => { Object.assign(w, readForm([{ name: 'assigneeId' }, { name: 'dueDate' }, { name: 'priority' }, { name: 'notes' }])); saveDB(); toast('Work order saved'); } },
  ], { wide: true, onClose: () => rerender() });
}
function routingSheetHTML(w) {
  const o = byId('orders', w.orderId);
  return `<div class="print-doc"><header><div><h1>${esc(db.settings.company.name)}</h1></div><div class="pd-title"><h2>Work order / routing sheet</h2><div>No. <b>${esc(w.number)}</b><br>Order ${esc(o?.number || '')}<br>Due ${fmtDate(w.dueDate)}</div></div></header>
    <section class="pd-party"><b>${esc(nameOf('customers', w.customerId))}</b><br>Assigned to: ${esc(nameOf('users', w.assigneeId, '—'))} · Priority: ${w.priority === 'high' ? 'URGENT' : 'normal'}</section>
    <table><thead><tr><th>Item</th><th class="num">Qty</th></tr></thead><tbody>${(o?.lines || []).map(l => `<tr><td>${esc(l.desc)}</td><td class="num">${num(l.qty, 2)}</td></tr>`).join('')}</tbody></table>
    <table><thead><tr><th>#</th><th>Step</th><th>Done</th><th>Signature</th></tr></thead><tbody>${w.steps.map((s, i) => `<tr><td>${i + 1}</td><td>${esc(s.name)}</td><td>${s.done ? '✓' : '☐'}</td><td style="width:35%"></td></tr>`).join('')}</tbody></table>
    ${w.notes ? `<p class="pd-notes">${esc(w.notes)}</p>` : ''}</div>`;
}

/* ---------- deliveries ---------- */
const DLV_FLOW = ['pending', 'picked_up', 'in_transit', 'delivered'];
const DLV_NEXT_LABEL = { pending: 'Mark picked up', picked_up: 'Mark in transit', in_transit: 'Mark delivered' };
page('deliveries', {
  title: 'Deliveries',
  render() {
    const f = UI.dlvFilter ?? 'active';
    const rows = db.deliveries.filter(d => f === 'active' ? d.status !== 'delivered' : f === 'cod' ? d.cod && !d.codCollected : true).sort((a, b) => b.date.localeCompare(a.date));
    const codOpen = db.deliveries.filter(d => d.cod && !d.codCollected);
    const readyNoDlv = db.orders.filter(o => o.status === 'ready' && !o.deliveryId);
    return `<div class="kpis">
      ${kpi('Active shipments', db.deliveries.filter(d => d.status !== 'delivered').length)}
      ${kpi('COD to collect', money(sum(codOpen, d => d.codAmount)), `${codOpen.length} shipments`)}
      ${kpi('Ready, not shipped', readyNoDlv.length, 'orders waiting for a delivery')}
    </div>
    ${readyNoDlv.length ? card('Ready to ship', table([
      { label: 'Order', render: o => `<b>${esc(o.number)}</b>` }, { label: 'Customer', render: o => esc(nameOf('customers', o.customerId)) },
      { label: 'Due', render: o => fmtDate(o.dueDate) }, { label: 'Total', cls: 'num', render: o => money(o.total) },
      { label: '', render: o => `<button class="btn sm primary" onclick="createDelivery('${o.id}')">🚚 Create delivery</button>` },
    ], readyNoDlv)) : ''}
    ${card('Shipments', table([
      { label: 'No.', render: d => `<b>${esc(d.number)}</b><br><small>${fmtDate(d.date)}</small>` },
      { label: 'Order / customer', render: d => `<a href="#/edit/order/${d.orderId}">${esc(byId('orders', d.orderId)?.number || '')}</a><br><small>${esc(nameOf('customers', d.customerId))}</small>` },
      { label: 'Courier', render: d => `${esc(d.courier)}${d.courierMode === 'simulated' ? ' <span class="tag">sim</span>' : ''}<br><small class="mono">${esc(d.tracking || '—')}</small>${d.courierError && !d.booked ? `<br><small class="text-bad">${esc(d.courierError)}</small>` : ''}${d.courierStatus ? `<br><small class="text-warn">${esc(d.courierStatus)}</small>` : ''}` },
      { label: 'Status', render: d => d.booked === false ? '<span class="badge b-pending">Not booked</span>' : badge(d.status) },
      { label: 'COD', cls: 'num', render: d => d.cod ? `${money(d.codAmount)}<br><label class="chk sm"><input type="checkbox" ${d.codCollected ? 'checked' : ''} onchange="deliveryCod('${d.id}',this.checked)"> collected</label>` : '—' },
      { label: '', render: d => d.booked === false
        ? `<button class="btn sm primary" onclick="deliveryBook('${d.id}')">Book with courier</button>`
        : `${d.courierMode === 'live' ? `<button class="btn sm" onclick="deliveryRefresh('${d.id}')">↻ Tracking</button>` : DLV_NEXT_LABEL[d.status] ? `<button class="btn sm" onclick="deliveryAdvance('${d.id}')">${DLV_NEXT_LABEL[d.status]}</button>` : ''}
           ${d.labelAvailable ? `<button class="btn sm" onclick="deliveryLabel('${d.id}')">🏷 Label</button>` : ''} <button class="btn sm" onclick="trackDelivery('${d.id}')">History</button>` },
    ], rows, { id: 'tbl-dlv', empty: 'No shipments in this view.' }),
      `<select onchange="UI.dlvFilter=this.value;rerender()"><option value="active" ${f === 'active' ? 'selected' : ''}>Active</option><option value="cod" ${f === 'cod' ? 'selected' : ''}>COD not collected</option><option value="all" ${f === 'all' ? 'selected' : ''}>All</option></select> ${searchBox('tbl-dlv')}
       <button class="btn" onclick="closeDayACS()" title="ACS only registers vouchers after the daily pickup list is issued">ACS: issue pickup list</button>`)}`;
  },
});
function createDelivery(orderId) {
  const o = byId('orders', orderId); const c = byId('customers', o.customerId);
  openForm({
    title: `Delivery for ${o.number}`,
    fields: [
      { name: 'courier', label: 'Courier', type: 'select', options: db.settings.couriers.map(x => [x, x]) },
      { name: 'weight', label: 'Weight (kg)', type: 'number' },
      { name: 'address', label: 'Delivery address', full: true, required: true },
      { name: 'postalCode', label: 'Postal code', required: true },
      { name: 'phone', label: 'Recipient phone', required: true },
      { name: 'lockerId', label: 'BOX NOW locker ID', help: 'Only for BOX NOW — the locker the customer chose' },
      { name: 'compartmentSize', label: 'BOX NOW compartment', type: 'select', options: [['1', 'Small'], ['2', 'Medium'], ['3', 'Large']] },
      { name: 'cod', label: 'Cash on delivery', type: 'checkbox', hint: 'Collect payment on delivery' },
      { name: 'codAmount', label: 'COD amount (€)', type: 'number' },
      { name: 'notes', label: 'Notes for courier', type: 'textarea', full: true },
    ],
    values: { courier: db.settings.couriers[0], weight: 2, address: `${c.address}, ${c.city}`, postalCode: c.postalCode || '', phone: c.phone, compartmentSize: '2', cod: o.paymentMethod === 'cod', codAmount: o.paymentMethod === 'cod' ? o.total : 0 },
    saveLabel: 'Create & book courier',
    onSave: d => {
      const dl = { id: uid(), number: nextNo('delivery'), orderId, customerId: o.customerId, date: today(), ...d, codAmount: d.cod ? d.codAmount : 0, tracking: '', booked: false, status: 'pending', codCollected: false, history: [{ status: 'pending', at: new Date().toISOString() }] };
      db.deliveries.push(dl); o.deliveryId = dl.id; saveDB();
      deliveryBook(dl.id);
    },
  });
}
const courierMode = courier => (SYNC.integrations.couriers || {})[courier === 'ACS' || courier === 'BOX NOW' ? courier : 'other'] || 'simulate';
/** Book a saved delivery with the courier (server-side call). */
async function deliveryBook(id, manualTracking) {
  const d = byId('deliveries', id);
  const other = d.courier !== 'ACS' && d.courier !== 'BOX NOW';
  if (other && courierMode(d.courier) === 'manual' && !manualTracking) {
    return openForm({
      title: `${d.courier} tracking number`, saveLabel: 'Save tracking number',
      fields: [{ name: 'tracking', label: `Book the shipment in the ${d.courier} system and enter its tracking number`, required: true, full: true }],
      onSave: v => { deliveryBook(id, v.tracking); },
    });
  }
  if (!(await syncNow())) return toast('Could not save the delivery — try again', 'err');
  try {
    const r = await api('/api/courier/book', { method: 'POST', body: { deliveryId: id, tracking: manualTracking } });
    applyServerRecord('deliveries', id, r.delivery, r.version);
    toast(`${d.courier}${r.delivery.courierMode === 'simulated' ? ' (simulation)' : ''} booked — tracking ${r.delivery.tracking}`);
  } catch (e) {
    if (e.data?.delivery) applyServerRecord('deliveries', id, e.data.delivery, e.data.version);
    toast('Courier booking failed: ' + e.message, 'err');
  }
  rerender();
}
function deliveryLabel(id) { window.open('/api/courier/label/' + encodeURIComponent(id), '_blank', 'noopener'); }
async function deliveryRefresh(id) {
  try {
    const r = await api('/api/courier/track', { method: 'POST', body: { deliveryId: id } });
    applyServerRecord('deliveries', id, r.delivery, r.version);
    await pollChanges(); // order status / shipped email changed on the server too
    toast('Tracking updated'); rerender();
  } catch (e) { toast(e.message, 'err'); }
}
async function closeDayACS() {
  try { const r = await api('/api/courier/close-day', { method: 'POST', body: { courier: 'ACS' } }); toast(`ACS pickup list ${r.pickupList}${r.simulated ? ' (simulation)' : ''} issued`); }
  catch (e) { toast(e.message, 'err'); }
}
function deliveryAdvance(id) {
  const d = byId('deliveries', id); const next = DLV_FLOW[DLV_FLOW.indexOf(d.status) + 1]; if (!next) return;
  d.status = next; (d.history = d.history || []).push({ status: next, at: new Date().toISOString() });
  const o = byId('orders', d.orderId); const c = byId('customers', d.customerId);
  if (next === 'picked_up' && o) { o.status = 'shipped'; autoEmail('orderShipped', c.email, { customer: c.name, number: o.number, courier: d.courier, tracking: d.tracking }, o.number, c.id); }
  if (next === 'delivered' && o) o.status = 'delivered';
  saveDB(); rerender();
}
function deliveryCod(id, v) {
  const d = byId('deliveries', id); d.codCollected = v;
  const o = byId('orders', d.orderId); const inv = o && byId('invoices', o.invoiceId);
  if (v && inv && balanceOf(inv) > 0) { inv.payments.push({ id: uid(), date: today(), amount: Math.min(d.codAmount, balanceOf(inv)), method: 'cash (COD via ' + d.courier + ')' }); toast(`Payment recorded on ${inv.number}`); }
  saveDB(); rerender();
}
function trackDelivery(id) {
  const d = byId('deliveries', id);
  const hist = d.history?.length ? d.history : [{ status: d.status, at: d.date + 'T09:00:00' }];
  openModal(`Tracking ${d.tracking}`, `<dl class="dl"><dt>Courier</dt><dd>${esc(d.courier)}</dd><dt>Address</dt><dd>${esc(d.address)}</dd><dt>Weight</dt><dd>${num(d.weight, 1)} kg</dd>${d.cod ? `<dt>COD</dt><dd>${money(d.codAmount)} ${d.codCollected ? '(collected)' : ''}</dd>` : ''}</dl>
    <ol class="timeline">${DLV_FLOW.map(s => { const h = hist.find(x => x.status === s); return `<li class="${h ? 'done' : ''}"><b>${STATUS[s]}</b> <small>${h ? fmtDateTime(h.at) : ''}</small></li>`; }).join('')}</ol>
    ${d.events?.length ? `<h4>Courier events</h4><ul class="plain">${d.events.map(e => `<li><small class="muted">${esc(e.at || '')}</small> ${esc(e.text)}</li>`).join('')}</ul>` : ''}
    <p class="muted sm">Connection: ${esc({ live: 'live courier API', manual: 'tracking number entered by hand', simulated: 'simulation — not a real shipment' }[d.courierMode] || 'not booked yet')}.</p>`);
}

/* ---------- invoices ---------- */
function issueInvoice(orderId) {
  if (ED && ED.kind === 'order' && ED.doc.id === orderId && !needSaved()) return;
  const o = byId('orders', orderId); const c = byId('customers', o.customerId);
  const inv = makeInvoice(o); db.invoices.push(inv); o.invoiceId = inv.id;
  const dl = byId('deliveries', o.deliveryId);
  if (dl?.codCollected) inv.payments.push({ id: uid(), date: today(), amount: Math.min(dl.codAmount, inv.total), method: 'cash (COD)' });
  autoEmail('invoiceIssued', c.email, { customer: c.name, number: inv.number, total: money(inv.total), date: fmtDate(inv.dueDate) }, inv.number, c.id);
  saveDB(); toast(`Invoice ${inv.number} issued`); go(`invoice/${inv.id}`);
}
page('invoices', {
  title: 'Invoices',
  render() {
    const f = UI.invFilter || '';
    const rows = db.invoices.filter(i => !f || (f === 'mydata' ? i.mydata?.status !== 'transmitted' && !i.cancelled : f === 'open' ? ['unpaid', 'partial', 'overdue'].includes(invStatus(i)) : invStatus(i) === f)).sort((a, b) => b.date.localeCompare(a.date));
    const pendingMd = db.invoices.filter(i => i.mydata?.status !== 'transmitted' && !i.cancelled);
    const openInv = db.invoices.filter(i => !i.cancelled && balanceOf(i) > 0);
    const uninvoiced = db.orders.filter(o => ['shipped', 'delivered', 'ready'].includes(o.status) && !o.invoiceId);
    return `<div class="kpis">
      ${kpi('Receivables', money(sum(openInv, balanceOf)), `${openInv.length} open invoices`)}
      ${kpi('Overdue', money(sum(db.invoices.filter(i => invStatus(i) === 'overdue'), balanceOf)), `${db.invoices.filter(i => invStatus(i) === 'overdue').length} invoices`)}
      ${kpi('Not sent to myDATA', pendingMd.length, 'AADE e-invoicing')}
      ${kpi('Orders to invoice', uninvoiced.length, money(sum(uninvoiced, o => o.total)))}
    </div>
    ${uninvoiced.length ? card('Ready to invoice', table([
      { label: 'Order', render: o => `<b>${esc(o.number)}</b>` }, { label: 'Customer', render: o => esc(nameOf('customers', o.customerId)) },
      { label: 'Status', render: o => badge(o.status) }, { label: 'Total', cls: 'num', render: o => money(o.total) },
      { label: '', render: o => `<button class="btn sm primary" onclick="issueInvoice('${o.id}')">€ Issue invoice</button>` },
    ], uninvoiced)) : ''}
    ${card('Invoices', table([
      { label: 'Invoice', render: i => `<b>${esc(i.number)}</b><br><small>${esc(INV_TYPES[i.type] || i.type)}</small>` },
      { label: 'Customer', render: i => esc(nameOf('customers', i.customerId)) },
      { label: 'Date', render: i => fmtDate(i.date) },
      { label: 'Due', render: i => fmtDate(i.dueDate) },
      { label: 'Total', cls: 'num', render: i => money(i.total) },
      { label: 'Balance', cls: 'num', render: i => money(balanceOf(i)) },
      { label: 'Status', render: i => badge(invStatus(i)) },
      { label: 'myDATA', render: i => i.mydata?.status === 'transmitted' ? '<span class="badge b-transmitted">MARK ✓</span>' : i.cancelled ? '' : '<span class="badge b-pending">Pending</span>' },
    ], rows, { href: i => `invoice/${i.id}`, id: 'tbl-inv' }),
      `<select onchange="UI.invFilter=this.value;rerender()">${[['', 'All'], ['open', 'Open (unpaid)'], ['overdue', 'Overdue'], ['paid', 'Paid'], ['mydata', 'Not sent to myDATA'], ['cancelled', 'Cancelled']].map(([v, l]) => `<option value="${v}" ${f === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
       ${searchBox('tbl-inv')} ${pendingMd.length ? `<button class="btn" onclick="mydataBatch()">Send ${pendingMd.length} to myDATA</button>` : ''}`)}`;
  },
});
page('invoice', {
  nav: 'invoices', perm: () => 'invoices', title: id => 'Invoice ' + (byId('invoices', id)?.number || ''),
  render(id) {
    const i = byId('invoices', id); if (!i) return notFound();
    const c = byId('customers', i.customerId); const st = invStatus(i); const md = i.mydata || {};
    const tx = md.status === 'transmitted';
    return `<div class="page-actions"><a class="btn" href="#/invoices">← Invoices</a><span class="spacer"></span>
      ${!tx && !i.cancelled ? `<button class="btn accent" onclick="mydataSend('${id}')">Send to myDATA</button>` : ''}
      ${balanceOf(i) > 0 && !i.cancelled ? `<button class="btn primary" onclick="recordPayment('${id}')">€ Record payment</button><button class="btn" onclick="paymentReminder('${id}')">✉ Payment reminder</button>` : ''}
      ${balanceOf(i) >= 0 && !i.cancelled && !isCredit(i) ? `<button class="btn" onclick="issueCreditNote('${id}')">↩ Credit note</button>` : ''}
      <button class="btn" onclick="invoiceEmail('${id}')">✉ Email ${isCredit(i) ? 'credit note' : 'invoice'}</button>
      <button class="btn" onclick="printInvoice('${id}')">🖨 Print / PDF</button>
      ${!tx && !i.cancelled ? `<button class="btn danger" onclick="cancelInvoice('${id}')">Cancel</button>` : ''}
    </div>
    ${!tx && !i.cancelled ? mandateWarning(i) : ''}
    <div class="kpis">${kpi('Total', money(i.total))}${isCredit(i) ? kpi('Credits invoice', `<a href="#/invoice/${i.creditOf}">${esc(byId('invoices', i.creditOf)?.number || '')}</a>`) : `${kpi('Paid', money(paidOf(i)))}${creditsOf(i).length ? kpi('Credited', money(creditedOf(i))) : ''}${kpi('Balance', money(balanceOf(i)))}`}${kpi('Status', badge(st))}</div>
    <div class="grid-2">
      ${card(isCredit(i) ? 'Credit note' : 'Invoice', `<dl class="dl"><dt>Type</dt><dd>${esc(INV_TYPES[i.type] || i.type)}</dd><dt>Customer</dt><dd><a href="#/customer/${c?.id}">${esc(c?.name)}</a> · VAT ${esc(c?.vat || '—')}</dd>
        <dt>Date</dt><dd>${fmtDate(i.date)}</dd>${isCredit(i) ? `<dt>Reason</dt><dd>${esc(i.reason || '—')}</dd>` : `<dt>Due</dt><dd>${fmtDate(i.dueDate)}</dd>`}<dt>Order</dt><dd><a href="#/edit/order/${i.orderId}">${esc(byId('orders', i.orderId)?.number || '')}</a></dd>
        <dt>Sales rep</dt><dd>${esc(nameOf('reps', i.repId))}</dd>
        ${creditsOf(i).length ? `<dt>Credit notes</dt><dd>${creditsOf(i).map(cn => `<a href="#/invoice/${cn.id}">${esc(cn.number)}</a> (${money(cn.total)})`).join(', ')}</dd>` : ''}</dl>`)}
      ${card('myDATA (AADE)', tx ? `<dl class="dl"><dt>Status</dt><dd>${badge('transmitted')}${md.env === 'simulated' ? ' <span class="tag">simulation</span>' : md.env === 'test' ? ' <span class="tag">test environment</span>' : ''}</dd><dt>MARK</dt><dd class="mono">${esc(md.mark)}</dd><dt>UID</dt><dd class="mono sm">${esc(md.uid)}</dd><dt>Sent</dt><dd>${fmtDateTime(md.transmittedAt)}</dd>
        ${md.qrUrl ? `<dt>Verify</dt><dd><a href="${esc(md.qrUrl)}" target="_blank" rel="noopener">Open on AADE ↗</a></dd>` : ''}</dl>`
        : `<p>${i.cancelled ? 'Invoice cancelled.' : 'Not sent yet. myDATA checks the document and returns a MARK (its unique registration number).'}</p>${md.error ? `<p class="text-bad">Last attempt: ${esc(md.error)}</p>` : ''}
        <p class="muted sm">Connection: <b>${esc(MYDATA_MODE[SYNC.integrations.mydata] || 'Simulation')}</b>${me().role === 'admin' ? ' · change it in <a href="#/settings/integrations">Settings → Integrations</a>' : ''}.</p>`)}
    </div>
    ${card('Lines', table([
      { label: 'Description', render: l => esc(l.desc) }, { label: 'Qty', cls: 'num', render: l => num(l.qty, 2) },
      { label: 'Unit price', cls: 'num', render: l => money(l.price) }, { label: 'Disc.', cls: 'num', render: l => l.discount ? l.discount + '%' : '' },
      { label: 'Amount', cls: 'num', render: l => money(lineNet(l)) },
    ], i.lines, { foot: `<tfoot><tr><td colspan="4">Net</td><td class="num">${money(i.net)}</td></tr><tr><td colspan="4">VAT ${db.settings.vatRate}%</td><td class="num">${money(i.vat)}</td></tr><tr class="grand"><td colspan="4">Total</td><td class="num">${money(i.total)}</td></tr></tfoot>` }))}
    ${card('Payments', table([
      { label: 'Date', render: p => fmtDate(p.date) }, { label: 'Method', render: p => esc(p.method) }, { label: 'Amount', cls: 'num', render: p => money(p.amount) },
    ], i.payments, { empty: 'No payments recorded.' }))}`;
  },
});
const MYDATA_MODE = { simulate: 'Simulation (nothing is sent to AADE)', test: 'AADE test environment', production: 'AADE production' };
/** The B2B e-invoicing mandate applies to B2B documents in production. */
const mandateWarning = inv => SYNC.integrations.mydata === 'production' && inv.type !== '11.1'
  ? `<div class="note warn"><b>Check before sending:</b> under the Greek B2B e-invoicing mandate (all businesses from 1 Oct 2026), B2B invoices and credit notes must be issued through a licensed e-invoicing provider or AADE's timologio app. Sending them only over the myDATA ERP channel may not be compliant — confirm with your accountant.</div>` : '';
async function mydataSend(id, silent) {
  if (!(await syncNow())) { if (!silent) toast('Could not save changes — try again', 'err'); return false; }
  try {
    const r = await api('/api/mydata/send', { method: 'POST', body: { invoiceId: id } });
    applyServerRecord('invoices', id, r.invoice, r.version);
    const md = r.invoice.mydata || {};
    if (!silent) {
      if (md.status === 'transmitted') toast(`Registered in myDATA${md.env === 'simulated' ? ' (simulation)' : ''} — MARK ${md.mark}`);
      else toast('myDATA rejected: ' + (md.error || 'unknown error'), 'err');
      rerender();
    }
    return md.status === 'transmitted';
  } catch (e) { if (!silent) toast(e.message, 'err'); return false; }
}
async function mydataBatch() {
  const list = db.invoices.filter(i => i.mydata?.status !== 'transmitted' && !i.cancelled)
    .sort((a, b) => (isCredit(a) - isCredit(b)) || a.number.localeCompare(b.number)); // originals before their credit notes
  toast(`Sending ${list.length} document(s) to myDATA…`);
  let ok = 0;
  for (const i of list) if (await mydataSend(i.id, true)) ok++;
  toast(`${ok} registered in myDATA${list.length - ok ? `, ${list.length - ok} rejected (open the invoice to see why)` : ''}`, list.length - ok ? 'warn' : 'ok');
  rerender();
}

/* ---------- credit notes (myDATA 5.1) ---------- */
function creditableLines(inv) {
  const credited = {};
  creditsOf(inv).forEach(c => c.lines.forEach((l, i) => { const k = l.srcLine ?? i; credited[k] = (credited[k] || 0) + (+l.qty || 0); }));
  return inv.lines.map((l, i) => ({ l, i, left: round2((+l.qty || 0) - (credited[i] || 0)) }));
}
function issueCreditNote(id) {
  const inv = byId('invoices', id);
  const rows = creditableLines(inv).filter(r => r.left > 0);
  if (!rows.length) return toast('This invoice has already been fully credited', 'warn');
  openModal(`Credit note for ${inv.number}`, `
    <p class="muted">Choose what to credit. The credit note reduces the invoice balance and the revenue in reports.</p>
    <div class="table-wrap"><table class="tbl"><thead><tr><th>Item</th><th class="num">Invoiced</th><th class="num">Can credit</th><th class="num">Credit qty</th></tr></thead><tbody>
    ${rows.map(r => `<tr><td>${esc(r.l.desc)}</td><td class="num">${num(r.l.qty, 2)}</td><td class="num">${num(r.left, 2)}</td><td><input type="number" class="num w-sm cn-qty" data-i="${r.i}" min="0" max="${r.left}" step="any" value="${r.left}"></td></tr>`).join('')}
    </tbody></table></div>
    <div class="form-grid">
      ${fieldHTML({ name: 'cn_reason', label: 'Reason', full: true, list: ['Returned goods', 'Pricing error', 'Discount after sale', 'Damaged goods', 'Order cancelled'] }, 'Returned goods')}
      ${fieldHTML({ name: 'cn_stock', label: 'Stock', type: 'checkbox', hint: 'Return the credited products to stock' }, true)}
    </div>`, [
    { label: 'Cancel' },
    {
      label: 'Issue credit note', primary: true, onClick: () => {
        const lines = [...document.querySelectorAll('.cn-qty')].map(el => {
          const src = inv.lines[+el.dataset.i]; const max = rows.find(r => r.i === +el.dataset.i).left;
          const q = Math.min(max, Math.max(0, +el.value || 0));
          return q > 0 ? { ...clone(src), qty: q, srcLine: +el.dataset.i } : null;
        }).filter(Boolean);
        if (!lines.length) return toast('Enter at least one quantity to credit', 'err');
        const reason = document.getElementById('f_cn_reason').value.trim();
        const t = today();
        const cn = { id: uid(), number: nextNo('invoice'), type: '5.1', creditOf: inv.id, orderId: inv.orderId, customerId: inv.customerId, repId: inv.repId, date: t, dueDate: t,
          paymentMethod: inv.paymentMethod || 'bank', lines, ...totals(lines), payments: [], mydata: { status: 'pending' }, reason, notes: `Credit for invoice ${inv.number}${reason ? ' — ' + reason : ''}` };
        db.invoices.push(cn);
        if (document.getElementById('f_cn_stock').checked) applyStock(lines, +1, `${cn.number} credit note`);
        const c = byId('customers', inv.customerId);
        if (c) autoEmail('creditNote', c.email, { customer: c.name, number: cn.number, total: money(cn.total), date: inv.number }, cn.number, c.id);
        saveDB();
        syncNow().then(() => { toast(`Credit note ${byId('invoices', cn.id)?.number || ''} issued`); go(`invoice/${cn.id}`); });
      },
    }], { wide: true });
}
function recordPayment(id) {
  const inv = byId('invoices', id);
  openForm({
    title: `Payment for ${inv.number}`,
    fields: [
      { name: 'amount', label: 'Amount (€)', type: 'number', required: true },
      { name: 'date', label: 'Date', type: 'date', required: true },
      { name: 'method', label: 'Method', type: 'select', options: [['bank transfer', 'Bank transfer'], ['card', 'Card'], ['cash', 'Cash'], ['cheque', 'Cheque']] },
    ],
    values: { amount: balanceOf(inv), date: today() },
    onSave: d => { if (!(d.amount > 0)) return toast('Amount must be positive', 'err'); inv.payments.push({ id: uid(), ...d }); saveDB(); toast('Payment recorded'); rerender(); },
  });
}
function cnPrintNote(inv) {
  return isCredit(inv) ? `<p class="pd-notes">Credit note for invoice ${esc(byId('invoices', inv.creditOf)?.number || '')}${byId('invoices', inv.creditOf)?.mydata?.mark ? ` (MARK ${esc(byId('invoices', inv.creditOf).mydata.mark)})` : ''}</p>` : '';
}
function paymentReminder(id) {
  const inv = byId('invoices', id); const c = byId('customers', inv.customerId);
  sendTemplate('paymentReminder', c.email, { customer: c.name, number: inv.number, total: money(balanceOf(inv)), date: fmtDate(inv.dueDate) }, inv.number, c.id);
  saveDB(); toast('Reminder email queued'); rerender();
}
function invoiceEmail(id) {
  const inv = byId('invoices', id); const c = byId('customers', inv.customerId);
  if (isCredit(inv)) sendTemplate('creditNote', c.email, { customer: c.name, number: inv.number, total: money(inv.total), date: byId('invoices', inv.creditOf)?.number || '' }, inv.number, c.id);
  else sendTemplate('invoiceIssued', c.email, { customer: c.name, number: inv.number, total: money(inv.total), date: fmtDate(inv.dueDate) }, inv.number, c.id);
  saveDB(); toast(`Email queued to ${c.email}`);
}
function printInvoice(id) {
  const inv = byId('invoices', id); const md = inv.mydata || {};
  printHTML(docPrintHTML(INV_TYPES[inv.type] || 'Invoice', inv, byId('customers', inv.customerId), isCredit(inv) ? '' : `Due ${fmtDate(inv.dueDate)}`,
    cnPrintNote(inv) + (md.mark ? `<div class="pd-mydata">myDATA MARK: <b>${esc(md.mark)}</b><br>UID: ${esc(md.uid)}${md.env === 'simulated' ? '<br>(simulation — not registered with AADE)' : ''}</div>` : '')));
}
function cancelInvoice(id) {
  confirmBox('Cancel this invoice? (Invoices already sent to myDATA need a credit note instead.)', () => {
    const inv = byId('invoices', id); inv.cancelled = true;
    const o = byId('orders', inv.orderId); if (o && o.invoiceId === id) o.invoiceId = null;
    saveDB(); rerender();
  }, 'Cancel invoice');
}
