'use strict';
/* =========================================================================
   CRM: dashboard, customers, activities / calendar, email outbox
   ========================================================================= */

const ACT_TYPES = [['call', 'Phone call'], ['meeting', 'Meeting'], ['email', 'Email'], ['task', 'Task']];
const actIcon = t => ({ call: '☎', meeting: '👥', email: '✉', task: '✓' }[t] || '•');

/* ---------- dashboard ---------- */
page('dashboard', {
  title: 'Dashboard',
  render() {
    const t = today(), mStart = t.slice(0, 8) + '01';
    const revenue = sum(db.invoices.filter(i => i.date >= mStart && !i.cancelled), invNet);
    const openQuotes = db.quotes.filter(q => ['draft', 'sent'].includes(q.status));
    const wip = db.workOrders.filter(w => w.status !== 'done');
    const receivable = sum(db.invoices.filter(i => !i.cancelled), balanceOf);
    const overdue = db.invoices.filter(i => invStatus(i) === 'overdue');
    const low = db.products.filter(p => p.kind !== 'service' && p.stock <= p.minStock);
    const pendingB2B = db.orders.filter(o => o.source === 'b2b' && ['pending', 'new'].includes(o.status));
    const agenda = db.activities.filter(a => !a.done && a.date <= addDays(t, 7)).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
    const months = lastMonths(6).map(m => ({ label: m.label, value: sum(db.invoices.filter(i => i.date.startsWith(m.key) && !i.cancelled), invNet) }));
    const recent = [...db.orders].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 6);
    const dueWO = wip.sort((a, b) => a.dueDate.localeCompare(b.dueDate)).slice(0, 5);

    return `
    <div class="kpis">
      ${kpi('Revenue this month', money(revenue), 'net, invoiced', can('reports') ? '#/reports' : '')}
      ${kpi('Open quotes', openQuotes.length, money(sum(openQuotes, q => q.net)) + ' pipeline', can('quotes') ? '#/quotes' : '')}
      ${kpi('Jobs in production', wip.length, `${wip.filter(w => w.dueDate < t).length} past due`, can('production') ? '#/production' : '')}
      ${kpi('Receivables', money(receivable), `${overdue.length} overdue invoices`, can('invoices') ? '#/invoices' : '')}
      ${kpi('Low stock', low.length, 'items at/below minimum', can('products') ? '#/products' : '')}
      ${kpi('New B2B orders', pendingB2B.length, 'from the portal', can('orders') ? '#/orders' : '')}
    </div>
    <div class="grid-2">
      ${card('Agenda — next 7 days', agenda.length ? `<ul class="agenda">${agenda.map(a => activityItem(a)).join('')}</ul>` : `<div class="empty">No open reminders. 🎉</div>`,
        `<button class="btn sm" onclick="editActivity()">+ Reminder</button>`)}
      ${card('Invoiced sales — last 6 months', barChart(months))}
    </div>
    <div class="grid-2">
      ${card('Recent orders', table([
        { label: 'Order', render: o => `<b>${esc(o.number)}</b>` },
        { label: 'Customer', render: o => esc(nameOf('customers', o.customerId)) },
        { label: 'Date', render: o => fmtDate(o.date) },
        { label: 'Total', cls: 'num', render: o => money(o.total) },
        { label: 'Status', render: o => badge(o.status) + (o.source === 'b2b' ? ' <span class="tag">B2B</span>' : '') },
      ], recent, { href: o => `edit/order/${o.id}` }))}
      ${card('Production — next due', table([
        { label: 'Job', render: w => `<b>${esc(w.number)}</b>` },
        { label: 'Customer', render: w => esc(nameOf('customers', w.customerId)) },
        { label: 'Due', render: w => `<span class="${w.dueDate < t ? 'text-bad' : ''}">${fmtDate(w.dueDate)}</span>` },
        { label: 'Progress', render: w => progress(w) },
      ], dueWO, { href: () => 'production', empty: 'Nothing in production.' }))}
    </div>`;
  },
});

