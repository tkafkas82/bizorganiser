'use strict';
/* =========================================================================
   Reports and settings
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
const periodSelect = (key, def = 'year') => `<select onchange="UI.${key}=this.value;rerender()">${PERIODS.map(([v, l]) => `<option value="${v}" ${(UI[key] || def) === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
const invoicesIn = p => db.invoices.filter(i => !i.cancelled && i.date >= periodStart(p));

/* ---------- reports ---------- */
page('reports', {
  title: 'Reports',
  render(tab = '') {
    const head = tabs('reports', [['', 'Overview'], ['projects', 'Project profitability'], ['team', 'Team hours'], ['collaborators', 'Collaborator payments']], tab);
    if (tab === 'projects') return head + reportProjects();
    if (tab === 'team') return head + reportTeam();
    if (tab === 'collaborators') return head + reportCollaborators();
    const p = UI.repPeriod || 'year', from = periodStart(p);
    const inv = invoicesIn(p);
    const fees = sum(inv, invNet);
    const exp = db.expenses.filter(e => e.date >= from);
    const hours = db.timeEntries.filter(e => e.date >= from);
    const quotes = db.quotes.filter(q => q.date >= from);
    const decided = quotes.filter(q => ['converted', 'accepted', 'rejected'].includes(q.status)); const won = decided.filter(q => q.status !== 'rejected');
    const months = lastMonths(12).map(m => ({ label: m.label, value: sum(db.invoices.filter(i => !i.cancelled && i.date.startsWith(m.key)), invNet) }));
    const byClient = [...groupBy(inv, i => nameOf('customers', i.customerId))].map(([k, is]) => ({ label: k, value: sum(is, invNet) })).sort((a, b) => b.value - a.value).slice(0, 8);
    const byType = [...groupBy(inv, i => byId('projects', i.projectId)?.type || 'Other')].map(([k, is]) => ({ label: k, value: sum(is, invNet) })).sort((a, b) => b.value - a.value);
    const byCat = [...groupBy(exp, e => e.category || 'Other')].map(([k, es]) => ({ label: k, value: sum(es, e => e.net) })).sort((a, b) => b.value - a.value);
    const t = today();
    const aging = [['Not due', i => i.dueDate >= t], ['1–30 days', i => i.dueDate < t && daysBetween(i.dueDate, t) <= 30], ['31–60 days', i => daysBetween(i.dueDate, t) > 30 && daysBetween(i.dueDate, t) <= 60], ['60+ days', i => daysBetween(i.dueDate, t) > 60]]
      .map(([label, f]) => ({ label, value: sum(db.invoices.filter(i => !i.cancelled && balanceOf(i) > 0 && f(i)), balanceOf) }));
    return head + `<div class="toolbar">${periodSelect('repPeriod')}<span class="spacer"></span><button class="btn" onclick="exportInvoicesCSV()">Export invoices CSV</button></div>
    <div class="kpis">
      ${kpi('Fees invoiced (net)', money(fees), `${inv.filter(i => !isCredit(i)).length} documents`)}
      ${kpi('Expenses (net)', money(sum(exp, e => e.net)))}
      ${kpi('Hours logged', num(sum(hours, e => e.hours), 0), `labour cost ${money(sum(hours, e => e.hours * hourlyCost(e.userId)))}`)}
      ${kpi('Proposal win rate', pct(decided.length ? won.length / decided.length * 100 : 0), `${won.length}/${decided.length}`)}
      ${kpi('Withholding by clients', money(sum(inv, i => (isCredit(i) ? -1 : 1) * (i.withheld || 0))), 'credit against your income tax')}
      ${kpi('VAT charged', money(sum(inv, invVat)))}
    </div>
    ${card('Fees invoiced per month — last 12 months', barChart(months))}
    <div class="grid-2">${card('Fees by client', hbars(byClient))}${card('Fees by project type', hbars(byType))}</div>
    <div class="grid-2">${card('Expenses by category', hbars(byCat))}${card('Receivables aging', hbars(aging))}</div>`;
  },
});
function reportProjects() {
  const f = UI.repProjStatus ?? 'active';
  const rows = db.projects.filter(p => !f || p.status === f).map(p => ({ p, ...projectMoney(p), hours: projectHours(p.id) })).sort((a, b) => b.fee - a.fee);
  return `<div class="note">Estimated margin = fee − labour cost (hours × each person's hourly cost) − collaborators (the higher of agreed fee or bills) − other project expenses. Hourly costs are set in <a href="#/settings/users">Settings → Users</a>.</div>` +
    card('Project profitability', table([
      { label: 'Project', render: r => `<a href="#/project/${r.p.id}"><b>${esc(r.p.name)}</b></a><br><small>${esc(r.p.number)} · ${esc(nameOf('customers', r.p.customerId))}</small>` },
      { label: 'Fee', cls: 'num', render: r => money(r.fee) },
      { label: 'Invoiced', cls: 'num', render: r => `${money(r.invoiced)}<br><small class="muted">${pct(r.fee ? r.invoiced / r.fee * 100 : 0)}</small>` },
      { label: 'Hours', cls: 'num', render: r => num(r.hours, 1) },
      { label: 'Labour cost', cls: 'num', render: r => money(r.labour) },
      { label: 'Collaborators & expenses', cls: 'num', render: r => money(r.fee - r.labour - r.margin) },
      { label: 'Est. margin', cls: 'num', render: r => `<b class="${r.margin < 0 ? 'text-bad' : 'text-good'}">${money(r.margin)}</b><br><small class="muted">${pct(r.fee ? r.margin / r.fee * 100 : 0)}</small>` },
      { label: 'Fee per hour', cls: 'num', render: r => r.hours ? money(r.fee / r.hours) : '—' },
    ], rows, { empty: 'No projects.' }), `<select onchange="UI.repProjStatus=this.value;rerender()"><option value="">All projects</option>${PROJECT_STATUSES.map(([v, l]) => `<option value="${v}" ${f === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`);
}
function reportTeam() {
  const p = UI.repTeamPeriod || 'month', from = periodStart(p);
  const es = db.timeEntries.filter(e => e.date >= from);
  const rows = staff().map(u => { const mine = es.filter(e => e.userId === u.id); return { u, hours: sum(mine, e => e.hours), cost: sum(mine, e => e.hours * hourlyCost(u.id)), projects: new Set(mine.map(e => e.projectId)).size }; }).filter(r => r.hours);
  const byProject = [...groupBy(es, e => byId('projects', e.projectId)?.name || '—')].map(([k, x]) => ({ label: k, value: sum(x, e => e.hours) })).sort((a, b) => b.value - a.value).slice(0, 10);
  return `<div class="toolbar">${periodSelect('repTeamPeriod', 'month')}</div>` +
    card('Hours per person', table([
      { label: 'Person', render: r => `<b>${esc(r.u.name)}</b><br><small>${esc(db.team.find(x => x.id === r.u.id)?.title || '')}</small>` },
      { label: 'Hours', cls: 'num', render: r => num(r.hours, 1) }, { label: 'Projects', cls: 'num', render: r => r.projects },
      { label: 'Hourly cost', cls: 'num', render: r => money(hourlyCost(r.u.id)) }, { label: 'Labour cost', cls: 'num', render: r => money(r.cost) },
    ], rows, { empty: 'No hours in this period.' })) + card('Hours per project', hbars(byProject, { fmt: v => num(v, 1) + ' h' }));
}
function reportCollaborators() {
  const fs = UI.repCollab || '';
  const rows = collaboratorRows({ supplierId: fs || undefined }).sort((a, b) => (a.s?.name || '').localeCompare(b.s?.name || '') || (a.p?.name || '').localeCompare(b.p?.name || ''));
  return `<div class="note">For every collaborator and project: the fee agreed with them, what they have billed, what you have paid, and what is still open. Bills are recorded as expenses linked to the collaborator and project.</div>` +
    card('Collaborator payments by project', collaboratorTable(rows),
      `<select onchange="UI.repCollab=this.value;rerender()"><option value="">All collaborators</option>${opt(db.suppliers, fs)}</select> <button class="btn" onclick="exportCollaboratorCSV(UI.repCollab)">⬇ Export CSV</button>`);
}
function exportInvoicesCSV() {
  const inv = invoicesIn(UI.repPeriod || 'year');
  downloadFile('invoices.csv', toCSV([['Number', 'Type', 'Date', 'Client', 'VAT no.', 'Project', 'Net', 'VAT', 'Total', 'Withheld', 'Payable', 'Paid', 'Status', 'myDATA MARK'],
    ...inv.map(i => [i.number, i.type, i.date, nameOf('customers', i.customerId), byId('customers', i.customerId)?.vat, byId('projects', i.projectId)?.name || '', invNet(i), invVat(i), invSign(i) * i.total, invSign(i) * (i.withheld || 0), invSign(i) * payableOf(i), paidOf(i), invStatus(i), i.mydata?.mark || ''])]), 'text/csv');
}

/* ---------- settings ---------- */
const SETTINGS_TABS = [['', 'Company'], ['documents', 'Documents & lists'], ['email', 'Email templates'], ['integrations', 'Integrations'], ['users', 'Users & logins'], ['data', 'Data & audit']];
page('settings', {
  title: 'Settings',
  render(tab = '') {
    const admin = me().role === 'admin';
    const head = tabs('settings', SETTINGS_TABS, tab) + (admin ? '' : `<div class="note warn">Only administrators can change settings.</div>`);
    const S = db.settings;
    if (tab === 'documents') return head + card('Invoicing', `<div class="form-grid cols-4">
        ${fieldHTML({ name: 'vatRate', label: 'VAT rate %', type: 'number' }, S.vatRate)}
        ${fieldHTML({ name: 'withholdingRate', label: 'Withholding on fees %', type: 'number' }, S.withholdingRate)}
        ${fieldHTML({ name: 'withholdingThreshold', label: 'Withhold when net fee over (€)', type: 'number' }, S.withholdingThreshold)}
        ${fieldHTML({ name: 'withholdingCategory', label: 'myDATA withholding category', type: 'number', help: '3 = 20% on fees. Confirm with your accountant.' }, S.withholdingCategory)}
        ${fieldHTML({ name: 'defaultHourlyCost', label: 'Default hourly cost (€)', type: 'number', help: 'For people without their own rate' }, S.defaultHourlyCost)}
        ${Object.entries(S.prefixes).map(([k, v]) => fieldHTML({ name: 'pre_' + k, label: `Numbering prefix: ${k}` }, v)).join('')}
      </div><p class="muted sm">Numbers are assigned by the server in strict sequence, separately for invoices, receipts and credit notes.</p>`) +
      card('Lists', `<div class="form-grid">
        ${fieldHTML({ name: 'phases', label: 'Standard project phases (one per line)', type: 'textarea', rows: 7 }, S.phaseTemplates.join('\n'))}
        ${fieldHTML({ name: 'ptypes', label: 'Project types (one per line)', type: 'textarea', rows: 7 }, S.projectTypes.join('\n'))}
        ${fieldHTML({ name: 'ecats', label: 'Expense categories / specialties (one per line)', type: 'textarea', rows: 7 }, S.expenseCategories.join('\n'))}
        ${fieldHTML({ name: 'schedule', label: 'Standard payment schedule (one per line: label = percent)', type: 'textarea', rows: 7, help: 'e.g. On signing the contract = 30' }, S.paymentTemplates.map(x => `${x.label} = ${x.percent}`).join('\n'))}
      </div>`) + saveBar('saveDocSettings()');
    if (tab === 'email') return head + `<div class="note">Templates can use <code>{{customer}}</code>, <code>{{number}}</code>, <code>{{project}}</code>, <code>{{total}}</code>, <code>{{date}}</code>, <code>{{company}}</code>.</div>` +
      Object.entries(S.templates).map(([k, t]) => card(t.name, `<label class="chk"><input type="checkbox" id="auto_${k}" ${S.automations[k] ? 'checked' : ''}> Send automatically</label>
        <div class="form-grid">${fieldHTML({ name: `tpl_${k}_subject`, label: 'Subject', full: true }, t.subject)}${fieldHTML({ name: `tpl_${k}_body`, label: 'Body', type: 'textarea', rows: 5, full: true }, t.body)}</div>`)).join('') + saveBar('saveEmailSettings()');
    if (tab === 'integrations') { if (!admin) return head; setTimeout(loadIntegrations); return head + `<div id="integrations"><div class="empty">Loading…</div></div>`; }
    if (tab === 'users') {
      if (admin) setTimeout(loadUsers);
      return head + `<div class="note">Staff sign in here. <b>Client logins</b> sign in to the client portal at <a href="/client/" target="_blank">/client/</a> and see only their own projects, shared files and invoices. New users must change their password at first sign-in.</div>` +
        (admin ? `<div id="users-admin"><div class="empty">Loading…</div></div>` : '') +
        card('Team — titles and hourly cost', table([
          { label: 'Person', render: u => `<b>${esc(u.name)}</b>` },
          { label: 'Title', render: u => admin ? `<input value="${esc(db.team.find(x => x.id === u.id)?.title || '')}" onchange="teamSet('${u.id}','title',this.value)">` : esc(db.team.find(x => x.id === u.id)?.title || '') },
          { label: 'Hourly cost (€)', render: u => admin ? `<input type="number" class="num w-sm" value="${db.team.find(x => x.id === u.id)?.hourlyCost ?? ''}" placeholder="${S.defaultHourlyCost}" onchange="teamSet('${u.id}','hourlyCost',+this.value)">` : money(hourlyCost(u.id)) },
        ], staff()), '<span class="muted sm">Used for project profitability</span>');
    }
    if (tab === 'data') {
      if (admin) setTimeout(loadAudit);
      return head + card('Backup & restore', `<p>Export a JSON backup regularly and keep it safe.</p>
      <p class="muted sm">${db.customers.length} clients · ${db.projects.length} projects · ${db.invoices.length} invoices · ${db.timeEntries.length} time entries</p>
      <div class="btn-row"><button class="btn primary" onclick="exportData()">⬇ Export JSON</button>
      ${admin ? `<label class="btn">⬆ Import JSON<input type="file" accept="application/json" hidden onchange="importData(this)"></label>
      <button class="btn" onclick="confirmBox('Replace ALL business data with the demo data? Users are kept.',()=>adminAction('/api/admin/reset-demo','Demo data restored'),'Reset')">Load demo data</button>
      <button class="btn danger" onclick="confirmBox('Delete ALL business data (clients, projects, proposals, invoices, time, expenses, calendar) and start empty? Users, company details and integration settings are kept.',()=>adminAction('/api/admin/reset-empty','Started with empty data'),'Delete everything')">Start empty</button>` : ''}</div>`) +
        (admin ? card('Audit log', `<div id="audit"><div class="empty">Loading…</div></div>`) : '');
    }
    const c = S.company;
    return head + card('Company details (printed on documents and sent to myDATA)', `<div class="form-grid">
      ${[['name', 'Office name'], ['vat', 'VAT number (ΑΦΜ)'], ['taxOffice', 'Tax office (ΔΟΥ)'], ['email', 'Email'], ['phone', 'Phone'], ['address', 'Address'], ['iban', 'IBAN']].map(([k, l]) => fieldHTML({ name: 'co_' + k, label: l }, c[k])).join('')}
      </div>`) + saveBar('saveCompany()');
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
  const schedule = splitLines('schedule').map(l => { const m = l.match(/^(.*?)\s*=\s*([\d.,]+)\s*%?$/); return m ? { label: m[1].trim(), percent: +m[2].replace(',', '.') } : null; });
  if (schedule.some(x => !x)) return toast('Payment schedule lines must look like “Label = 30”', 'err');
  if (schedule.length && Math.abs(scheduleTotal(schedule) - 100) > 0.01) return toast(`The standard payment schedule adds up to ${pct(scheduleTotal(schedule))} — it must be 100%`, 'err');
  S.vatRate = +val('vatRate') || 0; S.withholdingRate = +val('withholdingRate') || 0; S.withholdingThreshold = +val('withholdingThreshold') || 0;
  S.withholdingCategory = +val('withholdingCategory') || 3; S.defaultHourlyCost = +val('defaultHourlyCost') || 0;
  for (const k of Object.keys(S.prefixes)) S.prefixes[k] = val('pre_' + k) || S.prefixes[k];
  S.phaseTemplates = splitLines('phases'); S.projectTypes = splitLines('ptypes'); S.expenseCategories = splitLines('ecats'); S.paymentTemplates = schedule;
  saveDB(); rerender(); toast('Settings saved');
}
function saveEmailSettings() {
  const S = db.settings;
  for (const [k, t] of Object.entries(S.templates)) { S.automations[k] = document.getElementById('auto_' + k).checked; t.subject = val(`tpl_${k}_subject`); t.body = document.getElementById(`f_tpl_${k}_body`).value; }
  saveDB(); toast('Email settings saved');
}
function teamSet(userId, k, v) {
  let t = db.team.find(x => x.id === userId);
  if (!t) { t = { id: userId }; db.team.push(t); }
  t[k] = v; saveDB(); toast('Saved');
}

/* ---------- integrations (admin; secrets stay on the server) ---------- */
async function loadIntegrations() {
  const box = document.getElementById('integrations'); if (!box) return;
  let c;
  try { c = (await api('/api/admin/integrations')).config; } catch (e) { box.innerHTML = `<div class="empty text-bad">${esc(e.message)}</div>`; return; }
  const f = (name, label, v, extra = {}) => fieldHTML({ name, label, ...extra }, v);
  box.innerHTML = `<div class="note">Passwords and keys are stored encrypted on the server and shown as ******** here. Leave a masked field unchanged to keep its value.</div>
  ${card('Email (SMTP)', `<div class="form-grid cols-4">
    ${f('smtp_host', 'SMTP server', c.smtp.host, { placeholder: 'smtp.office365.com' })}${f('smtp_port', 'Port', c.smtp.port, { type: 'number' })}
    ${f('smtp_secure', 'TLS', c.smtp.secure, { type: 'checkbox', hint: 'Implicit TLS (port 465). Otherwise STARTTLS.' })}
    ${f('smtp_from', 'From address', c.smtp.from)}${f('smtp_user', 'Username', c.smtp.user)}${f('smtp_pass', 'Password', c.smtp.pass, { type: 'password' })}
  </div><div class="btn-row"><input id="smtp_test_to" type="email" placeholder="Send a test email to…"><button class="btn" onclick="testEmail()">Send test</button></div>`)}
  ${card('AADE myDATA', `<div class="note warn"><b>B2B e-invoicing mandate:</b> from 1 Oct 2026 B2B invoices must be issued through a licensed e-invoicing provider or AADE's timologio app. This connection uses the myDATA <b>ERP channel</b>: use it for the test environment and service receipts, and confirm with your accountant before using it for B2B invoices in production.</div>
    <div class="form-grid cols-4">
    ${f('md_mode', 'Mode', c.mydata.mode, { type: 'select', options: [['simulate', 'Simulation (no connection)'], ['test', 'Test environment (mydataapidev)'], ['production', 'Production']] })}
    ${f('md_user', 'User ID (aade-user-id)', c.mydata.userId)}${f('md_key', 'Subscription key', c.mydata.subscriptionKey, { type: 'password' })}
  </div>`)}
  <div class="page-actions"><span class="spacer"></span><button class="btn primary" onclick="saveIntegrations()">Save integrations</button></div>`;
}
async function saveIntegrations() {
  const v = id => document.getElementById('f_' + id).value.trim();
  const body = { smtp: { host: v('smtp_host'), port: +v('smtp_port') || 587, secure: document.getElementById('f_smtp_secure').checked, from: v('smtp_from'), user: v('smtp_user'), pass: v('smtp_pass') }, mydata: { mode: v('md_mode'), userId: v('md_user'), subscriptionKey: v('md_key') } };
  try { const r = await api('/api/admin/integrations', { method: 'PUT', body }); SYNC.integrations = r.status; toast('Integrations saved'); loadIntegrations(); }
  catch (e) { toast(e.message, 'err'); }
}
async function testEmail() {
  const to = document.getElementById('smtp_test_to').value.trim();
  if (!to) return toast('Enter an address to send the test to', 'err');
  toast('Sending…');
  try { await api('/api/admin/test-email', { method: 'POST', body: { to } }); toast('Test email sent — check the inbox'); } catch (e) { toast('Test failed: ' + e.message, 'err'); }
}

/* ---------- users (admin) ---------- */
let USERS = [];
async function loadUsers() {
  const box = document.getElementById('users-admin'); if (!box) return;
  try { USERS = (await api('/api/admin/users')).users; } catch (e) { box.innerHTML = `<div class="empty text-bad">${esc(e.message)}</div>`; return; }
  box.innerHTML = card('Users & logins', table([
    { label: 'Name', render: u => `<b>${esc(u.name)}</b>${u.active ? '' : ' <span class="tag bad">disabled</span>'}${u.mustChange ? ' <span class="tag">must change password</span>' : ''}` },
    { label: 'Email (login)', render: u => esc(u.email) },
    { label: 'Role', render: u => u.role === 'customer' ? `Client portal<br><small>${esc(nameOf('customers', u.customerId))}</small>` : esc(ROLES[u.role]?.label || u.role) },
    { label: 'Last sign-in', render: u => u.lastLogin ? fmtDateTime(u.lastLogin) : '<span class="muted">never</span>' },
    { label: '', render: u => `<button class="btn xs" onclick="editUser('${u.id}')">Edit</button>` },
  ], USERS), `<button class="btn primary" onclick="editUser()">+ New user</button>`);
}
function editUser(id) {
  const u = id ? USERS.find(x => x.id === id) : { role: 'architect', active: true };
  const roleOpts = [['admin', 'Administrator'], ['architect', 'Architect'], ['accounting', 'Accounting'], ['customer', 'Client (client portal login)']];
  if (u.role && !roleOpts.some(r => r[0] === u.role)) roleOpts.push([u.role, ROLES[u.role]?.label || u.role]);
  openForm({
    title: id ? 'Edit user' : 'New user', values: { ...u, password: '' },
    fields: [
      { name: 'name', label: 'Name', required: true }, { name: 'email', label: 'Email (used to sign in)', type: 'email', required: true },
      { name: 'role', label: 'Role', type: 'select', options: roleOpts },
      { name: 'customerId', label: 'Client (for client portal logins)', type: 'select', options: pairs(db.customers, x => x.name, '— none —') },
      { name: 'password', label: id ? 'New password (leave empty to keep)' : 'Temporary password', type: 'password', help: 'At least 10 characters with letters and numbers. The user must change it at first sign-in.' },
      ...(id ? [{ name: 'active', label: 'Status', type: 'checkbox', hint: 'Can sign in' }] : []),
    ],
    buttons: id && id !== me().id ? [{ label: 'Delete', danger: true, onClick: () => { confirmBox(`Delete ${u.name}?`, () => api('/api/admin/users/' + id, { method: 'DELETE' }).then(() => { toast('User deleted'); loadUsers(); }).catch(e => toast(e.message, 'err')), 'Delete'); } }] : [],
    onSave: d => {
      if (!id && !d.password) return toast('Set a temporary password', 'err');
      const req = id ? api('/api/admin/users/' + id, { method: 'PUT', body: { ...d, password: d.password || undefined } }) : api('/api/admin/users', { method: 'POST', body: d });
      req.then(() => { closeModal(); toast('User saved'); loadUsers(); api('/api/users').then(r => { db.users = r.users.filter(x => x.role !== 'customer'); rerender(); }); }).catch(e => toast(e.message, 'err'));
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
  try { await syncNow(); await api(url, { method: 'POST', body: {} }); toast(msg); setTimeout(() => location.reload(), 600); } catch (e) { toast(e.message, 'err'); }
}
function importData(input) {
  const f = input.files[0]; if (!f) return;
  const r = new FileReader();
  r.onload = () => {
    let data; try { data = JSON.parse(r.result); } catch { return toast('This file is not valid JSON', 'err'); }
    confirmBox(`Replace ALL business data with this backup (${(data.customers || []).length} clients, ${(data.projects || []).length} projects, ${(data.invoices || []).length} invoices)?`, async () => {
      try { await api('/api/admin/import', { method: 'POST', body: data }); toast('Backup imported'); setTimeout(() => location.reload(), 600); } catch (e) { toast('Import failed: ' + e.message, 'err'); }
    }, 'Import');
  };
  r.readAsText(f);
}
