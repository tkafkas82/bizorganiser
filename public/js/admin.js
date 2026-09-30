'use strict';
/* =========================================================================
   Sales reps & commissions, reports, B2B price lists, settings
   ========================================================================= */

const PERIODS = [['month', 'This month'], ['quarter', 'Last 3 months'], ['year', 'This year'], ['12m', 'Last 12 months'], ['all', 'All time']];
function periodStart(p) {
  const t = today();
  if (p === 'month') return t.slice(0, 8) + '01';
  if (p === 'quarter') { const d = parseD(t); return isoOf(new Date(d.getFullYear(), d.getMonth() - 2, 1)); }
  if (p === 'year') return t.slice(0, 4) + '-01-01';
  if (p === '12m') { const d = parseD(t); return isoOf(new Date(d.getFullYear(), d.getMonth() - 11, 1)); }
  return '0000';
}
const periodSelect = (key, def = 'quarter') => `<select onchange="UI.${key}=this.value;rerender()">${PERIODS.map(([v, l]) => `<option value="${v}" ${(UI[key] || def) === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
const invoicesIn = p => db.invoices.filter(i => !i.cancelled && i.date >= periodStart(p));

/* ---------- sales reps ---------- */
function repStats(r, p) {
  const inv = invoicesIn(p).filter(i => i.repId === r.id);
  const net = sum(inv, invNet);
  const paidNet = sum(inv.filter(i => ['paid', 'credit'].includes(invStatus(i))), invNet);
  return { inv, net, commission: round2(net * r.commission / 100), paidCommission: round2(paidNet * r.commission / 100), customers: db.customers.filter(c => c.repId === r.id).length, openQuotes: db.quotes.filter(q => q.repId === r.id && ['draft', 'sent'].includes(q.status)).length };
}
page('reps', {
  title: 'Sales reps & commissions',
  render() {
    const p = UI.repPeriod || 'quarter';
    const stats = db.reps.map(r => ({ r, ...repStats(r, p) }));
    return `<div class="note">Commissions are calculated live from invoiced net sales for each rep's customers and orders. “Earned” counts only invoices that have been paid.</div>` +
      card('Sales network', table([
        { label: 'Rep', render: s => `<b>${esc(s.r.name)}</b><br><small>${esc(s.r.email)}</small>` },
        { label: 'Rate', cls: 'num', render: s => s.r.commission + '%' },
        { label: 'Customers', cls: 'num', render: s => s.customers },
        { label: 'Open quotes', cls: 'num', render: s => s.openQuotes },
        { label: 'Invoices', cls: 'num', render: s => s.inv.length },
        { label: 'Sales (net)', cls: 'num', render: s => money(s.net) },
        { label: 'Commission', cls: 'num', render: s => `<b>${money(s.commission)}</b>` },
        { label: 'Earned (paid)', cls: 'num', render: s => money(s.paidCommission) },
        { label: '', render: s => `<button class="btn xs" onclick="repDetail('${s.r.id}')">Details</button> <button class="btn xs" onclick="editRep('${s.r.id}')">Edit</button>` },
      ], stats, { foot: `<tfoot><tr><td colspan="5">Total</td><td class="num">${money(sum(stats, s => s.net))}</td><td class="num">${money(sum(stats, s => s.commission))}</td><td class="num">${money(sum(stats, s => s.paidCommission))}</td><td></td></tr></tfoot>` }),
        `${periodSelect('repPeriod')} <button class="btn primary" onclick="editRep()">+ New rep</button>`) +
      card('Sales by rep', hbars(stats.map(s => ({ label: s.r.name, value: s.net }))));
  },
});
function editRep(id) {
  const r = id ? byId('reps', id) : { commission: 5 };
  openForm({
    title: id ? 'Edit sales rep' : 'New sales rep', values: r,
    fields: [{ name: 'name', label: 'Name', required: true, full: true }, { name: 'email', label: 'Email', type: 'email' }, { name: 'phone', label: 'Phone' }, { name: 'commission', label: 'Commission %', type: 'number' }],
    onSave: d => { if (id) Object.assign(r, d); else db.reps.push({ id: uid(), ...d }); saveDB(); rerender(); toast('Saved'); },
  });
}
function repDetail(id) {
  const r = byId('reps', id); const p = UI.repPeriod || 'quarter'; const s = repStats(r, p);
  openModal(`${r.name} — ${PERIODS.find(x => x[0] === p)[1]}`, table([
    { label: 'Invoice', render: i => esc(i.number) }, { label: 'Date', render: i => fmtDate(i.date) },
    { label: 'Customer', render: i => esc(nameOf('customers', i.customerId)) }, { label: 'Net', cls: 'num', render: i => money(i.net) },
    { label: 'Commission', cls: 'num', render: i => money(i.net * r.commission / 100) }, { label: 'Status', render: i => badge(invStatus(i)) },
  ], s.inv, { empty: 'No invoices in this period.' }) + `<p><b>Total commission: ${money(s.commission)}</b> · earned (paid): ${money(s.paidCommission)}</p>`, [
    { label: 'Export CSV', onClick: () => { downloadFile(`commission-${r.name}.csv`, toCSV([['Invoice', 'Date', 'Customer', 'Net', 'Commission', 'Status'], ...s.inv.map(i => [i.number, i.date, nameOf('customers', i.customerId), i.net, round2(i.net * r.commission / 100), invStatus(i)])]), 'text/csv'); return false; } },
    { label: 'Close' }], { wide: true });
}

/* ---------- reports ---------- */
page('reports', {
  title: 'Reports',
  render() {
    const p = UI.repPeriodR || 'quarter';
    const inv = invoicesIn(p);
    const lines = inv.flatMap(i => i.lines.map(l => ({ i, l, sg: isCredit(i) ? -1 : 1, p: byId('products', l.productId), c: byId('customers', i.customerId) })));
    const net = sum(inv, invNet), cost = sum(inv, invCost);
    const quotes = db.quotes.filter(q => q.date >= periodStart(p));
    const decided = quotes.filter(q => ['converted', 'accepted', 'rejected'].includes(q.status));
    const won = decided.filter(q => q.status !== 'rejected');
    const agg = (f, n = 8) => [...groupBy(lines, f)].map(([k, ls]) => ({ label: k, value: sum(ls, x => x.sg * lineNet(x.l)) })).sort((a, b) => b.value - a.value).slice(0, n);
    const months = lastMonths(12).map(m => ({ label: m.label, value: sum(db.invoices.filter(i => !i.cancelled && i.date.startsWith(m.key)), invNet) }));
    const t = today();
    const aging = [['Not due', i => i.dueDate >= t], ['1–30 days', i => i.dueDate < t && daysBetween(i.dueDate, t) <= 30], ['31–60 days', i => daysBetween(i.dueDate, t) > 30 && daysBetween(i.dueDate, t) <= 60], ['60+ days', i => daysBetween(i.dueDate, t) > 60]]
      .map(([label, f]) => ({ label, value: sum(db.invoices.filter(i => !i.cancelled && balanceOf(i) > 0 && f(i)), balanceOf) }));
    const topProducts = [...groupBy(lines, x => x.l.desc)].map(([k, ls]) => ({ name: k, qty: sum(ls, x => x.sg * x.l.qty), net: sum(ls, x => x.sg * lineNet(x.l)), cost: sum(ls, x => x.sg * x.l.qty * x.l.unitCost) })).sort((a, b) => b.net - a.net).slice(0, 10);
    const purchases = sum(db.purchaseOrders.filter(x => x.status === 'received' && (x.receivedAt || x.date) >= periodStart(p)), x => x.net);
    return `<div class="toolbar">${periodSelect('repPeriodR')}<span class="spacer"></span><button class="btn" onclick="exportInvoicesCSV()">Export invoices CSV</button></div>
    <div class="kpis">
      ${kpi('Revenue (net)', money(net), `${inv.filter(i => !isCredit(i)).length} invoices · ${inv.filter(isCredit).length} credit notes`)}
      ${kpi('Gross margin', money(net - cost), pct(net ? (net - cost) / net * 100 : 0))}
      ${kpi('Average invoice', money(inv.filter(i => !isCredit(i)).length ? sum(inv.filter(i => !isCredit(i)), i => i.net) / inv.filter(i => !isCredit(i)).length : 0))}
      ${kpi('Quote win rate', pct(decided.length ? won.length / decided.length * 100 : 0), `${won.length}/${decided.length} quotes`)}
      ${kpi('Purchases (net)', money(purchases))}
      ${kpi('VAT charged', money(sum(inv, invVat)))}
    </div>
    ${card('Monthly revenue — last 12 months', barChart(months))}
    <div class="grid-2">
      ${card('Sales by category', hbars(agg(x => x.p?.category || 'Custom items')))}
      ${card('Top customers', hbars(agg(x => x.c?.name || '—')))}
      ${card('Sales by region', hbars(agg(x => x.c?.region || '—')))}
      ${card('Sales by customer group', hbars(agg(x => x.c?.group || '—')))}
    </div>
    <div class="grid-2">
      ${card('Top products', table([
        { label: 'Product', render: r => esc(r.name) }, { label: 'Qty', cls: 'num', render: r => num(r.qty, 1) },
        { label: 'Net', cls: 'num', render: r => money(r.net) }, { label: 'Margin', cls: 'num', render: r => pct(r.net ? (r.net - r.cost) / r.net * 100 : 0) },
      ], topProducts, { empty: 'No sales in this period.' }))}
      ${card('Receivables aging', hbars(aging) + `<p class="muted sm">Open balance by how overdue it is (all periods).</p>`)}
    </div>`;
  },
});
function exportInvoicesCSV() {
  const inv = invoicesIn(UI.repPeriodR || 'quarter');
  downloadFile('invoices.csv', toCSV([['Number', 'Type', 'Date', 'Customer', 'VAT', 'Net', 'VAT amount', 'Total', 'Paid', 'Status', 'myDATA MARK'],
    ...inv.map(i => [i.number, i.type, i.date, nameOf('customers', i.customerId), byId('customers', i.customerId)?.vat, i.net, i.vat, i.total, paidOf(i), invStatus(i), i.mydata?.mark || ''])]), 'text/csv');
}

/* ---------- price lists (B2B) ---------- */
page('pricelists', {
  title: 'B2B price lists',
  render() {
    return `<div class="note">Price lists set the prices each customer sees on quotes, orders and the B2B portal: a percentage discount on list prices, plus fixed prices for specific products. Assign a list to a customer on their record.</div>` +
      card('Price lists', table([
        { label: 'Name', render: l => `<b>${esc(l.name)}</b>` },
        { label: 'Discount', cls: 'num', render: l => l.discount + '%' },
        { label: 'Special prices', cls: 'num', render: l => (l.overrides || []).length },
        { label: 'Customers', render: l => esc(db.customers.filter(c => c.priceListId === l.id).map(c => c.name).join(', ') || '—') },
      ], db.priceLists, { href: l => `pricelist/${l.id}` }), `<button class="btn primary" onclick="newPriceList()">+ New price list</button>`);
  },
});
function newPriceList() {
  openForm({
    title: 'New price list', fields: [{ name: 'name', label: 'Name', required: true }, { name: 'discount', label: 'Discount on list price %', type: 'number' }],
    onSave: d => { const l = { id: uid(), ...d, overrides: [] }; db.priceLists.push(l); saveDB(); setTimeout(() => go('pricelist/' + l.id)); },
  });
}
page('pricelist', {
  nav: 'pricelists', perm: () => 'pricelists', title: id => 'Price list: ' + nameOf('priceLists', id, ''),
  render(id) {
    const l = byId('priceLists', id); if (!l) return notFound();
    const prods = db.products.filter(p => p.kind !== 'material');
    return `<div class="page-actions"><a class="btn" href="#/pricelists">← Price lists</a><span class="spacer"></span>
      <button class="btn danger" onclick="deletePriceList('${id}')">Delete</button></div>
      ${card('Settings', `<div class="form-grid cols-4">
        <div class="field"><label>Name</label><input value="${esc(l.name)}" onchange="plSet('${id}','name',this.value)"></div>
        <div class="field"><label>Discount %</label><input type="number" value="${l.discount}" onchange="plSet('${id}','discount',+this.value)"></div>
        <div class="field full"><label>Customers</label><div class="static">${esc(db.customers.filter(c => c.priceListId === id).map(c => c.name).join(', ') || 'None — assign on the customer record')}</div></div></div>`)}
      ${card('Product prices', table([
        { label: 'Product', render: p => esc(p.name) },
        { label: 'List price', cls: 'num', render: p => money(p.price) },
        { label: 'With discount', cls: 'num', render: p => money(p.price * (1 - l.discount / 100)) },
        { label: 'Special price', cls: 'num', render: p => { const o = l.overrides.find(x => x.productId === p.id); return `<input type="number" step="0.01" class="num w-sm" value="${o ? o.price : ''}" placeholder="—" onchange="plOverride('${id}','${p.id}',this.value)">`; } },
        { label: 'Customer pays', cls: 'num', render: p => { const o = l.overrides.find(x => x.productId === p.id); return `<b>${money(o ? o.price : p.price * (1 - l.discount / 100))}</b>`; } },
        { label: 'Margin', cls: 'num', render: p => { const o = l.overrides.find(x => x.productId === p.id); const pr = o ? o.price : p.price * (1 - l.discount / 100); return pct(pr ? (pr - p.cost) / pr * 100 : 0); } },
      ], prods, { id: 'tbl-pl' }), searchBox('tbl-pl'))}`;
  },
});
function plSet(id, k, v) { byId('priceLists', id)[k] = v; saveDB(); rerender(); }
function plOverride(id, pid, v) {
  const l = byId('priceLists', id); l.overrides = l.overrides.filter(o => o.productId !== pid);
  if (v !== '') l.overrides.push({ productId: pid, price: +v });
  saveDB(); rerender();
}
function deletePriceList(id) {
  confirmBox('Delete this price list? Customers using it go back to standard prices.', () => {
    db.priceLists = db.priceLists.filter(l => l.id !== id); db.customers.forEach(c => { if (c.priceListId === id) c.priceListId = ''; });
    saveDB(); go('pricelists');
  }, 'Delete');
}

/* ---------- settings ---------- */
const SETTINGS_TABS = [['', 'Company'], ['documents', 'Documents & production'], ['email', 'Email templates'], ['shop', 'E-shop builder'], ['integrations', 'Integrations'], ['users', 'Users & logins'], ['data', 'Data & audit']];
page('settings', {
  title: 'Settings',
  render(tab = '') {
    const admin = me().role === 'admin';
    const head = tabs('settings', SETTINGS_TABS, tab) + (admin ? '' : `<div class="note warn">Only administrators can change settings.</div>`);
    const S = db.settings;
    if (tab === 'documents') return head + card('Documents', `<div class="form-grid cols-4">
        ${fieldHTML({ name: 'vatRate', label: 'VAT rate %', type: 'number' }, S.vatRate)}
        ${Object.entries(S.prefixes).map(([k, v]) => fieldHTML({ name: 'pre_' + k, label: `Prefix: ${k}` }, v)).join('')}
      </div><p class="muted sm">Document numbers are assigned by the server in strict sequence, so invoice numbering has no gaps.</p>`) + card('Lists', `<div class="form-grid">
        ${fieldHTML({ name: 'steps', label: 'Production steps (one per line) — used for new work orders', type: 'textarea', rows: 6 }, S.productionSteps.join('\n'))}
        ${fieldHTML({ name: 'couriers', label: 'Couriers (one per line)', type: 'textarea', rows: 6 }, S.couriers.join('\n'))}
        ${fieldHTML({ name: 'regions', label: 'Regions (one per line)', type: 'textarea', rows: 6 }, S.regions.join('\n'))}
        ${fieldHTML({ name: 'groups', label: 'Customer groups (one per line)', type: 'textarea', rows: 6 }, S.groups.join('\n'))}
      </div>`, '') + saveBar('saveDocSettings()');
    if (tab === 'email') return head + `<div class="note">Templates can use <code>{{customer}}</code>, <code>{{number}}</code>, <code>{{total}}</code>, <code>{{date}}</code>, <code>{{company}}</code>, <code>{{courier}}</code>, <code>{{tracking}}</code>. Sent emails are listed in the <a href="#/outbox">outbox</a>.</div>` +
      Object.entries(S.templates).map(([k, t]) => card(t.name, `<label class="chk"><input type="checkbox" id="auto_${k}" ${S.automations[k] ? 'checked' : ''}> Send automatically</label>
        <div class="form-grid">${fieldHTML({ name: `tpl_${k}_subject`, label: 'Subject', full: true }, t.subject)}${fieldHTML({ name: `tpl_${k}_body`, label: 'Body', type: 'textarea', rows: 5, full: true }, t.body)}</div>`)).join('') +
      saveBar('saveEmailSettings()');
    if (tab === 'shop') return head + shopBuilder();
    if (tab === 'integrations') {
      if (!admin) return head;
      setTimeout(loadIntegrations);
      return head + `<div id="integrations"><div class="empty">Loading…</div></div>`;
    }
    if (tab === 'users') {
      if (!admin) return head + card('Users', table([{ label: 'Name', render: u => esc(u.name) }, { label: 'Role', render: u => esc(ROLES[u.role]?.label || u.role) }], db.users));
      setTimeout(loadUsers);
      return head + `<div class="note">Staff sign in to this app; <b>customer logins</b> sign in to the B2B portal at <a href="/b2b/" target="_blank">/b2b/</a> and only see their own company's prices, orders and invoices. New users must change their password at first sign-in.</div><div id="users-admin"><div class="empty">Loading…</div></div>` +
        card('Role permissions', table([
          { label: 'Role', render: ([, r]) => `<b>${esc(r.label)}</b>` },
          { label: 'Can open', render: ([, r]) => r.pages === '*' ? 'Everything' : esc(r.pages.join(', ')) },
        ], [...Object.entries(ROLES), ['customer', { label: 'Customer (B2B portal)', pages: ['own catalogue prices, orders, invoices'] }]]));
    }
    if (tab === 'data') {
      if (admin) setTimeout(loadAudit);
      return head + card('Backup & restore', `<p>All data is stored on the server in <code>data/bizorganiser.db</code> (SQLite). Back up the whole <code>data</code> folder regularly — it also holds uploaded files and integration settings.</p>
      <p class="muted sm">${db.customers.length} customers · ${db.orders.length} orders · ${db.invoices.length} invoices · ${db.products.length} products</p>
      <div class="btn-row"><button class="btn primary" onclick="exportData()">⬇ Export JSON</button>
      ${admin ? `<label class="btn">⬆ Import JSON<input type="file" accept="application/json" hidden onchange="importData(this)"></label>
      <button class="btn" onclick="confirmBox('Replace ALL business data with fresh demo data? Users are kept.',()=>adminAction('/api/admin/reset-demo','Demo data restored'),'Reset')">Reset demo data</button>
      <button class="btn danger" onclick="confirmBox('Delete ALL business data and start empty? Users and company details are kept.',()=>adminAction('/api/admin/reset-empty','Started with empty data'),'Delete everything')">Start empty</button>` : ''}</div>`) +
        (admin ? card('Audit log', `<div id="audit"><div class="empty">Loading…</div></div>`) : '');
    }
    const c = S.company;
    return head + card('Company details (printed on documents and sent to myDATA)', `<div class="form-grid">
      ${[['name', 'Company name'], ['vat', 'VAT number (ΑΦΜ)'], ['taxOffice', 'Tax office'], ['email', 'Email'], ['phone', 'Phone'], ['address', 'Address'], ['iban', 'IBAN']].map(([k, l]) => fieldHTML({ name: 'co_' + k, label: l }, c[k])).join('')}
      </div>`, '') + saveBar('saveCompany()');
  },
});
const saveBar = fn => me().role === 'admin' ? `<div class="page-actions"><span class="spacer"></span><button class="btn primary" onclick="${fn}">Save</button></div>` : '';
const val = id => document.getElementById('f_' + id)?.value ?? '';
const splitLines = id => val(id).split('\n').map(s => s.trim()).filter(Boolean);
function saveCompany() {
  for (const k of ['name', 'vat', 'taxOffice', 'email', 'phone', 'address', 'iban']) { const v = document.getElementById('f_co_' + k); if (v) db.settings.company[k] = v.value.trim(); }
  saveDB(); rerender(); toast('Company details saved');
}
function saveDocSettings() {
  const S = db.settings;
  S.vatRate = +val('vatRate') || 0;
  for (const k of Object.keys(S.prefixes)) S.prefixes[k] = val('pre_' + k) || S.prefixes[k];
  S.productionSteps = splitLines('steps'); S.couriers = splitLines('couriers'); S.regions = splitLines('regions'); S.groups = splitLines('groups');
  saveDB(); rerender(); toast('Settings saved');
}
function saveEmailSettings() {
  const S = db.settings;
  for (const [k, t] of Object.entries(S.templates)) {
    S.automations[k] = document.getElementById('auto_' + k).checked;
    t.subject = val(`tpl_${k}_subject`); t.body = document.getElementById(`f_tpl_${k}_body`).value;
  }
  saveDB(); toast('Email settings saved');
}

/* ---------- e-shop builder ---------- */
function shopBuilder() {
  const sh = db.settings.shop || {};
  const shopProducts = db.products.filter(p => p.eshop && p.kind !== 'material');
  const gross = p => p.eshopPrice ? p.eshopPrice : round2(p.price * (1 + db.settings.vatRate / 100));
  return `<div class="note">Your public online shop for retail customers is at <a href="/shop/" target="_blank"><b>/shop/</b></a>. Orders placed there appear under <a href="#/orders">Orders</a> (source: e-shop), and a customer record is created automatically. Choose which products appear with “Show in e-shop” on each product.</div>
    <div class="grid-2">
    ${card('Shop page', `<div class="form-grid">
      ${fieldHTML({ name: 'sh_enabled', label: 'Status', type: 'checkbox', hint: 'Shop is open' }, sh.enabled)}
      ${fieldHTML({ name: 'sh_accent', label: 'Accent colour', type: 'color' }, sh.accent || '#2458d6')}
      ${fieldHTML({ name: 'sh_title', label: 'Shop name', full: true }, sh.title)}
      ${fieldHTML({ name: 'sh_tagline', label: 'Tagline', full: true }, sh.tagline)}
      ${fieldHTML({ name: 'sh_heroTitle', label: 'Banner headline', full: true }, sh.heroTitle)}
      ${fieldHTML({ name: 'sh_heroText', label: 'Banner text', type: 'textarea', full: true }, sh.heroText)}
      ${fieldHTML({ name: 'sh_logo', label: 'Logo', type: 'image', full: true }, sh.logo)}
      ${fieldHTML({ name: 'sh_about', label: 'About us', type: 'textarea', rows: 4, full: true }, sh.about)}
      ${fieldHTML({ name: 'sh_terms', label: 'Terms, delivery & returns', type: 'textarea', rows: 4, full: true }, sh.terms)}
    </div>`)}
    ${card('Checkout', `<div class="form-grid">
      ${fieldHTML({ name: 'sh_shippingFee', label: 'Shipping fee € (incl. VAT)', type: 'number' }, sh.shippingFee)}
      ${fieldHTML({ name: 'sh_freeShippingOver', label: 'Free shipping over € (0 = never)', type: 'number' }, sh.freeShippingOver)}
      ${fieldHTML({ name: 'sh_payCod', label: 'Cash on delivery', type: 'checkbox', hint: 'Accept cash on delivery' }, sh.payCod !== false)}
      ${fieldHTML({ name: 'sh_codFee', label: 'COD fee € (incl. VAT)', type: 'number' }, sh.codFee)}
      ${fieldHTML({ name: 'sh_payBank', label: 'Bank transfer', type: 'checkbox', hint: 'Accept bank transfer (IBAN from company details)' }, sh.payBank !== false)}
    </div><p class="muted sm">Card payments need a payment provider (e.g. Viva Wallet, Stripe) and are not included.</p>`)
      + card(`Products in the shop (${shopProducts.length})`, table([
        { label: '', render: p => `<input type="checkbox" class="sh-feat" value="${p.id}" ${(sh.featured || []).includes(p.id) ? 'checked' : ''} title="Featured on the home page">` },
        { label: 'Product', render: p => esc(p.name) },
        { label: 'Shop price', cls: 'num', render: p => money(gross(p)) + (p.eshopPrice ? '' : ' <small class="muted">list+VAT</small>') },
        { label: 'Stock', cls: 'num', render: p => p.kind === 'service' ? '—' : num(p.stock) },
      ], shopProducts, { empty: 'No products are marked “Show in e-shop” yet.' }) + `<p class="muted sm">Tick products to feature them on the shop's home page.</p>`)}
    </div>${saveBar('saveShop()')}`;
}
function saveShop() {
  const sh = db.settings.shop = db.settings.shop || {};
  const chk = n => document.getElementById('f_sh_' + n).checked;
  Object.assign(sh, {
    enabled: chk('enabled'), payCod: chk('payCod'), payBank: chk('payBank'),
    accent: val('sh_accent'), title: val('sh_title'), tagline: val('sh_tagline'), heroTitle: val('sh_heroTitle'), heroText: val('sh_heroText'),
    logo: val('sh_logo'), about: val('sh_about'), terms: val('sh_terms'),
    shippingFee: +val('sh_shippingFee') || 0, freeShippingOver: +val('sh_freeShippingOver') || 0, codFee: +val('sh_codFee') || 0,
    featured: [...document.querySelectorAll('.sh-feat:checked')].map(x => x.value),
  });
  saveDB(); toast('Shop saved — changes are live on /shop/');
}

/* ---------- integrations (admin; secrets stay on the server) ---------- */
let INTEG = null;
async function loadIntegrations() {
  const box = document.getElementById('integrations'); if (!box) return;
  try { INTEG = (await api('/api/admin/integrations')).config; } catch (e) { box.innerHTML = `<div class="empty text-bad">${esc(e.message)}</div>`; return; }
  const c = INTEG, f = (name, label, v, extra = {}) => fieldHTML({ name, label, ...extra }, v);
  const modeSel = (name, v, modes) => f(name, 'Mode', v, { type: 'select', options: modes });
  box.innerHTML = `<div class="note">Passwords and keys are stored only on the server (<code>data/config.json</code>) and are shown as ******** here. Leave a masked field unchanged to keep its value.</div>
  ${card('Email (SMTP)', `<div class="form-grid cols-4">
    ${f('smtp_host', 'SMTP server', c.smtp.host, { placeholder: 'smtp.office365.com' })}${f('smtp_port', 'Port', c.smtp.port, { type: 'number' })}
    ${f('smtp_secure', 'TLS', c.smtp.secure, { type: 'checkbox', hint: 'Implicit TLS (port 465). Otherwise STARTTLS is used.' })}
    ${f('smtp_from', 'From address', c.smtp.from, { placeholder: 'info@yourcompany.gr' })}${f('smtp_user', 'Username', c.smtp.user)}${f('smtp_pass', 'Password', c.smtp.pass, { type: 'password' })}
  </div><p class="muted sm">Leave the server empty to record emails without sending them.</p><div class="btn-row"><input id="smtp_test_to" type="email" placeholder="Send a test email to…"><button class="btn" onclick="testEmail()">Send test</button></div>`)}
  ${card('AADE myDATA', `<div class="note warn"><b>B2B e-invoicing mandate:</b> from 1 Oct 2026 all Greek businesses must issue B2B invoices through a licensed e-invoicing provider or AADE's timologio app. This connection uses the myDATA <b>ERP channel</b>, which suits the test environment and retail receipts; confirm with your accountant before using it for B2B invoices in production.</div>
    <div class="form-grid cols-4">
    ${modeSel('md_mode', c.mydata.mode, [['simulate', 'Simulation (no connection)'], ['test', 'Test environment (mydataapidev)'], ['production', 'Production']])}
    ${f('md_user', 'User ID (aade-user-id)', c.mydata.userId)}${f('md_key', 'Subscription key', c.mydata.subscriptionKey, { type: 'password' })}
  </div><p class="muted sm">Test credentials: register at mydata-dev-register.azurewebsites.net. Production credentials: AADE myBusiness → myDATA → register for the REST API.</p>`)}
  ${card('ACS Courier', `<div class="form-grid cols-4">
    ${modeSel('acs_mode', c.couriers.acs.mode, [['simulate', 'Simulation'], ['live', 'Live API']])}
    ${f('acs_apiKey', 'API key (AcsApiKey)', c.couriers.acs.apiKey, { type: 'password' })}${f('acs_companyId', 'Company ID', c.couriers.acs.companyId)}${f('acs_companyPassword', 'Company password', c.couriers.acs.companyPassword, { type: 'password' })}
    ${f('acs_userId', 'User ID', c.couriers.acs.userId)}${f('acs_userPassword', 'User password', c.couriers.acs.userPassword, { type: 'password' })}${f('acs_billingCode', 'Billing code', c.couriers.acs.billingCode)}
    ${f('acs_printType', 'Label format', String(c.couriers.acs.printType || 2), { type: 'select', options: [['2', 'Laser A4'], ['1', 'Thermal']] })}
  </div><p class="muted sm">ACS only registers vouchers after the daily pickup list is issued (Deliveries → “ACS: issue pickup list”).</p>`)}
  ${card('BOX NOW', `<div class="form-grid cols-4">
    ${modeSel('bn_mode', c.couriers.boxnow.mode, [['simulate', 'Simulation'], ['live', 'Live API']])}
    ${f('bn_env', 'Environment', c.couriers.boxnow.env, { type: 'select', options: [['stage', 'Stage (testing)'], ['production', 'Production']] })}
    ${f('bn_clientId', 'Client ID', c.couriers.boxnow.clientId)}${f('bn_clientSecret', 'Client secret', c.couriers.boxnow.clientSecret, { type: 'password' })}
    ${f('bn_origin', 'Origin (warehouse) location ID', c.couriers.boxnow.originLocationId)}${f('bn_name', 'Sender contact name', c.couriers.boxnow.contactName)}
    ${f('bn_email', 'Sender email', c.couriers.boxnow.contactEmail)}${f('bn_phone', 'Sender phone (+30…)', c.couriers.boxnow.contactPhone)}
  </div>`)}
  ${card('Other couriers (ELTA, Geniki, Speedex, own vehicle…)', `<div class="form-grid cols-4">
    ${modeSel('oth_mode', c.couriers.other.mode, [['simulate', 'Simulation'], ['manual', 'Manual — type the tracking number']])}
  </div><p class="muted sm">These couriers have no built-in connection: book the shipment in their own system and enter the tracking number here.</p>`)}
  <div class="page-actions"><span class="spacer"></span><button class="btn primary" onclick="saveIntegrations()">Save integrations</button></div>`;
}
async function saveIntegrations() {
  const v = id => document.getElementById('f_' + id).value.trim();
  const body = {
    smtp: { host: v('smtp_host'), port: +v('smtp_port') || 587, secure: document.getElementById('f_smtp_secure').checked, from: v('smtp_from'), user: v('smtp_user'), pass: v('smtp_pass') },
    mydata: { mode: v('md_mode'), userId: v('md_user'), subscriptionKey: v('md_key') },
    couriers: {
      acs: { mode: v('acs_mode'), apiKey: v('acs_apiKey'), companyId: v('acs_companyId'), companyPassword: v('acs_companyPassword'), userId: v('acs_userId'), userPassword: v('acs_userPassword'), billingCode: v('acs_billingCode'), printType: +v('acs_printType') },
      boxnow: { mode: v('bn_mode'), env: v('bn_env'), clientId: v('bn_clientId'), clientSecret: v('bn_clientSecret'), originLocationId: v('bn_origin'), contactName: v('bn_name'), contactEmail: v('bn_email'), contactPhone: v('bn_phone') },
      other: { mode: v('oth_mode') },
    },
  };
  try { const r = await api('/api/admin/integrations', { method: 'PUT', body }); SYNC.integrations = r.status; toast('Integrations saved'); loadIntegrations(); }
  catch (e) { toast(e.message, 'err'); }
}
async function testEmail() {
  const to = document.getElementById('smtp_test_to').value.trim();
  if (!to) return toast('Enter an address to send the test to', 'err');
  toast('Sending…');
  try { await api('/api/admin/test-email', { method: 'POST', body: { to } }); toast('Test email sent — check the inbox'); }
  catch (e) { toast('Test failed: ' + e.message, 'err'); }
}

/* ---------- users (admin) ---------- */
let USERS = [];
async function loadUsers() {
  const box = document.getElementById('users-admin'); if (!box) return;
  try { USERS = (await api('/api/admin/users')).users; } catch (e) { box.innerHTML = `<div class="empty text-bad">${esc(e.message)}</div>`; return; }
  box.innerHTML = card('Users', table([
    { label: 'Name', render: u => `<b>${esc(u.name)}</b>${u.active ? '' : ' <span class="tag bad">disabled</span>'}${u.mustChange ? ' <span class="tag">must change password</span>' : ''}` },
    { label: 'Email (login)', render: u => esc(u.email) },
    { label: 'Role', render: u => esc(ROLES[u.role]?.label || (u.role === 'customer' ? 'Customer portal' : u.role)) + (u.customerId ? `<br><small>${esc(nameOf('customers', u.customerId))}</small>` : '') },
    { label: 'Last sign-in', render: u => u.lastLogin ? fmtDateTime(u.lastLogin) : '<span class="muted">never</span>' },
    { label: '', render: u => `<button class="btn xs" onclick="editUser('${u.id}')">Edit</button>` },
  ], USERS), `<button class="btn primary" onclick="editUser()">+ New user</button>`);
}
function editUser(id) {
  const u = id ? USERS.find(x => x.id === id) : { role: 'sales', active: true };
  const roleOpts = [...Object.entries(ROLES).map(([k, r]) => [k, r.label]), ['customer', 'Customer (B2B portal login)']];
  openForm({
    title: id ? 'Edit user' : 'New user', values: { ...u, password: '' },
    fields: [
      { name: 'name', label: 'Name', required: true }, { name: 'email', label: 'Email (used to sign in)', type: 'email', required: true },
      { name: 'role', label: 'Role', type: 'select', options: roleOpts },
      { name: 'customerId', label: 'Customer (for portal logins)', type: 'select', options: pairs(db.customers, x => x.name, '— none —') },
      { name: 'password', label: id ? 'New password (leave empty to keep)' : 'Temporary password', type: 'password', help: 'At least 10 characters with letters and numbers. The user must change it at first sign-in.' },
      ...(id ? [{ name: 'active', label: 'Status', type: 'checkbox', hint: 'Can sign in' }] : []),
    ],
    buttons: id && id !== me().id ? [{ label: 'Delete', danger: true, onClick: () => { confirmBox(`Delete ${u.name}?`, () => api('/api/admin/users/' + id, { method: 'DELETE' }).then(() => { toast('User deleted'); loadUsers(); }).catch(e => toast(e.message, 'err')), 'Delete'); } }] : [],
    onSave: d => {
      if (!id && !d.password) return toast('Set a temporary password', 'err');
      const req = id ? api('/api/admin/users/' + id, { method: 'PUT', body: { ...d, password: d.password || undefined } }) : api('/api/admin/users', { method: 'POST', body: d });
      req.then(() => { closeModal(); toast('User saved'); loadUsers(); api('/api/users').then(r => { db.users = r.users.filter(x => x.role !== 'customer'); }); })
        .catch(e => toast(e.message, 'err'));
      return false;
    },
  });
}

/* ---------- data & audit ---------- */
async function loadAudit() {
  const box = document.getElementById('audit'); if (!box) return;
  try {
    const { entries } = await api('/api/admin/audit');
    box.innerHTML = table([
      { label: 'When', render: e => fmtDateTime(e.at) }, { label: 'User', render: e => esc(nameOf('users', e.user_id, e.user_id || 'system')) },
      { label: 'Action', render: e => esc(e.action) }, { label: 'Details', render: e => `<small class="mono">${esc(String(e.detail).slice(0, 160))}</small>` },
    ], entries, { empty: 'No entries yet.' });
  } catch (e) { box.innerHTML = `<div class="empty text-bad">${esc(e.message)}</div>`; }
}
function exportData() {
  const out = { exportedAt: new Date().toISOString(), settings: db.settings, counters: db.counters };
  for (const c of SYNC_COLS) out[c] = db[c];
  downloadFile(`bizorganiser-backup-${today()}.json`, JSON.stringify(out, null, 1), 'application/json');
}
async function adminAction(url, msg) {
  try { await syncNow(); await api(url, { method: 'POST', body: {} }); toast(msg); setTimeout(() => location.reload(), 600); }
  catch (e) { toast(e.message, 'err'); }
}
function importData(input) {
  const f = input.files[0]; if (!f) return;
  const r = new FileReader();
  r.onload = () => {
    let data;
    try { data = JSON.parse(r.result); } catch { return toast('This file is not valid JSON', 'err'); }
    confirmBox(`Replace ALL business data with this backup (${(data.customers || []).length} customers, ${(data.invoices || []).length} invoices)?`, async () => {
      try { await api('/api/admin/import', { method: 'POST', body: data }); toast('Backup imported'); setTimeout(() => location.reload(), 600); }
      catch (e) { toast('Import failed: ' + e.message, 'err'); }
    }, 'Import');
  };
  r.readAsText(f);
}