function activityItem(a, showCustomer = true) {
  const t = today();
  const cls = a.done ? 'done' : a.date < t ? 'overdue' : a.date === t ? 'today' : '';
  return `<li class="act ${cls}">
    <input type="checkbox" ${a.done ? 'checked' : ''} onchange="toggleActivity('${a.id}')" title="Mark done">
    <span class="act-ico">${actIcon(a.type)}</span>
    <div class="act-main" onclick="editActivity('${a.id}')">
      <div>${esc(a.title)}</div>
      <small>${fmtDate(a.date)} ${esc(a.time || '')}${showCustomer && a.customerId ? ' · ' + esc(nameOf('customers', a.customerId)) : ''}${a.date < t && !a.done ? ' · <b>overdue</b>' : ''}</small>
    </div></li>`;
}
function toggleActivity(id) {
  const a = byId('activities', id); a.done = !a.done; saveDB(); rerender();
}
function editActivity(id, preset = {}) {
  const a = id ? byId('activities', id) : { type: 'call', date: today(), time: '10:00', userId: me().id, ...preset };
  openForm({
    title: id ? 'Edit reminder / activity' : 'New reminder / activity',
    fields: [
      { name: 'title', label: 'Title', required: true, full: true },
      { name: 'type', label: 'Type', type: 'select', options: ACT_TYPES },
      { name: 'customerId', label: 'Customer', type: 'select', options: pairs(db.customers, x => x.name, '— none —') },
      { name: 'date', label: 'Date', type: 'date', required: true },
      { name: 'time', label: 'Time', type: 'time' },
      { name: 'userId', label: 'Assigned to', type: 'select', options: pairs(db.users) },
      { name: 'done', label: 'Status', type: 'checkbox', hint: 'Completed' },
      { name: 'notes', label: 'Notes', type: 'textarea', full: true },
    ],
    values: a,
    buttons: id ? [{ label: 'Delete', danger: true, onClick: () => { db.activities = db.activities.filter(x => x.id !== id); saveDB(); rerender(); } }] : [],
    onSave: data => {
      if (id) Object.assign(a, data); else db.activities.push({ id: uid(), ...a, ...data });
      saveDB(); rerender(); toast('Saved');
    },
  });
}
const progress = w => {
  const n = w.steps.length, d = w.steps.filter(s => s.done).length;
  return `<div class="progress" title="${d}/${n} steps"><span style="width:${n ? d / n * 100 : 0}%"></span></div>`;
};

