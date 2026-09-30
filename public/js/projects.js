'use strict';
/* =========================================================================
   Projects (phases, payment schedule, collaborators, files), tasks board,
   timesheets
   ========================================================================= */

const PROJECT_STATUSES = [['active', 'Active'], ['on_hold', 'On hold'], ['completed', 'Completed'], ['cancelled', 'Cancelled']];
const staff = () => db.users.filter(u => u.role !== 'customer');
const userName = id => nameOf('users', id, '—');

/* ---------- list ---------- */
page('projects', {
  title: 'Projects',
  render() {
    const f = UI.projStatus ?? 'active';
    const rows = db.projects.filter(p => !f || p.status === f).sort((a, b) => (b.startDate || '').localeCompare(a.startDate || ''));
    const showMoney = can('invoices');
    return card('Projects', table([
      { label: 'Project', render: p => `<b>${esc(p.name)}</b><br><small>${esc(p.number)} · ${esc(p.type || '')}</small>` },
      { label: 'Client', render: p => esc(nameOf('customers', p.customerId)) },
      { label: 'Current phase', render: p => `${esc(currentPhase(p)?.name || '—')}<br><small class="muted">${fmtDate(currentPhase(p)?.dueDate)}</small>` },
      { label: 'Progress', render: p => progressBar(projectProgress(p)) },
      { label: 'Manager', render: p => esc(userName(p.managerId)) },
      ...(showMoney ? [
        { label: 'Fee', cls: 'num', render: p => money(projectFee(p)) },
        { label: 'Invoiced', cls: 'num', render: p => `${money(projectInvoiced(p))}<br><small class="muted">${pct(projectFee(p) ? projectInvoiced(p) / projectFee(p) * 100 : 0)}</small>` },
      ] : []),
      { label: 'Hours', cls: 'num', render: p => num(projectHours(p.id), 1) },
      { label: 'Status', render: p => badge(p.status) },
    ], rows, { href: p => `project/${p.id}`, id: 'tbl-proj', empty: 'No projects in this view.' }),
      `<select onchange="UI.projStatus=this.value;rerender()"><option value="">All</option>${PROJECT_STATUSES.map(([v, l]) => `<option value="${v}" ${f === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
       ${searchBox('tbl-proj')} <button class="btn primary" onclick="editProject()">+ New project</button>`);
  },
});

function editProject(id, preset = {}) {
  const p = id ? byId('projects', id) : { type: db.settings.projectTypes[0], status: 'active', startDate: today(), managerId: me().id, ...preset };
  openForm({
    title: id ? 'Edit project' : 'New project', wide: true, values: p,
    fields: [
      { name: 'name', label: 'Project name', required: true, full: true },
      { name: 'customerId', label: 'Client', type: 'select', options: pairs(db.customers, x => x.name, '— select —'), required: true },
      { name: 'type', label: 'Type', type: 'select', options: db.settings.projectTypes.map(x => [x, x]) },
      { name: 'status', label: 'Status', type: 'select', options: PROJECT_STATUSES },
      { name: 'managerId', label: 'Project manager', type: 'select', options: pairs(staff()) },
      { name: 'siteAddress', label: 'Site address' },
      { name: 'city', label: 'Municipality / city' },
      { name: 'kaek', label: 'Cadastral code (ΚΑΕΚ)' },
      { name: 'area', label: 'Area (m²)', type: 'number' },
      { name: 'permitNo', label: 'Building permit no.' },
      { name: 'permitDate', label: 'Permit date', type: 'date' },
      { name: 'constructionBudget', label: 'Construction budget (€)', type: 'number' },
      { name: 'startDate', label: 'Start date', type: 'date' },
      { name: 'dueDate', label: 'Target completion', type: 'date' },
      { name: 'notes', label: 'Notes', type: 'textarea', full: true },
    ],
    onSave: d => {
      if (id) Object.assign(p, d);
      else {
        const n = { id: uid(), number: nextNo('project'), ...d, team: [me().id], collaborators: [], files: [], links: [],
          phases: db.settings.phaseTemplates.map((name, i) => ({ id: uid(), name, fee: 0, status: i === 0 ? 'progress' : 'todo', dueDate: '', budgetHours: 0 })),
          installments: (db.settings.paymentTemplates || []).map(x => ({ id: uid(), label: x.label, percent: x.percent, phaseId: '', dueDate: '', invoiceId: '' })) };
        db.projects.push(n); setTimeout(() => go('project/' + n.id));
      }
      saveDB(); rerender(); toast('Project saved');
    },
  });
}

/* ---------- project page ---------- */
page('project', {
  nav: 'projects', perm: () => 'projects',
  title: id => byId('projects', id)?.name || 'Project',
  render(id, tab = '') {
    const p = byId('projects', id); if (!p) return notFound();
    p.phases = p.phases || []; p.installments = p.installments || []; p.collaborators = p.collaborators || []; p.files = p.files || []; p.links = p.links || []; p.team = p.team || [];
    const money_ = can('invoices');
    const T = [['', 'Overview'], ['phases', 'Phases'], ...(money_ ? [['payments', 'Payment schedule']] : []), ['collaborators', 'Collaborators'], ['tasks', 'Tasks'], ['time', 'Time'], ...(money_ ? [['expenses', 'Expenses']] : []), ['files', 'Files & links']];
    const head = `<div class="page-actions"><a class="btn" href="#/projects">← Projects</a><span class="spacer"></span>
      <button class="btn" onclick="logTime({projectId:'${id}'})">⏱ Log time</button>
      <button class="btn" onclick="editTask(null,{projectId:'${id}'})">+ Task</button>
      <button class="btn" onclick="editActivity(null,{projectId:'${id}',customerId:'${p.customerId}',type:'site'})">+ Site visit</button>
      <button class="btn" onclick="editProject('${id}')">Edit</button>
      ${me().role === 'admin' ? `<button class="btn danger" onclick="deleteProject('${id}')">Delete</button>` : ''}</div>
      <div class="proj-head"><div><h2>${esc(p.name)}</h2><div class="muted">${esc(p.number)} · ${esc(p.type || '')} · <a href="#/customer/${p.customerId}">${esc(nameOf('customers', p.customerId))}</a></div></div><div>${badge(p.status)}</div></div>
      ${tabs('project/' + id, T, tab)}`;
    const body = tab === 'phases' ? projPhases(p) : tab === 'payments' ? projPayments(p) : tab === 'collaborators' ? projCollaborators(p) : tab === 'tasks' ? projTasks(p) : tab === 'time' ? projTime(p) : tab === 'expenses' ? projExpenses(p) : tab === 'files' ? projFiles(p) : projOverview(p);
    return head + body;
  },
});
function deleteProject(id) {
  if (db.invoices.some(i => i.projectId === id)) return toast('This project has invoices and cannot be deleted — set it to Cancelled instead', 'err');
  confirmBox('Delete this project with its tasks and time entries?', () => {
    db.projects = db.projects.filter(p => p.id !== id); db.tasks = db.tasks.filter(t => t.projectId !== id); db.timeEntries = db.timeEntries.filter(t => t.projectId !== id);
    saveDB(); go('projects');
  }, 'Delete');
}
function projectMoney(p) {
  const fee = projectFee(p), invoiced = projectInvoiced(p), labour = projectLabour(p.id), expenses = projectExpenses(p.id);
  const collabAgreed = sum(p.collaborators, c => +c.agreedFee || 0);
  const collabCost = Math.max(collabAgreed, sum(db.expenses.filter(e => e.projectId === p.id && e.supplierId), e => e.net));
  const otherExpenses = sum(db.expenses.filter(e => e.projectId === p.id && !e.supplierId), e => e.net);
  return { fee, invoiced, labour, expenses, collabAgreed, margin: round2(fee - labour - collabCost - otherExpenses) };
}
function projOverview(p) {
  const m = projectMoney(p);
  const hours = projectHours(p.id), budgetH = sum(p.phases, ph => +ph.budgetHours || 0);
  const tasks = db.tasks.filter(k => k.projectId === p.id && k.status !== 'done').sort((a, b) => (a.dueDate || '9').localeCompare(b.dueDate || '9')).slice(0, 6);
  const cur = currentPhase(p);
  return `<div class="kpis">
    ${kpi('Progress', pct(projectProgress(p) * 100), esc(cur?.name || ''))}
    ${can('invoices') ? kpi('Fee', money(m.fee), `${pct(m.fee ? m.invoiced / m.fee * 100 : 0)} invoiced`) : ''}
    ${kpi('Hours', num(hours, 1), budgetH ? `of ${num(budgetH)} budgeted` : '')}
    ${can('invoices') ? kpi('Estimated margin', money(m.margin), `labour ${money(m.labour)} · collaborators & expenses ${money(m.fee - m.labour - m.margin)}`) : ''}
  </div>
  <div class="grid-2">
    ${card('Project details', `<dl class="dl">
      <dt>Site</dt><dd>${esc(p.siteAddress || '—')}${p.city ? ', ' + esc(p.city) : ''}</dd>
      <dt>ΚΑΕΚ</dt><dd>${esc(p.kaek || '—')}</dd><dt>Area</dt><dd>${p.area ? num(p.area) + ' m²' : '—'}</dd>
      <dt>Building permit</dt><dd>${esc(p.permitNo || '—')}${p.permitDate ? ' · ' + fmtDate(p.permitDate) : ''}</dd>
      <dt>Construction budget</dt><dd>${p.constructionBudget ? money(p.constructionBudget) : '—'}</dd>
      <dt>Dates</dt><dd>${fmtDate(p.startDate)} → ${fmtDate(p.dueDate)}</dd>
      <dt>Manager</dt><dd>${esc(userName(p.managerId))}</dd>
      <dt>Team</dt><dd>${p.team.map(u => esc(userName(u))).join(', ') || '—'} <button class="btn xs" onclick="editTeam('${p.id}')">Edit</button></dd>
      ${p.quoteId ? `<dt>From proposal</dt><dd><a href="#/quote/${p.quoteId}">${esc(byId('quotes', p.quoteId)?.number || '')}</a></dd>` : ''}
      ${p.notes ? `<dt>Notes</dt><dd>${esc(p.notes)}</dd>` : ''}</dl>`)}
    ${card('Phases', `<ol class="timeline">${p.phases.map(ph => `<li class="${ph.status === 'done' ? 'done' : ''}"><b>${esc(ph.name)}</b> ${badge(ph.status)} <small>${ph.dueDate ? 'due ' + fmtDate(ph.dueDate) : ''}</small></li>`).join('') || '<li class="muted">No phases yet</li>'}</ol>`, `<a class="btn sm" href="#/project/${p.id}/phases">Manage</a>`)}
  </div>
  ${card('Open tasks', table([
    { label: 'Task', render: k => `<b>${esc(k.title)}</b>` }, { label: 'Phase', render: k => esc(phaseOf(p, k.phaseId)?.name || '') },
    { label: 'Assignee', render: k => esc(userName(k.assigneeId)) }, { label: 'Due', render: k => fmtDate(k.dueDate) }, { label: 'Status', render: k => badge(k.status) },
  ], tasks, { empty: 'No open tasks.' }), `<a class="btn sm" href="#/project/${p.id}/tasks">All tasks</a>`)}`;
}
function editTeam(id) {
  const p = byId('projects', id);
  openModal('Project team', staff().map(u => `<label class="chk" style="display:flex;margin:6px 0"><input type="checkbox" class="team-chk" value="${u.id}" ${p.team.includes(u.id) ? 'checked' : ''}> ${esc(u.name)}</label>`).join(''),
    [{ label: 'Cancel' }, { label: 'Save', primary: true, onClick: () => { p.team = [...document.querySelectorAll('.team-chk:checked')].map(x => x.value); saveDB(); rerender(); } }]);
}

/* ----- phases ----- */
function phaseSet(pid, phid, k, v) {
  const ph = phaseOf(byId('projects', pid), phid); if (!ph) return;
  ph[k] = ['fee', 'budgetHours'].includes(k) ? (+v || 0) : v;
  saveDB();
  if (k === 'status') { toast(v === 'done' ? `${ph.name} completed${byId('projects', pid).installments.some(i => i.phaseId === phid && !i.invoiceId) ? ' — a payment installment is now due' : ''}` : 'Phase updated'); rerender(); }
}
function addPhase(pid) { byId('projects', pid).phases.push({ id: uid(), name: 'New phase', fee: 0, status: 'todo', dueDate: '', budgetHours: 0 }); saveDB(); rerender(); }
function removePhase(pid, phid) {
  const p = byId('projects', pid);
  if (db.timeEntries.some(t => t.projectId === pid && t.phaseId === phid)) return toast('Time was logged on this phase — rename it instead of deleting', 'err');
  if (p.installments.some(i => i.phaseId === phid)) return toast('A payment installment is triggered by this phase — change the schedule first', 'err');
  p.phases = p.phases.filter(x => x.id !== phid); saveDB(); rerender();
}
function movePhase(pid, i, dir) { const a = byId('projects', pid).phases; const j = i + dir; if (j < 0 || j >= a.length) return; [a[i], a[j]] = [a[j], a[i]]; saveDB(); rerender(); }
function projPhases(p) {
  const showFee = can('invoices');
  return card('Phases', `<div class="table-wrap"><table class="tbl lines"><thead><tr><th></th><th>Phase</th>${showFee ? '<th class="num">Fee (net)</th>' : ''}<th>Due</th><th>Status</th><th class="num">Budget h</th><th class="num">Actual h</th><th></th></tr></thead><tbody>
    ${p.phases.map((ph, i) => { const h = projectHours(p.id, ph.id); return `<tr>
      <td class="nowrap"><button class="btn xs" onclick="movePhase('${p.id}',${i},-1)">↑</button><button class="btn xs" onclick="movePhase('${p.id}',${i},1)">↓</button></td>
      <td><input value="${esc(ph.name)}" onchange="phaseSet('${p.id}','${ph.id}','name',this.value)"></td>
      ${showFee ? `<td><input type="number" step="10" class="num w-sm" value="${ph.fee}" onchange="phaseSet('${p.id}','${ph.id}','fee',this.value)"></td>` : ''}
      <td><input type="date" value="${ph.dueDate || ''}" onchange="phaseSet('${p.id}','${ph.id}','dueDate',this.value)"></td>
      <td><select onchange="phaseSet('${p.id}','${ph.id}','status',this.value)">${[['todo', 'To do'], ['progress', 'In progress'], ['done', 'Done']].map(([v, l]) => `<option value="${v}" ${ph.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select></td>
      <td><input type="number" class="num w-xs" value="${ph.budgetHours || 0}" onchange="phaseSet('${p.id}','${ph.id}','budgetHours',this.value)"></td>
      <td class="num ${ph.budgetHours && h > ph.budgetHours ? 'text-bad' : ''}">${num(h, 1)}</td>
      <td><button class="icon-btn" title="Remove" onclick="removePhase('${p.id}','${ph.id}')">&times;</button></td></tr>`; }).join('')}
    </tbody>${showFee ? `<tfoot><tr><td></td><td>Total fee</td><td class="num">${money(projectFee(p))}</td><td colspan="5"></td></tr></tfoot>` : ''}</table></div>
    <div class="line-tools"><button class="btn sm" onclick="addPhase('${p.id}')">+ Add phase</button><span class="muted sm">Changes save automatically. Marking a phase “Done” makes the installments linked to it due for invoicing.</span></div>`);
}

/* ----- payment schedule (installments) ----- */
function instStatus(p, ins) {
  if (ins.invoiceId) { const inv = byId('invoices', ins.invoiceId); return inv && invStatus(inv) === 'paid' ? 'paid' : 'invoiced'; }
  return installmentDue(p, ins) ? 'due' : 'planned';
}
function instSet(pid, iid, k, v) {
  const ins = byId('projects', pid).installments.find(x => x.id === iid); if (!ins || ins.invoiceId && k === 'percent') return toast('This installment is already invoiced', 'err');
  ins[k] = k === 'percent' ? (+v || 0) : v;
  if (k === 'trigger') { if (v === 'date') { ins.phaseId = ''; ins.dueDate = ins.dueDate || today(); } else { ins.phaseId = v; ins.dueDate = ''; } delete ins.trigger; }
  saveDB(); rerender();
}
function addInstallment(pid) { byId('projects', pid).installments.push({ id: uid(), label: 'New installment', percent: 0, phaseId: '', dueDate: '', invoiceId: '' }); saveDB(); rerender(); }
function removeInstallment(pid, iid) {
  const p = byId('projects', pid); const ins = p.installments.find(x => x.id === iid);
  if (ins.invoiceId) return toast('This installment is invoiced and cannot be removed', 'err');
  p.installments = p.installments.filter(x => x.id !== iid); saveDB(); rerender();
}
function applyScheduleTemplate(pid) {
  const p = byId('projects', pid);
  if (p.installments.some(i => i.invoiceId)) return toast('Some installments are already invoiced', 'err');
  p.installments = db.settings.paymentTemplates.map(x => ({ id: uid(), label: x.label, percent: x.percent, phaseId: '', dueDate: '', invoiceId: '' }));
  saveDB(); rerender();
}
function projPayments(p) {
  const tot = scheduleTotal(p.installments), fee = projectFee(p);
  const invs = projectInvoices(p.id).sort((a, b) => a.date.localeCompare(b.date));
  return `${Math.abs(tot - 100) > 0.01 ? `<div class="note warn">The payment schedule adds up to <b>${pct(tot)}</b> of the fee — it should be 100%.</div>` : ''}
  ${card(`Payment schedule — fee ${money(fee)} + VAT`, `<div class="table-wrap"><table class="tbl lines"><thead><tr><th>Installment</th><th class="num">%</th><th class="num">Amount (net)</th><th>Due when</th><th>Status</th><th></th></tr></thead><tbody>
    ${p.installments.map(ins => { const st = instStatus(p, ins); const locked = !!ins.invoiceId; return `<tr>
      <td><input ${locked ? 'disabled' : ''} value="${esc(ins.label)}" onchange="instSet('${p.id}','${ins.id}','label',this.value)"></td>
      <td><input ${locked ? 'disabled' : ''} type="number" step="any" class="num w-xs" value="${ins.percent}" onchange="instSet('${p.id}','${ins.id}','percent',this.value)"></td>
      <td class="num">${money(installmentAmount(p, ins))}</td>
      <td><select ${locked ? 'disabled' : ''} onchange="instSet('${p.id}','${ins.id}','trigger',this.value)"><option value="date" ${!ins.phaseId ? 'selected' : ''}>On a date</option>${p.phases.map(ph => `<option value="${ph.id}" ${ins.phaseId === ph.id ? 'selected' : ''}>When “${esc(ph.name)}” is done</option>`).join('')}</select>
        ${!ins.phaseId ? `<input ${locked ? 'disabled' : ''} type="date" value="${ins.dueDate || ''}" onchange="instSet('${p.id}','${ins.id}','dueDate',this.value)">` : ''}</td>
      <td>${badge(st)}</td>
      <td class="nowrap">${ins.invoiceId ? `<a class="btn xs" href="#/invoice/${ins.invoiceId}">${esc(byId('invoices', ins.invoiceId)?.number || 'Invoice')}</a>` : `<button class="btn xs ${st === 'due' ? 'primary' : ''}" onclick="invoiceInstallment('${p.id}','${ins.id}')">€ Invoice</button> <button class="icon-btn" onclick="removeInstallment('${p.id}','${ins.id}')">&times;</button>`}</td></tr>`; }).join('')}
    </tbody><tfoot><tr><td>Total</td><td class="num ${Math.abs(tot - 100) > 0.01 ? 'text-bad' : ''}">${pct(tot)}</td><td class="num">${money(fee * tot / 100)}</td><td colspan="3"></td></tr></tfoot></table></div>
    <div class="line-tools"><button class="btn sm" onclick="addInstallment('${p.id}')">+ Add installment</button><button class="btn sm" onclick="applyScheduleTemplate('${p.id}')">Use standard schedule</button>
    <span class="muted sm">Amounts follow the phase fees. An installment linked to a phase becomes due when that phase is marked done.</span></div>`)}
  ${card('Invoices for this project', table([
    { label: 'Invoice', render: i => `<b>${esc(i.number)}</b><br><small>${esc(INV_TYPES[i.type] || '')}</small>` },
    { label: 'Date', render: i => fmtDate(i.date) }, { label: 'Net', cls: 'num', render: i => money(invNet(i)) },
    { label: 'To receive', cls: 'num', render: i => money(isCredit(i) ? 0 : payableOf(i)) }, { label: 'Balance', cls: 'num', render: i => money(balanceOf(i)) },
    { label: 'Status', render: i => badge(invStatus(i)) },
  ], invs, { href: i => `invoice/${i.id}`, empty: 'No invoices yet.' }), `<button class="btn sm" onclick="newInvoice({projectId:'${p.id}'})">+ Other invoice</button>`)}`;
}

/* ----- collaborators on the project ----- */
const expensePaid = e => round2(sum(e.payments || [], x => x.amount));
function collabFigures(p, c) {
  const bills = db.expenses.filter(e => e.projectId === p.id && e.supplierId === c.supplierId);
  const billed = round2(sum(bills, e => e.net)), paid = round2(sum(bills, expensePaid)), billedGross = round2(sum(bills, e => e.total));
  return { bills, billed, billedGross, paid, unpaidBills: round2(billedGross - paid), remaining: round2((+c.agreedFee || 0) - billed) };
}
function editCollaboration(pid, cid) {
  const p = byId('projects', pid); const c = cid ? p.collaborators.find(x => x.id === cid) : { supplierId: '', role: '', agreedFee: 0 };
  openForm({
    title: cid ? 'Edit collaborator' : 'Add collaborator to project', values: c,
    fields: [
      { name: 'supplierId', label: 'Collaborator', type: 'select', options: pairs(db.suppliers, s => `${s.name}${s.specialty ? ' — ' + s.specialty : ''}`, '— select —'), required: true },
      { name: 'role', label: 'Role on this project', placeholder: 'e.g. Structural study & supervision', full: true },
      { name: 'agreedFee', label: 'Agreed fee (€, net)', type: 'number' },
      { name: 'notes', label: 'Notes', type: 'textarea', full: true },
    ],
    extra: `<p class="muted sm">Not in the list? <a href="#" onclick="closeModal();editSupplier(null,()=>editCollaboration('${pid}'));return false">Add a new collaborator</a>.</p>`,
    buttons: cid ? [{ label: 'Remove', danger: true, onClick: () => { p.collaborators = p.collaborators.filter(x => x.id !== cid); saveDB(); rerender(); } }] : [],
    onSave: d => { if (cid) Object.assign(c, d); else p.collaborators.push({ id: uid(), ...d }); saveDB(); rerender(); },
  });
}
function projCollaborators(p) {
  const rows = p.collaborators.map(c => ({ c, s: byId('suppliers', c.supplierId), ...collabFigures(p, c) }));
  const showMoney = can('invoices') || can('expenses');
  return card('Collaborators on this project', table([
    { label: 'Collaborator', render: r => `<b><a href="#/supplier/${r.c.supplierId}">${esc(r.s?.name || '—')}</a></b><br><small>${esc(r.s?.specialty || '')}</small>` },
    { label: 'Role', render: r => esc(r.c.role || '') },
    ...(showMoney ? [
      { label: 'Agreed fee', cls: 'num', render: r => money(r.c.agreedFee) },
      { label: 'Billed (net)', cls: 'num', render: r => money(r.billed) },
      { label: 'Paid', cls: 'num', render: r => money(r.paid) },
      { label: 'Unpaid bills', cls: 'num', render: r => `<span class="${r.unpaidBills > 0 ? 'text-warn' : ''}">${money(r.unpaidBills)}</span>` },
      { label: 'Still to bill', cls: 'num', render: r => money(Math.max(0, r.remaining)) },
    ] : []),
    { label: '', render: r => `<button class="btn xs" onclick="editCollaboration('${p.id}','${r.c.id}')">Edit</button>${can('expenses') ? ` <button class="btn xs" onclick="editExpense(null,{projectId:'${p.id}',supplierId:'${r.c.supplierId}',category:'${esc(r.s?.specialty || '')}'})">+ Bill</button>` : ''}` },
  ], rows, {
    empty: 'No collaborators yet. Add the engineers, surveyors and others working on this project.',
    foot: showMoney && rows.length ? `<tfoot><tr><td colspan="2">Total</td><td class="num">${money(sum(rows, r => +r.c.agreedFee || 0))}</td><td class="num">${money(sum(rows, r => r.billed))}</td><td class="num">${money(sum(rows, r => r.paid))}</td><td class="num">${money(sum(rows, r => r.unpaidBills))}</td><td class="num">${money(sum(rows, r => Math.max(0, r.remaining)))}</td><td></td></tr></tfoot>` : '',
  }), `<button class="btn sm primary" onclick="editCollaboration('${p.id}')">+ Add collaborator</button>`);
}

/* ----- project tasks, time, expenses, files ----- */
function projTasks(p) {
  const rows = db.tasks.filter(k => k.projectId === p.id).sort((a, b) => (a.status === 'done') - (b.status === 'done') || (a.dueDate || '9').localeCompare(b.dueDate || '9'));
  return card('Tasks', table([
    { label: '', render: k => `<input type="checkbox" ${k.status === 'done' ? 'checked' : ''} onchange="taskDone('${k.id}',this.checked)">` },
    { label: 'Task', render: k => `<b>${esc(k.title)}</b>${k.priority === 'high' ? ' <span class="tag bad">urgent</span>' : ''}` },
    { label: 'Phase', render: k => esc(phaseOf(p, k.phaseId)?.name || '') }, { label: 'Assignee', render: k => esc(userName(k.assigneeId)) },
    { label: 'Due', render: k => fmtDate(k.dueDate) }, { label: 'Status', render: k => badge(k.status) },
    { label: '', render: k => `<button class="btn xs" onclick="editTask('${k.id}')">Edit</button>` },
  ], rows, { empty: 'No tasks yet.' }), `<button class="btn sm primary" onclick="editTask(null,{projectId:'${p.id}'})">+ Task</button>`);
}
function projTime(p) {
  const entries = db.timeEntries.filter(t => t.projectId === p.id).sort((a, b) => b.date.localeCompare(a.date));
  const byUser = [...groupBy(entries, t => t.userId)].map(([u, es]) => ({ label: userName(u), value: sum(es, e => e.hours) }));
  const byPhase = [...groupBy(entries, t => t.phaseId)].map(([ph, es]) => ({ label: phaseOf(p, ph)?.name || '—', value: sum(es, e => e.hours) }));
  return `<div class="grid-2">${card('Hours by person', hbars(byUser, { fmt: v => num(v, 1) + ' h' }))}${card('Hours by phase', hbars(byPhase, { fmt: v => num(v, 1) + ' h' }))}</div>` +
    card(`Time entries (${num(sum(entries, e => e.hours), 1)} h)`, table([
      { label: 'Date', render: e => fmtDate(e.date) }, { label: 'Person', render: e => esc(userName(e.userId)) },
      { label: 'Phase', render: e => esc(phaseOf(p, e.phaseId)?.name || '') }, { label: 'Description', render: e => esc(e.description || '') },
      { label: 'Hours', cls: 'num', render: e => num(e.hours, 2) },
      { label: '', render: e => canEditTime(e) ? `<button class="btn xs" onclick="logTime({},'${e.id}')">Edit</button>` : '' },
    ], entries.slice(0, 200), { empty: 'No time logged yet.' }), `<button class="btn sm primary" onclick="logTime({projectId:'${p.id}'})">⏱ Log time</button>`);
}
function projExpenses(p) {
  const rows = db.expenses.filter(e => e.projectId === p.id).sort((a, b) => b.date.localeCompare(a.date));
  return card(`Expenses (${money(sum(rows, e => e.net))} net)`, expensesTable(rows), `<button class="btn sm primary" onclick="editExpense(null,{projectId:'${p.id}'})">+ Expense</button>`);
}
const FILE_CATEGORIES = ['Drawings', 'Permit documents', 'Contracts', 'Photos', 'Studies', 'Correspondence', 'Other'];
function projFiles(p) {
  const max = Math.round((SYNC.maxUpload || 26214400) / 1048576);
  return `<div class="note">Files marked <b>shared</b> are visible to the client in the client portal. Uploads are limited to ${max} MB each: for large drawing sets, keep them in your shared drive and add a <b>link</b>.</div>
  ${card('Files', table([
    { label: 'File', render: f => fileLink(f) }, { label: 'Category', render: f => esc(f.category || '') }, { label: 'Size', cls: 'num', render: f => num(f.size / 1024) + ' KB' },
    { label: 'Added', render: f => `${fmtDate((f.addedAt || '').slice(0, 10))}<br><small>${esc(userName(f.by))}</small>` },
    { label: 'Shared with client', render: f => `<input type="checkbox" ${f.shared ? 'checked' : ''} onchange="fileShare('${p.id}','${f.fileId}',this.checked)">` },
    { label: '', render: f => `<button class="icon-btn" title="Delete" onclick="fileRemove('${p.id}','${f.fileId}')">&times;</button>` },
  ], p.files, { empty: 'No files yet.' }), `<select id="up-cat">${FILE_CATEGORIES.map(c => `<option>${c}</option>`).join('')}</select> <label class="btn sm primary">⬆ Upload<input type="file" multiple hidden onchange="projUpload('${p.id}',this)"></label>`)}
  ${card('Links', table([
    { label: 'Title', render: l => `<a href="${esc(safeUrl(l.url))}" target="_blank" rel="noopener">${esc(l.title)}</a>` }, { label: 'Address', render: l => `<small class="muted">${esc(l.url)}</small>` },
    { label: 'Shared with client', render: l => `<input type="checkbox" ${l.shared ? 'checked' : ''} onchange="linkShare('${p.id}','${l.id}',this.checked)">` },
    { label: '', render: l => `<button class="icon-btn" onclick="linkRemove('${p.id}','${l.id}')">&times;</button>` },
  ], p.links, { empty: 'No links yet.' }), `<button class="btn sm" onclick="addLink('${p.id}')">+ Link</button>`)}`;
}
const safeUrl = u => /^https?:\/\//i.test(String(u || '')) ? u : '#';
const fileLink = a => a.fileId ? `<a href="/api/files/${esc(a.fileId)}" target="_blank" rel="noopener">📎 ${esc(a.name)}</a>` : `📎 ${esc(a.name)}`;
async function projUpload(pid, input) {
  const files = [...input.files]; const max = SYNC.maxUpload || 26214400;
  if (files.some(f => f.size > max)) return toast(`Files must be ${Math.round(max / 1048576)} MB or smaller — add a link for larger files`, 'err');
  const category = document.getElementById('up-cat').value;
  toast(`Uploading ${files.length} file(s)…`);
  for (const f of files) {
    try { const up = await uploadFile(f); byId('projects', pid).files.push({ fileId: up.id, name: up.name, size: up.size, type: up.type, category, shared: false, addedAt: new Date().toISOString(), by: me().id }); }
    catch (e) { toast(`${f.name}: ${e.message}`, 'err'); }
  }
  saveDB(); rerender(); toast('Upload finished');
}
function fileShare(pid, fid, v) { const f = byId('projects', pid).files.find(x => x.fileId === fid); f.shared = v; saveDB(); toast(v ? 'Visible to the client' : 'No longer visible to the client'); }
function fileRemove(pid, fid) {
  const p = byId('projects', pid); const f = p.files.find(x => x.fileId === fid);
  confirmBox(`Delete ${f.name}?`, () => { api('/api/files/' + fid, { method: 'DELETE' }).catch(e => toast(e.message, 'err')); p.files = p.files.filter(x => x.fileId !== fid); saveDB(); rerender(); }, 'Delete file');
}
function addLink(pid) {
  openForm({ title: 'Add link', fields: [{ name: 'title', label: 'Title', required: true, full: true }, { name: 'url', label: 'Address (https://…)', required: true, full: true }, { name: 'shared', label: 'Client portal', type: 'checkbox', hint: 'Show to the client' }],
    onSave: d => { if (!/^https?:\/\//i.test(d.url)) return toast('The address must start with https://', 'err'); byId('projects', pid).links.push({ id: uid(), ...d }); saveDB(); rerender(); } });
}
function linkShare(pid, lid, v) { byId('projects', pid).links.find(x => x.id === lid).shared = v; saveDB(); }
function linkRemove(pid, lid) { const p = byId('projects', pid); p.links = p.links.filter(x => x.id !== lid); saveDB(); rerender(); }

/* ---------- tasks board ---------- */
function editTask(id, preset = {}) {
  const k = id ? byId('tasks', id) : { status: 'todo', priority: 'normal', assigneeId: me().id, dueDate: addDays(today(), 7), ...preset };
  const p = byId('projects', k.projectId);
  openForm({
    title: id ? 'Edit task' : 'New task', values: k,
    fields: [
      { name: 'title', label: 'Task', required: true, full: true },
      { name: 'projectId', label: 'Project', type: 'select', options: pairs(db.projects.filter(x => x.status !== 'cancelled'), projectLabel, '— select —'), required: true },
      { name: 'phaseId', label: 'Phase', type: 'select', options: [['', '—'], ...((p?.phases) || []).map(ph => [ph.id, ph.name])] },
      { name: 'assigneeId', label: 'Assigned to', type: 'select', options: pairs(staff()) },
      { name: 'dueDate', label: 'Due', type: 'date' },
      { name: 'priority', label: 'Priority', type: 'select', options: [['normal', 'Normal'], ['high', 'Urgent']] },
      { name: 'status', label: 'Status', type: 'select', options: [['todo', 'To do'], ['progress', 'In progress'], ['done', 'Done']] },
      { name: 'notes', label: 'Notes', type: 'textarea', full: true },
    ],
    buttons: id ? [{ label: 'Delete', danger: true, onClick: () => { db.tasks = db.tasks.filter(x => x.id !== id); saveDB(); rerender(); } }] : [],
    onSave: d => { if (id) Object.assign(k, d); else db.tasks.push({ id: uid(), ...k, ...d }); saveDB(); rerender(); toast('Task saved'); },
  });
  const ps = document.getElementById('f_projectId'), phs = document.getElementById('f_phaseId');
  ps.onchange = () => { const pp = byId('projects', ps.value); phs.innerHTML = `<option value="">—</option>` + ((pp?.phases) || []).map(ph => `<option value="${ph.id}">${esc(ph.name)}</option>`).join(''); };
}
function taskDone(id, v) { byId('tasks', id).status = v ? 'done' : 'todo'; saveDB(); rerender(); }
function taskMove(id, dir) { const o = ['todo', 'progress', 'done']; const k = byId('tasks', id); k.status = o[Math.max(0, Math.min(2, o.indexOf(k.status) + dir))]; saveDB(); rerender(); }
page('tasks', {
  title: 'Tasks',
  render() {
    const fp = UI.taskProject || '', fu = UI.taskUser ?? '';
    const list = db.tasks.filter(k => (!fp || k.projectId === fp) && (!fu || k.assigneeId === fu));
    const t = today();
    const cardHTML = k => { const p = byId('projects', k.projectId); return `<div class="wo-card ${k.priority === 'high' ? 'urgent' : ''}" onclick="editTask('${k.id}')">
      <div class="wo-top"><b>${esc(k.title)}</b>${k.priority === 'high' ? '<span class="tag bad">urgent</span>' : ''}</div>
      <small class="muted">${esc(p?.name || '')}${phaseOf(p, k.phaseId) ? ' · ' + esc(phaseOf(p, k.phaseId).name) : ''}</small>
      <div class="wo-meta"><span class="${k.status !== 'done' && k.dueDate && k.dueDate < t ? 'text-bad' : ''}">${k.dueDate ? 'Due ' + fmtDate(k.dueDate) : ''}</span><span>${esc(userName(k.assigneeId))}</span></div>
      <div class="wo-move">${k.status !== 'todo' ? `<button class="btn xs" onclick="event.stopPropagation();taskMove('${k.id}',-1)">‹</button>` : ''}${k.status !== 'done' ? `<button class="btn xs" onclick="event.stopPropagation();taskMove('${k.id}',1)">›</button>` : ''}</div></div>`; };
    const col = (s, l) => { const items = list.filter(k => k.status === s).sort((a, b) => (a.priority === 'high' ? -1 : 0) - (b.priority === 'high' ? -1 : 0) || (a.dueDate || '9').localeCompare(b.dueDate || '9')); return `<div class="kcol"><h3>${l} <span class="muted">${items.length}</span></h3>${(s === 'done' ? items.slice(0, 15) : items).map(cardHTML).join('') || '<div class="empty sm">Empty</div>'}</div>`; };
    return `<div class="toolbar"><select onchange="UI.taskProject=this.value;rerender()"><option value="">All projects</option>${opt(db.projects.filter(p => p.status === 'active'), fp, { label: projectLabel })}</select>
      <select onchange="UI.taskUser=this.value;rerender()"><option value="">Everyone</option>${opt(staff(), fu)}</select><span class="spacer"></span><button class="btn primary" onclick="editTask(null,{projectId:'${fp}'})">+ Task</button></div>
      <div class="kanban">${col('todo', 'To do')}${col('progress', 'In progress')}${col('done', 'Done')}</div>`;
  },
});

/* ---------- timesheets ---------- */
const canEditTime = e => e.userId === me().id || me().role === 'admin';
function logTime(preset = {}, id) {
  const e = id ? byId('timeEntries', id) : { date: today(), userId: me().id, hours: 1, billable: true, ...preset };
  const p = byId('projects', e.projectId);
  if (!e.phaseId && p) e.phaseId = currentPhase(p)?.id || '';
  openForm({
    title: id ? 'Edit time entry' : 'Log time', values: e,
    fields: [
      { name: 'date', label: 'Date', type: 'date', required: true },
      { name: 'hours', label: 'Hours', type: 'number', step: '0.25', required: true },
      { name: 'projectId', label: 'Project', type: 'select', options: pairs(db.projects.filter(x => x.status !== 'cancelled'), projectLabel, '— select —'), required: true },
      { name: 'phaseId', label: 'Phase', type: 'select', options: [['', '—'], ...((p?.phases) || []).map(ph => [ph.id, ph.name])] },
      ...(me().role === 'admin' ? [{ name: 'userId', label: 'Person', type: 'select', options: pairs(staff()) }] : []),
      { name: 'description', label: 'What was done', full: true, list: ['Design development', 'Drawings', 'Client meeting', 'Site visit', 'Coordination with engineers', 'Permit documents', 'Supervision'] },
    ],
    buttons: id ? [{ label: 'Delete', danger: true, onClick: () => { db.timeEntries = db.timeEntries.filter(x => x.id !== id); saveDB(); rerender(); } }] : [],
    onSave: d => {
      if (!(d.hours > 0 && d.hours <= 24)) return toast('Hours must be between 0 and 24', 'err');
      if (id) Object.assign(e, d); else db.timeEntries.push({ id: uid(), ...e, ...d, billable: true });
      saveDB(); rerender(); toast(`${num(d.hours, 2)} h logged`);
    },
  });
  const ps = document.getElementById('f_projectId'), phs = document.getElementById('f_phaseId');
  ps.onchange = () => { const pp = byId('projects', ps.value); phs.innerHTML = `<option value="">—</option>` + ((pp?.phases) || []).map(ph => `<option value="${ph.id}" ${currentPhase(pp)?.id === ph.id ? 'selected' : ''}>${esc(ph.name)}</option>`).join(''); };
}
page('timesheets', {
  title: 'Timesheets',
  render() {
    const t = today();
    const week = UI.tsWeek || addDays(t, -((parseD(t).getDay() + 6) % 7));
    const days = Array.from({ length: 7 }, (_, i) => addDays(week, i));
    const who = UI.tsUser ?? me().id;
    const entries = db.timeEntries.filter(e => (!who || e.userId === who) && e.date >= days[0] && e.date <= days[6]);
    const rows = [...groupBy(entries, e => e.projectId + '|' + e.phaseId)].map(([k, es]) => { const [pid, phid] = k.split('|'); return { p: byId('projects', pid), ph: phid, es }; });
    const dayTotal = d => sum(entries.filter(e => e.date === d), e => e.hours);
    const canSeeOthers = ['admin', 'accounting'].includes(me().role);
    return `<div class="toolbar"><a class="btn sm" href="#" onclick="UI.tsWeek='${addDays(week, -7)}';rerender();return false">‹</a>
      <b>Week of ${fmtDate(week)}</b><a class="btn sm" href="#" onclick="UI.tsWeek='${addDays(week, 7)}';rerender();return false">›</a><a class="btn sm" href="#" onclick="UI.tsWeek='';rerender();return false">This week</a>
      ${canSeeOthers ? `<select onchange="UI.tsUser=this.value;rerender()"><option value="">Everyone</option>${opt(staff(), who)}</select>` : ''}
      <span class="spacer"></span><button class="btn primary" onclick="logTime()">⏱ Log time</button></div>
      ${card(`Hours — ${num(sum(entries, e => e.hours), 1)} h this week`, `<div class="table-wrap"><table class="tbl"><thead><tr><th>Project / phase</th>${days.map(d => `<th class="num ${d === t ? 'text-good' : ''}">${parseD(d).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric' })}</th>`).join('')}<th class="num">Total</th></tr></thead><tbody>
        ${rows.map(r => `<tr><td><b>${esc(r.p?.name || '—')}</b><br><small>${esc(phaseOf(r.p, r.ph)?.name || '')}</small></td>${days.map(d => { const h = sum(r.es.filter(e => e.date === d), e => e.hours); return `<td class="num">${h ? num(h, 2) : '<span class="muted">·</span>'}</td>`; }).join('')}<td class="num"><b>${num(sum(r.es, e => e.hours), 2)}</b></td></tr>`).join('') || `<tr><td colspan="9" class="empty">No hours this week.</td></tr>`}
        </tbody><tfoot><tr><td>Total</td>${days.map(d => `<td class="num">${num(dayTotal(d), 2)}</td>`).join('')}<td class="num">${num(sum(entries, e => e.hours), 2)}</td></tr></tfoot></table></div>`)}
      ${card('Entries', table([
        { label: 'Date', render: e => fmtDate(e.date) }, ...(who ? [] : [{ label: 'Person', render: e => esc(userName(e.userId)) }]),
        { label: 'Project', render: e => esc(byId('projects', e.projectId)?.name || '') }, { label: 'Phase', render: e => esc(phaseOf(byId('projects', e.projectId), e.phaseId)?.name || '') },
        { label: 'Description', render: e => esc(e.description || '') }, { label: 'Hours', cls: 'num', render: e => num(e.hours, 2) },
        { label: '', render: e => canEditTime(e) ? `<button class="btn xs" onclick="logTime({},'${e.id}')">Edit</button>` : '' },
      ], entries.sort((a, b) => b.date.localeCompare(a.date)), { empty: 'No entries.' }))}`;
  },
});
