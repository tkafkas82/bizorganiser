'use strict';
/* =========================================================================
   Dashboard, clients, calendar & activities, email outbox
   ========================================================================= */

const ACT_TYPES = [['meeting', 'Meeting'], ['site', 'Site visit'], ['call', 'Phone call'], ['email', 'Email'], ['task', 'Reminder']];
const actIcon = t => ({ call: '☎', meeting: '👥', email: '✉', task: '✓', site: '📐' }[t] || '•');

/* ---------- dashboard ---------- */
function upcomingDeadlines(days = 21) {
  const t = today(), until = addDays(t, days), out = [];
  for (const p of db.projects.filter(x => x.status === 'active')) {
    for (const ph of p.phases || []) if (ph.status !== 'done' && ph.dueDate && ph.dueDate <= until) out.push({ date: ph.dueDate, kind: 'Phase', text: `${ph.name}`, project: p });
    for (const ins of p.installments || []) if (installmentDue(p, ins)) out.push({ date: ins.dueDate || t, kind: 'Payment due', text: `${ins.label} — ${money(installmentAmount(p, ins))}`, project: p, invoiceable: true });
  }
  for (const k of db.tasks.filter(x => x.status !== 'done' && x.dueDate && x.dueDate <= until)) out.push({ date: k.dueDate, kind: 'Task', text: k.title, project: byId('projects', k.projectId), taskId: k.id });
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
page('dashboard', {
  title: 'Dashboard',
  render() {
    const t = today(), mStart = t.slice(0, 8) + '01';
    const weekStart = addDays(t, -((parseD(t).getDay() + 6) % 7));
    const active = db.projects.filter(p => p.status === 'active');
    const openProps = db.quotes.filter(q => ['draft', 'sent'].includes(q.status));
    const revenue = sum(db.invoices.filter(i => i.date >= mStart && !i.cancelled), invNet);
    const receivable = sum(db.invoices.filter(i => !i.cancelled), balanceOf);
    const myHours = sum(db.timeEntries.filter(e => e.userId === me().id && e.date >= weekStart), e => e.hours);
    const toInvoice = active.flatMap(p => (p.installments || []).filter(i => installmentDue(p, i)).map(i => installmentAmount(p, i)));
    const deadlines = upcomingDeadlines();
    const myTasks = db.tasks.filter(k => k.assigneeId === me().id && k.status !== 'done').sort((a, b) => (a.dueDate || '9').localeCompare(b.dueDate || '9')).slice(0, 8);
    const agenda = db.activities.filter(a => !a.done && a.date <= addDays(t, 7)).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
    const months = lastMonths(6).map(m => ({ label: m.label, value: sum(db.invoices.filter(i => i.date.startsWith(m.key) && !i.cancelled), invNet) }));
    return `
    <div class="kpis">
      ${kpi('Active projects', active.length, `${db.projects.filter(p => p.status === 'on_hold').length} on hold`, can('projects') ? '#/projects' : '')}
      ${kpi('Open fee proposals', openProps.length, money(sum(openProps, q => q.net)) + ' net', can('quotes') ? '#/quotes' : '')}
      ${can('invoices') ? kpi('Ready to invoice', money(sum(toInvoice, x => x)), `${toInvoice.length} installments due`, '#/invoices') : ''}
      ${can('invoices') ? kpi('Invoiced this month', money(revenue), 'net fees', '#/reports') : ''}
      ${can('invoices') ? kpi('Receivables', money(receivable), 'open balance', '#/invoices') : ''}
      ${kpi('My hours this week', num(myHours, 1), '', '#/timesheets')}
    </div>
    <div class="grid-2">
      ${card('Deadlines — next 3 weeks', deadlines.length ? table([
        { label: 'Date', render: x => `<span class="${x.date < t ? 'text-bad' : x.date === t ? 'text-warn' : ''}">${fmtDate(x.date)}</span>` },
        { label: 'What', render: x => `<span class="tag">${esc(x.kind)}</span> ${esc(x.text)}` },
        { label: 'Project', render: x => x.project ? `<a href="#/project/${x.project.id}">${esc(x.project.name)}</a>` : '' },
      ], deadlines.slice(0, 12)) : '<div class="empty">Nothing due. 🎉</div>')}
      ${card('Agenda — next 7 days', agenda.length ? `<ul class="agenda">${agenda.map(a => activityItem(a)).join('')}</ul>` : '<div class="empty">No appointments.</div>', `<button class="btn sm" onclick="editActivity()">+ Appointment</button>`)}
    </div>
    <div class="grid-2">
      ${card('My tasks', table([
        { label: 'Task', render: k => `<b>${esc(k.title)}</b>${k.priority === 'high' ? ' <span class="tag bad">urgent</span>' : ''}<br><small>${esc(byId('projects', k.projectId)?.name || '')}</small>` },
        { label: 'Due', render: k => k.dueDate ? `<span class="${k.dueDate < t ? 'text-bad' : ''}">${fmtDate(k.dueDate)}</span>` : '—' },
        { label: 'Status', render: k => badge(k.status) },
      ], myTasks, { href: () => 'tasks', empty: 'No open tasks assigned to you.' }))}
      ${can('invoices') ? card('Fees invoiced — last 6 months', barChart(months)) : card('Projects by phase', projectsByPhase())}
    </div>`;
  },
});
function projectsByPhase() {
  const rows = [...groupBy(db.projects.filter(p => p.status === 'active'), p => currentPhase(p)?.name || '—')].map(([k, ps]) => ({ label: k, value: ps.length }));
  return hbars(rows, { fmt: v => num(v) });
}

/* ---------- activities (calendar entries) ---------- */
function activityItem(a, showClient = true) {
  const t = today();
  const cls = a.done ? 'done' : a.date < t ? 'overdue' : a.date === t ? 'today' : '';
  const p = byId('projects', a.projectId);
  return `<li class="act ${cls}">
    <input type="checkbox" ${a.done ? 'checked' : ''} onchange="toggleActivity('${a.id}')" title="Mark done">
    <span class="act-ico">${actIcon(a.type)}</span>
    <div class="act-main" onclick="editActivity('${a.id}')">
      <div>${esc(a.title)}</div>
      <small>${fmtDate(a.date)} ${esc(a.time || '')}${showClient && a.customerId ? ' · ' + esc(nameOf('customers', a.customerId)) : ''}${p ? ' · ' + esc(p.name) : ''}${a.date < t && !a.done ? ' · <b>overdue</b>' : ''}</small>
    </div></li>`;
}
function toggleActivity(id) { const a = byId('activities', id); a.done = !a.done; saveDB(); rerender(); }
function editActivity(id, preset = {}) {
  const a = id ? byId('activities', id) : { type: 'meeting', date: today(), time: '10:00', userId: me().id, ...preset };
  openForm({
    title: id ? 'Edit appointment / reminder' : 'New appointment / reminder',
    fields: [
      { name: 'title', label: 'Title', required: true, full: true },
      { name: 'type', label: 'Type', type: 'select', options: ACT_TYPES },
      { name: 'date', label: 'Date', type: 'date', required: true },
      { name: 'time', label: 'Time', type: 'time' },
      { name: 'userId', label: 'Who', type: 'select', options: pairs(db.users) },
      { name: 'customerId', label: 'Client', type: 'select', options: pairs(db.customers, x => x.name, '— none —') },
      { name: 'projectId', label: 'Project', type: 'select', options: pairs(db.projects, projectLabel, '— none —') },
      { name: 'done', label: 'Status', type: 'checkbox', hint: 'Done' },
      { name: 'notes', label: 'Notes', type: 'textarea', full: true },
    ],
    values: a,
    buttons: id ? [{ label: 'Delete', danger: true, onClick: () => { db.activities = db.activities.filter(x => x.id !== id); saveDB(); rerender(); } }] : [],
    onSave: data => {
      if (data.projectId && !data.customerId) data.customerId = byId('projects', data.projectId)?.customerId || '';
      if (id) Object.assign(a, data); else db.activities.push({ id: uid(), ...a, ...data });
      saveDB(); rerender(); toast('Saved');
    },
  });
}

/* ---------- clients ---------- */
function clientStats(cid) {
  const inv = db.invoices.filter(i => i.customerId === cid && !i.cancelled);
  return { fees: sum(inv, invNet), balance: sum(inv, balanceOf), projects: db.projects.filter(p => p.customerId === cid).length };
}
page('customers', {
  title: 'Clients',
  render() {
    return card(`Clients (${db.customers.length})`, table([
      { label: 'Name', render: c => `<b>${esc(c.name)}</b><br><small>${esc(c.email || '')}</small>` },
      { label: 'Type', render: c => esc(c.type || '') },
      { label: 'VAT no.', render: c => esc(c.vat || '—') },
      { label: 'City', render: c => esc(c.city || '') },
      { label: 'Projects', cls: 'num', render: c => clientStats(c.id).projects },
      ...(can('invoices') ? [{ label: 'Fees invoiced', cls: 'num', render: c => money(clientStats(c.id).fees) }, { label: 'Open balance', cls: 'num', render: c => { const b = clientStats(c.id).balance; return `<span class="${b > 0 ? 'text-warn' : ''}">${money(b)}</span>`; } }] : []),
    ], db.customers, { href: c => `customer/${c.id}`, id: 'tbl-cust' }),
      `${searchBox('tbl-cust')} <button class="btn primary" onclick="editCustomer()">+ New client</button>`);
  },
});
function customerFields() {
  return [
    { name: 'name', label: 'Name / company', required: true, full: true },
    { name: 'type', label: 'Client type', type: 'select', options: db.settings.clientTypes.map(x => [x, x]), help: 'Companies get service invoices with 20% withholding; individuals get service receipts' },
    { name: 'vat', label: 'VAT number (ΑΦΜ)' },
    { name: 'taxOffice', label: 'Tax office (ΔΟΥ)' },
    { name: 'email', label: 'Email', type: 'email' },
    { name: 'phone', label: 'Phone' },
    { name: 'address', label: 'Address' },
    { name: 'city', label: 'City' },
    { name: 'postalCode', label: 'Postal code' },
    { name: 'notes', label: 'Notes', type: 'textarea', full: true },
  ];
}
function editCustomer(id, after) {
  const c = id ? byId('customers', id) : { type: 'Individual' };
  openForm({
    title: id ? 'Edit client' : 'New client', fields: customerFields(), values: c, wide: true,
    onSave: data => {
      if (id) Object.assign(c, data);
      else { const n = { id: uid(), createdAt: today(), ...data }; db.customers.push(n); if (after) setTimeout(() => after(n)); else setTimeout(() => go('customer/' + n.id)); }
      saveDB(); rerender(); toast('Client saved');
    },
  });
}
function deleteCustomer(id) {
  if (['quotes', 'projects', 'invoices'].some(col => db[col].some(x => x.customerId === id))) return toast('This client has proposals, projects or invoices and cannot be deleted', 'err');
  confirmBox('Delete this client?', () => { db.customers = db.customers.filter(c => c.id !== id); db.activities = db.activities.filter(a => a.customerId !== id); saveDB(); go('customers'); }, 'Delete');
}
page('customer', {
  nav: 'customers', title: id => nameOf('customers', id, 'Client'),
  render(id) {
    const c = byId('customers', id); if (!c) return notFound();
    const st = clientStats(id);
    const projects = db.projects.filter(p => p.customerId === id);
    const quotes = db.quotes.filter(q => q.customerId === id).sort((a, b) => b.date.localeCompare(a.date));
    const invs = db.invoices.filter(i => i.customerId === id).sort((a, b) => b.date.localeCompare(a.date));
    const acts = db.activities.filter(a => a.customerId === id).sort((a, b) => b.date.localeCompare(a.date));
    const mails = db.emails.filter(e => e.customerId === id);
    return `
    <div class="page-actions">
      <a href="#/customers" class="btn">← Clients</a><span class="spacer"></span>
      ${can('quotes') ? `<button class="btn" onclick="newProposal({customerId:'${id}'})">+ Fee proposal</button>` : ''}
      ${can('projects') ? `<button class="btn" onclick="editProject(null,{customerId:'${id}'})">+ Project</button>` : ''}
      <button class="btn" onclick="editActivity(null,{customerId:'${id}'})">+ Appointment</button>
      <button class="btn" onclick="composeEmail('${id}')">✉ Email</button>
      <button class="btn" onclick="editCustomer('${id}')">Edit</button>
      <button class="btn danger" onclick="deleteCustomer('${id}')">Delete</button>
    </div>
    <div class="kpis">${kpi('Projects', st.projects)}${can('invoices') ? kpi('Fees invoiced (net)', money(st.fees)) + kpi('Open balance', money(st.balance)) : ''}</div>
    <div class="grid-2">
      ${card('Details', `<dl class="dl">
        <dt>Type</dt><dd>${esc(c.type || '')}</dd><dt>VAT / tax office</dt><dd>${esc(c.vat || '—')} ${c.taxOffice ? '· ' + esc(c.taxOffice) : ''}</dd>
        <dt>Email</dt><dd>${esc(c.email || '')}</dd><dt>Phone</dt><dd>${esc(c.phone || '')}</dd>
        <dt>Address</dt><dd>${esc(c.address || '')}, ${esc(c.postalCode || '')} ${esc(c.city || '')}</dd>
        <dt>Client since</dt><dd>${fmtDate(c.createdAt)}</dd>${c.notes ? `<dt>Notes</dt><dd>${esc(c.notes)}</dd>` : ''}</dl>`)}
      ${card('Appointments & reminders', acts.length ? `<ul class="agenda">${acts.map(a => activityItem(a, false)).join('')}</ul>` : '<div class="empty">None yet.</div>')}
    </div>
    ${card('Projects', table([
      { label: 'Project', render: p => `<b>${esc(p.name)}</b><br><small>${esc(p.number)} · ${esc(p.type || '')}</small>` },
      { label: 'Current phase', render: p => esc(currentPhase(p)?.name || '') },
      { label: 'Progress', render: p => progressBar(projectProgress(p)) },
      { label: 'Fee', cls: 'num', render: p => money(projectFee(p)) },
      { label: 'Status', render: p => badge(p.status) },
    ], projects, { href: p => `project/${p.id}`, empty: 'No projects yet.' }))}
    <div class="grid-2">
      ${card('Fee proposals', table([
        { label: 'Proposal', render: q => `<b>${esc(q.number)}</b><br><small>${esc(q.projectName || '')}</small>` },
        { label: 'Date', render: q => fmtDate(q.date) }, { label: 'Net', cls: 'num', render: q => money(q.net) }, { label: 'Status', render: q => badge(q.status) },
      ], quotes, { href: q => `quote/${q.id}`, empty: 'No proposals yet.' }))}
      ${can('invoices') ? card('Invoices', table([
        { label: 'Invoice', render: i => `<b>${esc(i.number)}</b>` }, { label: 'Date', render: i => fmtDate(i.date) },
        { label: 'Total', cls: 'num', render: i => money(i.total) }, { label: 'Status', render: i => badge(invStatus(i)) },
      ], invs, { href: i => `invoice/${i.id}`, empty: 'No invoices yet.' })) : ''}
    </div>
    ${card('Emails', table([
      { label: 'Date', render: e => fmtDateTime(e.date) }, { label: 'Subject', render: e => esc(e.subject) + (e.auto ? ' <span class="tag">auto</span>' : '') },
      { label: 'Status', render: e => e.status ? badge(e.status) : '' },
    ], mails, { href: e => `outbox/${e.id}`, empty: 'No emails yet.' }))}`;
  },
});

/* ---------- calendar ---------- */
page('calendar', {
  title: 'Calendar',
  render(month) {
    month = month || today().slice(0, 7);
    const first = parseD(month + '-01');
    const start = addDays(month + '-01', -((first.getDay() + 6) % 7));
    const prev = isoOf(new Date(first.getFullYear(), first.getMonth() - 1, 1)).slice(0, 7);
    const next = isoOf(new Date(first.getFullYear(), first.getMonth() + 1, 1)).slice(0, 7);
    const events = {};
    const push = (date, html) => { if (date) (events[date] = events[date] || []).push(html); };
    const stop = 'onclick="event.stopPropagation()"';
    db.activities.forEach(a => push(a.date, `<div class="ev ev-${a.type} ${a.done ? 'done' : ''}" onclick="event.stopPropagation();editActivity('${a.id}')" title="${esc(a.title)}">${actIcon(a.type)} ${esc(a.time || '')} ${esc(a.title)}</div>`));
    db.projects.filter(p => p.status === 'active').forEach(p => (p.phases || []).filter(ph => ph.status !== 'done').forEach(ph => push(ph.dueDate, `<a class="ev ev-order" href="#/project/${p.id}" ${stop} title="${esc(p.name)}">⏱ ${esc(ph.name)} — ${esc(p.name)}</a>`)));
    db.tasks.filter(k => k.status !== 'done').forEach(k => push(k.dueDate, `<a class="ev ev-task" href="#/tasks" ${stop}>✓ ${esc(k.title)}</a>`));
    db.quotes.filter(q => q.status === 'sent').forEach(q => push(q.validUntil, `<a class="ev ev-quote" href="#/quote/${q.id}" ${stop}>✎ ${esc(q.number)} expires</a>`));
    const t = today(); let cells = '';
    for (let i = 0; i < 42; i++) {
      const d = addDays(start, i);
      cells += `<div class="cal-cell ${d.slice(0, 7) !== month ? 'other' : ''} ${d === t ? 'today' : ''}" onclick="editActivity(null,{date:'${d}'})"><div class="cal-day">${parseD(d).getDate()}</div>${(events[d] || []).join('')}</div>`;
    }
    return card(first.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }), `
      <div class="cal-head">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(x => `<div>${x}</div>`).join('')}</div>
      <div class="cal-grid">${cells}</div>
      <p class="muted sm">Click a day to add an appointment or site visit. Also shows phase deadlines, task due dates and proposal expiry dates.</p>`,
      `<a class="btn sm" href="#/calendar/${prev}">‹</a><a class="btn sm" href="#/calendar">Today</a><a class="btn sm" href="#/calendar/${next}">›</a>
       <button class="btn sm primary" onclick="editActivity()">+ Appointment</button>`);
  },
});