/* ---------- customers ---------- */
function customerStats(cid) {
  const inv = db.invoices.filter(i => i.customerId === cid && !i.cancelled);
  return { sales: sum(inv, invNet), balance: sum(inv, balanceOf), orders: db.orders.filter(o => o.customerId === cid).length, last: inv.map(i => i.date).sort().pop() };
}
page('customers', {
  title: 'Customers',
  render() {
    return card(`Customers (${db.customers.length})`, table([
      { label: 'Name', render: c => `<b>${esc(c.name)}</b><br><small>${esc(c.email)}</small>` },
      { label: 'VAT no.', render: c => esc(c.vat) || '<span class="text-bad">missing</span>' },
      { label: 'City / region', render: c => `${esc(c.city)}<br><small>${esc(c.region)}</small>` },
      { label: 'Group', render: c => esc(c.group) },
      { label: 'Sales rep', render: c => esc(nameOf('reps', c.repId)) },
      { label: 'Price list', render: c => esc(nameOf('priceLists', c.priceListId, 'Standard')) },
      { label: 'Sales (net)', cls: 'num', render: c => money(customerStats(c.id).sales) },
      { label: 'Open balance', cls: 'num', render: c => { const b = customerStats(c.id).balance; return `<span class="${b > 0 ? 'text-warn' : ''}">${money(b)}</span>`; } },
    ], db.customers, { href: c => `customer/${c.id}`, id: 'tbl-cust' }),
      `${searchBox('tbl-cust')} <button class="btn primary" onclick="editCustomer()">+ New customer</button>`);
  },
});
function customerFields() {
  return [
    { name: 'name', label: 'Company / name', required: true, full: true },
    { name: 'vat', label: 'VAT number (ΑΦΜ)', help: 'Required for B2B invoices sent to myDATA' },
    { name: 'email', label: 'Email', type: 'email' },
    { name: 'phone', label: 'Phone' },
    { name: 'address', label: 'Address' },
    { name: 'city', label: 'City' },
    { name: 'postalCode', label: 'Postal code', help: 'Used for myDATA and courier vouchers' },
    { name: 'region', label: 'Region', type: 'select', options: db.settings.regions.map(r => [r, r]) },
    { name: 'group', label: 'Customer group', type: 'select', options: db.settings.groups.map(r => [r, r]) },
    { name: 'repId', label: 'Sales rep', type: 'select', options: pairs(db.reps, x => x.name, '— none —') },
    { name: 'priceListId', label: 'B2B price list', type: 'select', options: pairs(db.priceLists, x => x.name, 'Standard prices') },
    { name: 'paymentTerms', label: 'Payment terms (days)', type: 'number', default: 30 },
    { name: 'notes', label: 'Notes', type: 'textarea', full: true },
  ];
}
function editCustomer(id) {
  const c = id ? byId('customers', id) : {};
  openForm({
    title: id ? 'Edit customer' : 'New customer', fields: customerFields(), values: c, wide: true,
    onSave: data => {
      if (id) Object.assign(c, data);
      else { const n = { id: uid(), createdAt: today(), ...data }; db.customers.push(n); setTimeout(() => go('customer/' + n.id)); }
      saveDB(); rerender(); toast('Customer saved');
    },
  });
}
function deleteCustomer(id) {
  const used = ['quotes', 'orders', 'invoices'].some(col => db[col].some(x => x.customerId === id));
  if (used) return toast('This customer has documents and cannot be deleted', 'err');
  confirmBox('Delete this customer?', () => { db.customers = db.customers.filter(c => c.id !== id); db.activities = db.activities.filter(a => a.customerId !== id); saveDB(); go('customers'); }, 'Delete');
}
page('customer', {
  nav: 'customers', title: id => nameOf('customers', id, 'Customer'),
  render(id) {
    const c = byId('customers', id); if (!c) return notFound();
    const st = customerStats(id);
    const quotes = db.quotes.filter(q => q.customerId === id).sort((a, b) => b.date.localeCompare(a.date));
    const orders = db.orders.filter(o => o.customerId === id).sort((a, b) => b.date.localeCompare(a.date));
    const invs = db.invoices.filter(i => i.customerId === id).sort((a, b) => b.date.localeCompare(a.date));
    const acts = db.activities.filter(a => a.customerId === id).sort((a, b) => b.date.localeCompare(a.date));
    const mails = db.emails.filter(e => e.customerId === id);
    const prodMix = [...groupBy(orders.filter(o => o.status !== 'cancelled').flatMap(o => o.lines), l => l.productId || l.desc)]
      .map(([k, ls]) => ({ label: byId('products', k)?.name || k, value: sum(ls, lineNet) })).sort((a, b) => b.value - a.value).slice(0, 6);
    return `
    <div class="page-actions">
      <a href="#/customers" class="btn">← Customers</a>
      <span class="spacer"></span>
      ${can('quotes') ? `<button class="btn" onclick="createDraft('quote',{customerId:'${id}'})">+ Quote</button>` : ''}
      ${can('orders') ? `<button class="btn" onclick="createDraft('order',{customerId:'${id}'})">+ Order</button>` : ''}
      <button class="btn" onclick="editActivity(null,{customerId:'${id}'})">+ Activity</button>
      <button class="btn" onclick="composeEmail('${id}')">✉ Email</button>
      <button class="btn" onclick="editCustomer('${id}')">Edit</button>
      <button class="btn danger" onclick="deleteCustomer('${id}')">Delete</button>
    </div>
    <div class="kpis">
      ${kpi('Total sales (net)', money(st.sales))}
      ${kpi('Open balance', money(st.balance))}
      ${kpi('Orders', st.orders)}
      ${kpi('Last invoice', fmtDate(st.last))}
    </div>
    <div class="grid-2">
      ${card('Details', `<dl class="dl">
        <dt>VAT</dt><dd>${esc(c.vat) || '<span class="text-bad">missing</span>'}</dd>
        <dt>Email</dt><dd>${esc(c.email)}</dd><dt>Phone</dt><dd>${esc(c.phone)}</dd>
        <dt>Address</dt><dd>${esc(c.address)}, ${esc(c.city)} (${esc(c.region)})</dd>
        <dt>Group</dt><dd>${esc(c.group)}</dd><dt>Sales rep</dt><dd>${esc(nameOf('reps', c.repId))}</dd>
        <dt>Price list</dt><dd>${esc(nameOf('priceLists', c.priceListId, 'Standard'))}</dd>
        <dt>Payment terms</dt><dd>${c.paymentTerms ? c.paymentTerms + ' days' : 'Immediate'}</dd>
        <dt>Customer since</dt><dd>${fmtDate(c.createdAt)}</dd>
        ${c.notes ? `<dt>Notes</dt><dd>${esc(c.notes)}</dd>` : ''}</dl>`)}
      ${card('Activities & reminders', acts.length ? `<ul class="agenda">${acts.map(a => activityItem(a, false)).join('')}</ul>` : '<div class="empty">No activities yet.</div>')}
    </div>
    ${card('Orders — history & repeat', table([
      { label: 'Order', render: o => `<b>${esc(o.number)}</b>` },
      { label: 'Date', render: o => fmtDate(o.date) },
      { label: 'Items', render: o => esc(o.lines.map(l => `${l.qty}× ${l.desc}`).join(', ')) },
      { label: 'Total', cls: 'num', render: o => money(o.total) },
      { label: 'Status', render: o => badge(o.status) },
      { label: '', render: o => can('orders') ? `<button class="btn sm" onclick="reorder('${o.id}')">↻ Reorder</button>` : '' },
    ], orders, { href: o => `edit/order/${o.id}`, empty: 'No orders yet.' }))}
    <div class="grid-2">
      ${card('Quotes', table([
        { label: 'Quote', render: q => `<b>${esc(q.number)}</b>` },
        { label: 'Date', render: q => fmtDate(q.date) },
        { label: 'Total', cls: 'num', render: q => money(q.total) },
        { label: 'Status', render: q => badge(q.status) },
      ], quotes, { href: q => `edit/quote/${q.id}`, empty: 'No quotes yet.' }))}
      ${card('Invoices', table([
        { label: 'Invoice', render: i => `<b>${esc(i.number)}</b>` },
        { label: 'Date', render: i => fmtDate(i.date) },
        { label: 'Total', cls: 'num', render: i => money(i.total) },
        { label: 'Status', render: i => badge(invStatus(i)) },
      ], invs, { href: i => `invoice/${i.id}`, empty: 'No invoices yet.' }))}
    </div>
    <div class="grid-2">
      ${card('What they buy', hbars(prodMix))}
      ${card('Emails', table([
        { label: 'Date', render: e => fmtDateTime(e.date) },
        { label: 'Subject', render: e => esc(e.subject) + (e.auto ? ' <span class="tag">auto</span>' : '') },
      ], mails, { href: e => `outbox/${e.id}`, empty: 'No emails yet.' }))}
    </div>`;
  },
});
function reorder(orderId) {
  const o = byId('orders', orderId); const cust = byId('customers', o.customerId);
  const lines = o.lines.map(l => { const p = byId('products', l.productId); return { ...clone(l), price: p ? priceFor(cust, p) : l.price, unitCost: p ? p.cost : l.unitCost }; });
  createDraft('order', { customerId: o.customerId, lines, notes: `Repeat of ${o.number}` });
  toast('Order copied with current prices — review and save');
}

