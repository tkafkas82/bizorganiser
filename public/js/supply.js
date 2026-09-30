'use strict';
/* =========================================================================
   Supply: products & stock, suppliers, purchasing (POs, price comparison,
   supplier quote requests, supplier bills)
   ========================================================================= */

const KINDS = [['product', 'Product'], ['material', 'Raw material'], ['service', 'Service']];
const catColor = cat => { let h = 0; for (const ch of String(cat)) h = (h * 31 + ch.charCodeAt(0)) % 360; return `hsl(${h} 55% 45%)`; };
const productThumb = (p, cls = '') => p.image
  ? `<img class="thumb ${cls}" src="${esc(p.image)}" alt="">`
  : `<span class="thumb ph ${cls}" style="background:${catColor(p.category)}">${esc(p.name.replace(/[^A-Za-z]/g, '').slice(0, 2).toUpperCase())}</span>`;

/* ---------- products ---------- */
page('products', {
  title: 'Products & stock',
  render() {
    const f = UI.prodKind || '', cat = UI.prodCat || '';
    const cats = [...new Set(db.products.map(p => p.category))].sort();
    const rows = db.products.filter(p => (!f || p.kind === f) && (!cat || p.category === cat));
    const stocked = db.products.filter(p => p.kind !== 'service');
    return `<div class="kpis">
      ${kpi('Items', db.products.length, `${cats.length} categories`)}
      ${kpi('Stock value (cost)', money(sum(stocked, p => Math.max(0, p.stock) * p.cost)))}
      ${kpi('At / below minimum', stocked.filter(p => p.stock <= p.minStock).length, '', '#/orders/shortages')}
    </div>` + card('Catalogue', table([
      { label: '', render: p => productThumb(p) },
      { label: 'SKU', render: p => `<span class="mono">${esc(p.sku)}</span>` },
      { label: 'Name', render: p => `<b>${esc(p.name)}</b><br><small>${esc(p.category)} · ${esc(KINDS.find(k => k[0] === p.kind)?.[1])}${p.b2b ? ' · <span class="tag">B2B</span>' : ''}</small>` },
      { label: 'Unit', render: p => esc(p.unit) },
      { label: 'Cost', cls: 'num', render: p => money(p.cost) },
      { label: 'Price', cls: 'num', render: p => money(p.price) },
      { label: 'Margin', cls: 'num', render: p => pct(p.price ? (p.price - p.cost) / p.price * 100 : 0) },
      { label: 'Stock', cls: 'num', render: p => p.kind === 'service' ? '—' : `<span class="${p.stock < 0 ? 'text-bad' : p.stock <= p.minStock ? 'text-warn' : ''}">${num(p.stock, 2)}</span><br><small class="muted">min ${num(p.minStock)}</small>` },
      { label: 'Supplier', render: p => esc(nameOf('suppliers', p.supplierId, '')) },
      { label: '', render: p => `<button class="btn xs" onclick="editProduct('${p.id}')">Edit</button>${p.kind !== 'service' ? ` <button class="btn xs" onclick="adjustStock('${p.id}')">Stock</button>` : ''}` },
    ], rows, { id: 'tbl-p' }),
      `<select onchange="UI.prodKind=this.value;rerender()"><option value="">All types</option>${KINDS.map(([v, l]) => `<option value="${v}" ${f === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
       <select onchange="UI.prodCat=this.value;rerender()"><option value="">All categories</option>${cats.map(c => `<option ${cat === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
       ${searchBox('tbl-p')} <button class="btn primary" onclick="editProduct()">+ New product</button>`);
  },
});
function editProduct(id) {
  const p = id ? byId('products', id) : { kind: 'product', unit: 'pcs', b2b: true, stock: 0, minStock: 0 };
  openForm({
    title: id ? 'Edit product' : 'New product', wide: true, values: p,
    fields: [
      { name: 'name', label: 'Name', required: true, full: true },
      { name: 'sku', label: 'SKU / code', required: true },
      { name: 'category', label: 'Category', required: true, list: [...new Set(db.products.map(x => x.category))] },
      { name: 'kind', label: 'Type', type: 'select', options: KINDS },
      { name: 'unit', label: 'Unit', list: ['pcs', 'box', 'pack', 'roll', 'm²', 'hour', 'set', 'kg'] },
      { name: 'cost', label: 'Cost (€)', type: 'number' },
      { name: 'price', label: 'List price (€, net)', type: 'number' },
      { name: 'stock', label: 'Stock on hand', type: 'number', help: id ? 'Use “Stock” to record adjustments with a reason' : '' },
      { name: 'minStock', label: 'Minimum stock', type: 'number' },
      { name: 'supplierId', label: 'Main supplier', type: 'select', options: pairs(db.suppliers, x => x.name, '— none —') },
      { name: 'b2b', label: 'B2B portal', type: 'checkbox', hint: 'Show in the B2B catalogue' },
      { name: 'eshop', label: 'E-shop', type: 'checkbox', hint: 'Show in the public e-shop' },
      { name: 'eshopPrice', label: 'E-shop price € incl. VAT (0 = list price + VAT)', type: 'number' },
      { name: 'description', label: 'Description / specs', type: 'textarea', full: true },
      { name: 'image', label: 'Photo', type: 'image', full: true },
    ],
    buttons: id ? [{ label: 'Delete', danger: true, onClick: () => deleteProduct(id) }] : [],
    onSave: d => {
      if (db.products.some(x => x.sku === d.sku && x.id !== id)) return toast('That SKU is already used', 'err');
      if (id) Object.assign(p, d); else db.products.push({ id: uid(), ...d });
      saveDB(); rerender(); toast('Product saved');
    },
  });
}
function deleteProduct(id) {
  const used = ['quotes', 'orders', 'invoices', 'purchaseOrders'].some(c => db[c].some(x => x.lines.some(l => l.productId === id)));
  if (used) return toast('Product is used in documents — hide it from B2B instead', 'err');
  db.products = db.products.filter(p => p.id !== id); db.supplierPrices = db.supplierPrices.filter(s => s.productId !== id);
  saveDB(); rerender(); toast('Product deleted');
}
function adjustStock(id) {
  const p = byId('products', id);
  const moves = db.stockMoves.filter(m => m.productId === id).slice(0, 12);
  openForm({
    title: `Stock — ${p.name}`,
    fields: [
      { name: 'qty', label: `Adjustment (+/−, current ${num(p.stock, 2)} ${p.unit})`, type: 'number', required: true },
      { name: 'reason', label: 'Reason', list: ['Stock count', 'Damaged', 'Internal use', 'Found', 'Returned by customer'], required: true },
    ],
    extra: `<h4>Recent movements</h4>${table([
      { label: 'Date', render: m => fmtDateTime(m.date) }, { label: 'Qty', cls: 'num', render: m => `<span class="${m.qty < 0 ? 'text-bad' : 'text-good'}">${m.qty > 0 ? '+' : ''}${num(m.qty, 2)}</span>` },
      { label: 'Reason / document', render: m => esc(m.reason) },
    ], moves, { empty: 'No movements recorded yet.' })}`,
    onSave: d => {
      if (!d.qty) return toast('Enter a non-zero quantity', 'err');
      applyStock([{ productId: id, qty: d.qty }], +1, d.reason); saveDB(); rerender(); toast('Stock adjusted');
    },
  });
}

/* ---------- suppliers ---------- */
page('suppliers', {
  title: 'Suppliers',
  render() {
    return card(`Suppliers (${db.suppliers.length})`, table([
      { label: 'Name', render: s => `<b>${esc(s.name)}</b><br><small>${esc(s.contact || '')}</small>` },
      { label: 'VAT', render: s => esc(s.vat) },
      { label: 'Contact', render: s => `${esc(s.email)}<br><small>${esc(s.phone)}</small>` },
      { label: 'Products priced', cls: 'num', render: s => db.supplierPrices.filter(x => x.supplierId === s.id).length },
      { label: 'Purchases (net)', cls: 'num', render: s => money(sum(db.purchaseOrders.filter(p => p.supplierId === s.id && p.status === 'received'), p => p.net)) },
      { label: 'Unpaid bills', cls: 'num', render: s => money(sum(db.bills.filter(b => b.supplierId === s.id && !b.paid), b => b.total)) },
    ], db.suppliers, { href: s => `supplier/${s.id}`, id: 'tbl-s' }), `${searchBox('tbl-s')} <button class="btn primary" onclick="editSupplier()">+ New supplier</button>`);
  },
});
function editSupplier(id) {
  const s = id ? byId('suppliers', id) : {};
  openForm({
    title: id ? 'Edit supplier' : 'New supplier', values: s,
    fields: [
      { name: 'name', label: 'Name', required: true, full: true }, { name: 'vat', label: 'VAT number' }, { name: 'contact', label: 'Contact person' },
      { name: 'email', label: 'Email', type: 'email' }, { name: 'phone', label: 'Phone' }, { name: 'city', label: 'City' },
      { name: 'notes', label: 'Notes', type: 'textarea', full: true },
    ],
    onSave: d => { if (id) Object.assign(s, d); else db.suppliers.push({ id: uid(), ...d }); saveDB(); rerender(); toast('Supplier saved'); },
  });
}
page('supplier', {
  nav: 'suppliers', title: id => nameOf('suppliers', id, 'Supplier'),
  render(id) {
    const s = byId('suppliers', id); if (!s) return notFound();
    const prices = db.supplierPrices.filter(x => x.supplierId === id);
    const pos = db.purchaseOrders.filter(p => p.supplierId === id).sort((a, b) => b.date.localeCompare(a.date));
    const bills = db.bills.filter(b => b.supplierId === id).sort((a, b) => b.date.localeCompare(a.date));
    const rfqs = db.rfqs.filter(r => r.supplierId === id).sort((a, b) => b.date.localeCompare(a.date));
    return `<div class="page-actions"><a class="btn" href="#/suppliers">← Suppliers</a><span class="spacer"></span>
      <button class="btn" onclick="createDraft('po',{supplierId:'${id}'})">+ Purchase order</button>
      <button class="btn" onclick="requestQuote('${id}')">✉ Request quote</button>
      <button class="btn" onclick="editSupplier('${id}')">Edit</button></div>
    <div class="grid-2">
      ${card('Details', `<dl class="dl"><dt>VAT</dt><dd>${esc(s.vat)}</dd><dt>Contact</dt><dd>${esc(s.contact || '')}</dd><dt>Email</dt><dd>${esc(s.email)}</dd><dt>Phone</dt><dd>${esc(s.phone)}</dd><dt>City</dt><dd>${esc(s.city || '')}</dd>${s.notes ? `<dt>Notes</dt><dd>${esc(s.notes)}</dd>` : ''}</dl>`)}
      ${card('Quote requests', table([
        { label: 'Date', render: r => fmtDate(r.date) }, { label: 'Products', render: r => esc(r.items.map(i => nameOf('products', i.productId)).join(', ')) },
        { label: 'Status', render: r => badge(r.status) },
        { label: '', render: r => r.status === 'awaiting' ? `<button class="btn xs" onclick="rfqAnswer('${r.id}')">Enter reply</button>` : '' },
      ], rfqs, { empty: 'No quote requests yet.' }))}
    </div>
    ${card('Supplier price list', table([
      { label: 'Product', render: x => esc(nameOf('products', x.productId)) },
      { label: 'Price', cls: 'num', render: x => money(x.price) },
      { label: 'Best?', render: x => bestSupplierPrice(x.productId)?.id === x.id ? '<span class="badge b-paid">cheapest</span>' : '' },
      { label: 'Lead time', cls: 'num', render: x => `${x.leadDays || '—'} days` },
      { label: 'Updated', render: x => fmtDate(x.updated) },
      { label: '', render: x => `<button class="btn xs" onclick="editSupplierPrice('${id}','${x.id}')">Edit</button>` },
    ], prices, { empty: 'No prices yet.' }), `<button class="btn sm" onclick="editSupplierPrice('${id}')">+ Add price</button>`)}
    <div class="grid-2">
      ${card('Purchase orders', table([
        { label: 'PO', render: p => `<b>${esc(p.number)}</b>` }, { label: 'Date', render: p => fmtDate(p.date) },
        { label: 'Total', cls: 'num', render: p => money(p.total) }, { label: 'Status', render: p => badge(p.status) },
      ], pos, { href: p => `edit/po/${p.id}`, empty: 'No purchase orders.' }))}
      ${card('Supplier bills', billsTable(bills))}
    </div>`;
  },
});
function bestSupplierPrice(productId) {
  return db.supplierPrices.filter(x => x.productId === productId).sort((a, b) => a.price - b.price)[0];
}
function editSupplierPrice(supplierId, spId) {
  const sp = spId ? byId('supplierPrices', spId) : { supplierId, leadDays: 3 };
  openForm({
    title: spId ? 'Edit supplier price' : 'Add supplier price', values: sp,
    fields: [
      { name: 'productId', label: 'Product', type: 'select', options: pairs(db.products.filter(p => p.kind !== 'service'), p => `${p.sku} · ${p.name}`), required: true },
      { name: 'price', label: 'Price (€, net)', type: 'number', required: true },
      { name: 'leadDays', label: 'Lead time (days)', type: 'number' },
    ],
    buttons: spId ? [{ label: 'Delete', danger: true, onClick: () => { db.supplierPrices = db.supplierPrices.filter(x => x.id !== spId); saveDB(); rerender(); } }] : [],
    onSave: d => {
      const dup = db.supplierPrices.find(x => x.supplierId === supplierId && x.productId === d.productId && x.id !== spId);
      if (dup) return toast('This supplier already has a price for that product', 'err');
      if (spId) Object.assign(sp, d, { updated: today() }); else db.supplierPrices.push({ id: uid(), supplierId, ...d, updated: today() });
      saveDB(); rerender(); toast('Price saved');
    },
  });
}
function requestQuote(supplierId, productIds = []) {
  const s = byId('suppliers', supplierId);
  const prods = db.products.filter(p => p.kind !== 'service');
  openModal(`Request quote — ${s.name}`, `<p class="muted">Select products and quantities. An email request is sent to ${esc(s.email)}.</p>
    <div class="table-wrap"><table class="tbl"><thead><tr><th></th><th>Product</th><th class="num">Qty</th></tr></thead><tbody>
    ${prods.map(p => `<tr><td><input type="checkbox" class="rfq-chk" value="${p.id}" ${productIds.includes(p.id) ? 'checked' : ''}></td><td>${esc(p.name)}</td><td><input type="number" class="num w-sm" id="rfq-q-${p.id}" value="${Math.max(1, p.minStock)}"></td></tr>`).join('')}
    </tbody></table></div>${fieldHTML({ name: 'rfqmsg', label: 'Message', type: 'textarea', full: true }, 'Please send us your best price and lead time for the items below.')}`,
    [{ label: 'Cancel' }, {
      label: 'Send request', primary: true, onClick: () => {
        const items = [...document.querySelectorAll('.rfq-chk:checked')].map(c => ({ productId: c.value, qty: +document.getElementById('rfq-q-' + c.value).value || 1 }));
        if (!items.length) return toast('Select at least one product', 'err');
        const msg = document.getElementById('f_rfqmsg').value;
        db.rfqs.push({ id: uid(), supplierId, date: today(), items, status: 'awaiting' });
        logEmail({ to: s.email, subject: `Request for quotation — ${db.settings.company.name}`, body: `${msg}\n\n${items.map(i => `- ${nameOf('products', i.productId)}: ${i.qty}`).join('\n')}\n\n${db.settings.company.name}`, ref: 'RFQ' });
        saveDB(); rerender(); toast('Quote request email queued');
      },
    }], { wide: true });
}
function rfqAnswer(id) {
  const r = byId('rfqs', id);
  openModal('Enter supplier reply', `<p class="muted">Prices entered here update the supplier price list and the price comparison.</p>
    ${r.items.map(i => { const cur = db.supplierPrices.find(x => x.supplierId === r.supplierId && x.productId === i.productId); return fieldHTML({ name: 'rfqp_' + i.productId, label: `${nameOf('products', i.productId)} — unit price (€)`, type: 'number' }, cur?.price ?? ''); }).join('')}
    ${fieldHTML({ name: 'rfqlead', label: 'Lead time (days)', type: 'number' }, 5)}`,
    [{ label: 'Cancel' }, {
      label: 'Save reply', primary: true, onClick: () => {
        const lead = +document.getElementById('f_rfqlead').value || 0;
        r.items.forEach(i => {
          const v = +document.getElementById('f_rfqp_' + i.productId).value; if (!v) return;
          const cur = db.supplierPrices.find(x => x.supplierId === r.supplierId && x.productId === i.productId);
          if (cur) Object.assign(cur, { price: v, leadDays: lead, updated: today() });
          else db.supplierPrices.push({ id: uid(), supplierId: r.supplierId, productId: i.productId, price: v, leadDays: lead, updated: today() });
        });
        r.status = 'answered'; saveDB(); rerender(); toast('Prices updated');
      },
    }]);
}

/* ---------- purchasing ---------- */
page('purchasing', {
  title: 'Purchasing',
  render(tab = '') {
    const head = tabs('purchasing', [['', 'Purchase orders'], ['compare', 'Price comparison'], ['bills', 'Supplier bills']], tab);
    if (tab === 'compare') return head + priceComparison();
    if (tab === 'bills') return head + card('Supplier bills', billsTable([...db.bills].sort((a, b) => b.date.localeCompare(a.date))));
    const low = lowStockItems().map(x => x.product);
    const rows = [...db.purchaseOrders].sort((a, b) => b.date.localeCompare(a.date));
    return head + (low.length ? `<div class="note warn"><b>${low.length} items</b> are at or below minimum stock, even counting open POs: ${low.map(p => esc(p.name)).join(', ')}.
        <button class="btn sm primary" onclick="autoPurchase(lowStockItems())">Create POs automatically</button></div>` : '') +
      card('Purchase orders', table([
        { label: 'PO', render: p => `<b>${esc(p.number)}</b>` },
        { label: 'Supplier', render: p => esc(nameOf('suppliers', p.supplierId)) },
        { label: 'Date', render: p => fmtDate(p.date) },
        { label: 'Expected', render: p => `<span class="${p.status === 'sent' && p.expectedDate < today() ? 'text-bad' : ''}">${fmtDate(p.expectedDate)}</span>` },
        { label: 'Items', render: p => esc(p.lines.map(l => `${l.qty}× ${l.desc}`).join(', ')) },
        { label: 'Total', cls: 'num', render: p => money(p.total) },
        { label: 'Status', render: p => badge(p.status) + (p.auto ? ' <span class="tag">auto</span>' : '') },
      ], rows, { href: p => `edit/po/${p.id}`, id: 'tbl-po' }), `${searchBox('tbl-po')} <button class="btn primary" onclick="createDraft('po')">+ New PO</button>`);
  },
});
function lowStockItems() {
  const onOrder = {};
  db.purchaseOrders.filter(p => ['draft', 'sent'].includes(p.status)).forEach(p => p.lines.forEach(l => { onOrder[l.productId] = (onOrder[l.productId] || 0) + l.qty; }));
  return db.products.filter(p => p.kind !== 'service' && p.stock + (onOrder[p.id] || 0) <= p.minStock)
    .map(p => ({ product: p, qty: Math.max(1, Math.ceil(p.minStock * 1.5 - p.stock - (onOrder[p.id] || 0))) }));
}
function autoPurchase(items) {
  if (!items.length) return toast('Nothing to order — everything is covered by stock or open POs', 'warn');
  const bySup = new Map();
  for (const it of items) {
    const best = bestSupplierPrice(it.product.id);
    const sid = best?.supplierId || it.product.supplierId;
    if (!sid) { toast(`No supplier for ${it.product.name}`, 'warn'); continue; }
    if (!bySup.has(sid)) bySup.set(sid, []);
    const sp = db.supplierPrices.find(x => x.supplierId === sid && x.productId === it.product.id);
    bySup.get(sid).push({ productId: it.product.id, desc: it.product.name, qty: it.qty, unitCost: 0, price: sp ? sp.price : it.product.cost, discount: 0 });
  }
  let n = 0;
  for (const [sid, lines] of bySup) {
    const lead = Math.max(3, ...lines.map(l => db.supplierPrices.find(x => x.supplierId === sid && x.productId === l.productId)?.leadDays || 3));
    db.purchaseOrders.push({ id: uid(), number: nextNo('po'), supplierId: sid, date: today(), expectedDate: addDays(today(), lead), lines, notes: 'Generated automatically from stock levels', status: 'draft', auto: true, ...totals(lines) });
    n++;
  }
  saveDB(); toast(`${n} draft purchase order(s) created at the cheapest supplier`); go('purchasing');
}
function priceComparison() {
  const prods = db.products.filter(p => p.kind !== 'service');
  const sups = db.suppliers;
  return `<div class="note">Supplier prices for each product. The cheapest is highlighted. Automatic POs use the cheapest supplier. Use “Request quote” to ask suppliers for new prices.</div>` +
    card('Price comparison', `<div class="table-wrap"><table class="tbl compare"><thead><tr><th>Product</th><th class="num">Our cost</th>${sups.map(s => `<th class="num"><a href="#/supplier/${s.id}">${esc(s.name)}</a></th>`).join('')}<th class="num">Saving vs. highest</th></tr></thead>
    <tbody>${prods.map(p => {
      const ps = sups.map(s => db.supplierPrices.find(x => x.supplierId === s.id && x.productId === p.id));
      const vals = ps.filter(Boolean).map(x => x.price); const min = Math.min(...vals), max = Math.max(...vals);
      return `<tr><td>${esc(p.name)}</td><td class="num">${money(p.cost)}</td>${ps.map(x => `<td class="num ${x && x.price === min && vals.length > 1 ? 'best' : ''}">${x ? money(x.price) + `<br><small class="muted">${x.leadDays}d · ${fmtDate(x.updated)}</small>` : '<span class="muted">—</span>'}</td>`).join('')}
        <td class="num">${vals.length > 1 ? money(max - min) + ` <small>(${pct((max - min) / max * 100)})</small>` : '—'}</td></tr>`;
    }).join('')}</tbody></table></div>`,
      `<select onchange="if(this.value){requestQuote(this.value);this.value=''}"><option value="">✉ Request quote from…</option>${opt(sups)}</select>`);
}
function billsTable(bills) {
  return table([
    { label: 'Bill', render: b => `<b>${esc(b.number)}</b><br><small>ref ${esc(b.supplierRef || '—')}</small>` },
    { label: 'Supplier', render: b => esc(nameOf('suppliers', b.supplierId)) },
    { label: 'PO', render: b => b.poId ? `<a href="#/edit/po/${b.poId}">${esc(byId('purchaseOrders', b.poId)?.number || '')}</a>` : '' },
    { label: 'Date', render: b => fmtDate(b.date) }, { label: 'Due', render: b => fmtDate(b.dueDate) },
    { label: 'Total', cls: 'num', render: b => money(b.total) },
    { label: 'Status', render: b => b.paid ? badge('paid') : `${badge(b.dueDate < today() ? 'overdue' : 'unpaid')} ${can('purchasing') ? `<button class="btn xs" onclick="billPaid('${b.id}')">Mark paid</button>` : ''}` },
  ], bills, { empty: 'No supplier bills. Bills are created automatically when goods are received.' });
}
function billPaid(id) { byId('bills', id).paid = true; saveDB(); rerender(); toast('Bill marked as paid'); }

/* ---------- PO actions (called from the document editor) ---------- */
function poSend() {
  if (!needSaved()) return;
  const po = edRec(); const s = byId('suppliers', po.supplierId);
  po.status = 'sent';
  if (!autoEmail('poSent', s.email, { customer: s.name, number: po.number, total: money(po.total), date: fmtDate(po.expectedDate) }, po.number))
    logEmail({ to: s.email, subject: `Purchase order ${po.number}`, body: 'Please see attached purchase order.', ref: po.number });
  saveDB(); toast(`PO email queued to ${s.email}`); rerender();
}
function poReceive() {
  if (!needSaved()) return;
  const po = edRec(); const s = byId('suppliers', po.supplierId);
  openForm({
    title: `Receive goods — ${po.number}`,
    fields: [
      { name: 'supplierRef', label: 'Supplier invoice no.', required: true },
      { name: 'date', label: 'Received on', type: 'date', required: true },
      { name: 'terms', label: 'Payment terms (days)', type: 'number' },
      { name: 'updatePrices', label: 'Prices', type: 'checkbox', hint: 'Update supplier price list & product cost' },
    ],
    values: { date: today(), terms: 30, updatePrices: true },
    extra: `<p class="muted">Stock will increase by: ${esc(po.lines.map(l => `${l.qty}× ${l.desc}`).join(', '))}. A supplier bill will be created automatically.</p>`,
    saveLabel: 'Receive',
    onSave: d => {
      applyStock(po.lines, +1, po.number + ' received');
      po.status = 'received'; po.receivedAt = d.date;
      db.bills.push({ id: uid(), number: nextNo('bill'), supplierRef: d.supplierRef, supplierId: s.id, poId: po.id, date: d.date, dueDate: addDays(d.date, d.terms || 0), net: po.net, vat: po.vat, total: po.total, paid: false });
      if (d.updatePrices) po.lines.forEach(l => {
        const p = byId('products', l.productId); if (!p) return;
        p.cost = l.price;
        const sp = db.supplierPrices.find(x => x.supplierId === s.id && x.productId === p.id);
        if (sp) Object.assign(sp, { price: l.price, updated: d.date }); else db.supplierPrices.push({ id: uid(), supplierId: s.id, productId: p.id, price: l.price, leadDays: 3, updated: d.date });
      });
      saveDB(); toast('Goods received, stock updated, bill recorded'); rerender();
    },
  });
}
function poCancel() { if (!needSaved()) return; confirmBox('Cancel this purchase order?', () => { edRec().status = 'cancelled'; saveDB(); rerender(); }, 'Cancel PO'); }