/* ---------- email outbox ---------- */
page('outbox', {
  title: 'Email outbox',
  render(id) {
    if (id) setTimeout(() => viewEmail(id));
    const live = SYNC.integrations.email === 'live';
    return `<div class="note ${live ? '' : 'warn'}">${live ? 'Emails are sent through your mail server.' : '<b>Email sending is not configured</b>, so emails are recorded here but not delivered.'} Templates: <a href="#/settings/email">Settings → Email templates</a>${me().role === 'admin' ? ' · mail server: <a href="#/settings/integrations">Settings → Integrations</a>' : ''}.</div>` +
      card(`Emails (${db.emails.length})`, table([
        { label: 'Date', render: e => fmtDateTime(e.date) },
        { label: 'To', render: e => esc(e.to) },
        { label: 'Subject', render: e => `${esc(e.subject)} ${e.auto ? '<span class="tag">auto</span>' : ''}` },
        { label: 'Related', render: e => esc(e.ref || '') },
        { label: 'Status', render: e => `${e.status ? badge(e.status) : ''}${e.status === 'failed' || (e.status === 'simulated' && live) ? ` <button class="btn xs" onclick="retryEmail('${e.id}')">Resend</button>` : ''}` },
      ], db.emails, { href: e => `outbox/${e.id}`, id: 'tbl-mail', empty: 'No emails yet.' }),
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
      { name: 'customerId', label: 'Client', type: 'select', options: pairs(db.customers, x => x.name, '— other recipient —') },
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