/* ---------- calendar ---------- */
page('calendar', {
  title: 'Calendar',
  render(month) {
    month = month || today().slice(0, 7);
    const first = parseD(month + '-01');
    const startOffset = (first.getDay() + 6) % 7; // Monday first
    const start = addDays(month + '-01', -startOffset);
    const prev = isoOf(new Date(first.getFullYear(), first.getMonth() - 1, 1)).slice(0, 7);
    const next = isoOf(new Date(first.getFullYear(), first.getMonth() + 1, 1)).slice(0, 7);
    const events = {};
    const push = (date, html) => { (events[date] = events[date] || []).push(html); };
    db.activities.forEach(a => push(a.date, `<div class="ev ev-${a.type} ${a.done ? 'done' : ''}" onclick="event.stopPropagation();editActivity('${a.id}')" title="${esc(a.title)}">${actIcon(a.type)} ${esc(a.time || '')} ${esc(a.title)}</div>`));
    db.orders.filter(o => !['delivered', 'cancelled'].includes(o.status)).forEach(o => push(o.dueDate, `<a class="ev ev-order" href="#/edit/order/${o.id}" onclick="event.stopPropagation()" title="Order due">⏱ ${esc(o.number)} due</a>`));
    db.quotes.filter(q => q.status === 'sent').forEach(q => push(q.validUntil, `<a class="ev ev-quote" href="#/edit/quote/${q.id}" onclick="event.stopPropagation()">✎ ${esc(q.number)} expires</a>`));
    db.purchaseOrders.filter(p => p.status === 'sent').forEach(p => push(p.expectedDate, `<a class="ev ev-po" href="#/edit/po/${p.id}" onclick="event.stopPropagation()">📦 ${esc(p.number)} arrives</a>`));
    const t = today();
    let cells = '';
    for (let i = 0; i < 42; i++) {
      const d = addDays(start, i);
      cells += `<div class="cal-cell ${d.slice(0, 7) !== month ? 'other' : ''} ${d === t ? 'today' : ''}" onclick="editActivity(null,{date:'${d}'})">
        <div class="cal-day">${parseD(d).getDate()}</div>${(events[d] || []).join('')}</div>`;
    }
    return card(first.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }), `
      <div class="cal-head">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(x => `<div>${x}</div>`).join('')}</div>
      <div class="cal-grid">${cells}</div>
      <p class="muted sm">Click a day to add a reminder. Shows activities, order due dates, quote expiries and expected supplier deliveries.</p>`,
      `<a class="btn sm" href="#/calendar/${prev}">‹</a><a class="btn sm" href="#/calendar">Today</a><a class="btn sm" href="#/calendar/${next}">›</a>
       <button class="btn sm primary" onclick="editActivity()">+ Reminder</button>`);
  },
});

/* ---------- email outbox ---------- */
page('outbox', {
  title: 'Email outbox',
  render(id) {
    if (id) setTimeout(() => viewEmail(id));
    const live = SYNC.integrations.email === 'live';
    return `<div class="note ${live ? '' : 'warn'}">${live ? 'Emails are sent through your SMTP server.' : '<b>Email sending is not configured</b>, so emails are recorded here but not delivered.'} Automatic emails and templates are configured in <a href="#/settings/email">Settings → Email</a>${me().role === 'admin' ? ', the mail server in <a href="#/settings/integrations">Settings → Integrations</a>' : ''}.</div>` +
      card(`Emails (${db.emails.length})`, table([
        { label: 'Date', render: e => fmtDateTime(e.date) },
        { label: 'To', render: e => esc(e.to) },
        { label: 'Subject', render: e => `${esc(e.subject)} ${e.auto ? '<span class="tag">auto</span>' : ''}` },
        { label: 'Related', render: e => esc(e.ref || '') },
        { label: 'Status', render: e => `${e.status ? badge(e.status) : ''}${e.status === 'failed' || (e.status === 'simulated' && live) ? ` <button class="btn xs" onclick="retryEmail('${e.id}')">Resend</button>` : ''}` },
      ], db.emails, { href: e => `outbox/${e.id}`, id: 'tbl-mail', empty: 'No emails yet. Send a quote or invoice to see automated emails here.' }),
        `${searchBox('tbl-mail')} <button class="btn primary" onclick="composeEmail()">✉ Compose</button>`);
  },
});
function viewEmail(id) {
  const e = byId('emails', id); if (!e) return;
  openModal(e.subject, `<dl class="dl"><dt>From</dt><dd>${esc(e.from)}</dd><dt>To</dt><dd>${esc(e.to)}</dd><dt>Date</dt><dd>${fmtDateTime(e.date)}</dd>${e.ref ? `<dt>Related</dt><dd>${esc(e.ref)}</dd>` : ''}
    <dt>Status</dt><dd>${e.status ? badge(e.status) : '—'} ${e.sentAt ? fmtDateTime(e.sentAt) : ''}${e.error ? `<br><span class="text-bad">${esc(e.error)}</span>` : ''}</dd></dl><pre class="mail-body">${esc(e.body)}</pre>`,
    [{ label: 'Close' }], { onClose: () => { if (location.hash.startsWith('#/outbox/')) history.replaceState(null, '', '#/outbox'); } });
}
async function retryEmail(id) {
  try { await api('/api/email/retry', { method: 'POST', body: { id } }); toast('Email queued again'); setTimeout(pollChanges, 1500); }
  catch (e) { toast(e.message, 'err'); }
}
function composeEmail(customerId = '', preset = {}) {
  const c = byId('customers', customerId);
  const tplOpts = [['', '— blank —'], ...Object.entries(db.settings.templates).map(([k, t]) => [k, t.name])];
  openForm({
    title: 'Compose email', wide: true,
    fields: [
      { name: 'customerId', label: 'Customer', type: 'select', options: pairs(db.customers, x => x.name, '— other recipient —') },
      { name: 'to', label: 'To', type: 'email', required: true },
      { name: 'tpl', label: 'Template', type: 'select', options: tplOpts },
      { name: 'subject', label: 'Subject', required: true, full: true },
      { name: 'body', label: 'Message', type: 'textarea', rows: 9, full: true },
    ],
    values: { customerId, to: c?.email || '', ...preset },
    saveLabel: 'Send',
    onSave: d => {
      const cust = byId('customers', d.customerId);
      logEmail({ to: d.to, subject: d.subject, body: d.body, customerId: d.customerId || undefined, ref: preset.ref });
      if (cust) db.activities.push({ id: uid(), type: 'email', customerId: cust.id, title: 'Email: ' + d.subject, date: today(), time: new Date().toTimeString().slice(0, 5), done: true, userId: me().id, notes: '' });
      saveDB(); rerender(); toast('Email queued for sending');
    },
  });
  const sel = document.getElementById('f_customerId'), tpl = document.getElementById('f_tpl');
  sel.onchange = () => { document.getElementById('f_to').value = byId('customers', sel.value)?.email || ''; };
  tpl.onchange = () => {
    const t = db.settings.templates[tpl.value]; if (!t) return;
    const vars = { company: db.settings.company.name, customer: byId('customers', sel.value)?.name || '' };
    document.getElementById('f_subject').value = fillTpl(t.subject, vars);
    document.getElementById('f_body').value = fillTpl(t.body, vars);
  };
}
