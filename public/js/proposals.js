'use strict';
/* =========================================================================
   Fee proposals: phases & fees, payment schedule, conversion to a project
   ========================================================================= */

let PED = null; // proposal being edited: { doc, isNew, dirty }
const blankFeeLine = () => ({ desc: '', qty: 1, unit: 'phase', price: 0, discount: 0 });

function newProposal(preset = {}) {
  const t = today();
  const doc = { id: uid(), number: '', customerId: '', projectName: '', projectType: db.settings.projectTypes[0] || '', siteAddress: '', area: 0, constructionBudget: 0,
    date: t, validUntil: addDays(t, 30), lines: [], installments: clone(db.settings.paymentTemplates || []), notes: '',
    terms: 'Fees exclude VAT, state fees and the fees of other engineers (structural, MEP) unless listed.', status: 'draft', ...clone(preset) };
  if (!doc.lines.length) doc.lines = (db.settings.phaseTemplates || []).map(n => ({ ...blankFeeLine(), desc: n }));
  PED = { doc, isNew: true, dirty: true };
  go('quote/' + doc.id);
}
const pedLocked = () => !PED.isNew && !['draft', 'sent'].includes(PED.doc.status);
function pedSet(k, v, re) { PED.doc[k] = v; PED.dirty = true; if (re) rerender(); else pedTotals(); }
function pedLine(i, k, v) { PED.doc.lines[i][k] = ['desc', 'unit'].includes(k) ? v : (v === '' ? 0 : +v); PED.dirty = true; pedTotals(); }
function pedAddLine() { PED.doc.lines.push(blankFeeLine()); PED.dirty = true; rerender(); }
function pedRemoveLine(i) { PED.doc.lines.splice(i, 1); PED.dirty = true; rerender(); }
function pedInst(i, k, v) { PED.doc.installments[i][k] = k === 'percent' ? (+v || 0) : v; PED.dirty = true; pedTotals(); }
function pedAddInst() { PED.doc.installments.push({ label: '', percent: 0 }); PED.dirty = true; rerender(); }
function pedRemoveInst(i) { PED.doc.installments.splice(i, 1); PED.dirty = true; rerender(); }
function pedStandardPhases() {
  const have = new Set(PED.doc.lines.map(l => l.desc));
  for (const n of db.settings.phaseTemplates) if (!have.has(n)) PED.doc.lines.push({ ...blankFeeLine(), desc: n });
  PED.doc.lines = PED.doc.lines.filter(l => l.desc || l.price);
  PED.dirty = true; rerender();
}
/** Fee as % of the construction budget, split over the lines (by their current share, or equally). */
function pedCalc() {
  const pctv = +document.getElementById('ped-pct').value || 0;
  const budget = +PED.doc.constructionBudget || 0;
  if (!budget) return toast('Enter the estimated construction budget first', 'err');
  const lines = PED.doc.lines.filter(l => l.desc);
  if (!lines.length) return toast('Add at least one phase line', 'err');
  const fee = budget * pctv / 100;
  const cur = sum(lines, lineNet);
  lines.forEach(l => { l.qty = 1; l.discount = 0; l.price = Math.round((cur ? lineNet(l) / cur : 1 / lines.length) * fee / 10) * 10; });
  PED.dirty = true; rerender(); toast(`Fee set to ${money(sum(lines, lineNet))} (${pctv}% of ${money(budget)})`);
}
function pedTotalsHTML() {
  const t = totals(PED.doc.lines);
  const pctOfBudget = +PED.doc.constructionBudget ? t.net / PED.doc.constructionBudget * 100 : 0;
  return `<table class="totals"><tr><td>Fees (net)</td><td>${money(t.net)}</td></tr><tr><td>VAT ${db.settings.vatRate}%</td><td>${money(t.vat)}</td></tr>
    <tr class="grand"><td>Total</td><td>${money(t.total)}</td></tr>${pctOfBudget ? `<tr class="muted"><td>% of construction budget</td><td>${pct(pctOfBudget)}</td></tr>` : ''}</table>`;
}
function pedTotals() {
  PED.doc.lines.forEach((l, i) => { const el = document.getElementById('pl-' + i); if (el) el.textContent = money(lineNet(l)); });
  const t = document.getElementById('ped-totals'); if (t) t.innerHTML = pedTotalsHTML();
  const net = totals(PED.doc.lines).net;
  PED.doc.installments.forEach((x, i) => { const el = document.getElementById('pi-' + i); if (el) el.textContent = money(net * (+x.percent || 0) / 100); });
  const s = document.getElementById('ped-sched'); if (s) { const tot = scheduleTotal(PED.doc.installments); s.innerHTML = `Total <b class="${Math.abs(tot - 100) < 0.01 ? 'text-good' : 'text-bad'}">${pct(tot)}</b>${Math.abs(tot - 100) < 0.01 ? '' : ' — must be 100%'}`; }
}

page('quotes', {
  title: 'Fee proposals',
  render() {
    const f = UI.quoteStatus || '';
    const rows = db.quotes.filter(q => !f || q.status === f).sort((a, b) => b.date.localeCompare(a.date));
    const decided = db.quotes.filter(q => ['converted', 'accepted', 'rejected'].includes(q.status));
    const won = decided.filter(q => q.status !== 'rejected');
    const open = db.quotes.filter(q => ['draft', 'sent'].includes(q.status));
    return `<div class="kpis">
      ${kpi('Open proposals', open.length, money(sum(open, q => q.net)) + ' net')}
      ${kpi('Win rate', pct(decided.length ? won.length / decided.length * 100 : 0), `${won.length} of ${decided.length} decided`)}
      ${kpi('Expiring in 7 days', open.filter(q => q.validUntil <= addDays(today(), 7)).length)}
    </div>` + card('Fee proposals', table([
      { label: 'Proposal', render: q => `<b>${esc(q.number)}</b><br><small>${esc(q.projectName || '')}</small>` },
      { label: 'Client', render: q => esc(nameOf('customers', q.customerId)) },
      { label: 'Type', render: q => esc(q.projectType || '') },
      { label: 'Date', render: q => fmtDate(q.date) },
      { label: 'Valid until', render: q => `<span class="${['draft', 'sent'].includes(q.status) && q.validUntil < today() ? 'text-bad' : ''}">${fmtDate(q.validUntil)}</span>` },
      { label: 'Fees (net)', cls: 'num', render: q => money(q.net) },
      { label: 'Status', render: q => badge(q.status) },
    ], rows, { href: q => `quote/${q.id}`, id: 'tbl-q', empty: 'No proposals yet.' }),
      `<select onchange="UI.quoteStatus=this.value;rerender()"><option value="">All statuses</option>${['draft', 'sent', 'accepted', 'rejected', 'converted'].map(s => `<option value="${s}" ${f === s ? 'selected' : ''}>${STATUS[s]}</option>`).join('')}</select>
       ${searchBox('tbl-q')} <button class="btn primary" onclick="newProposal()">+ New proposal</button>`);
  },
});

page('quote', {
  nav: 'quotes', perm: () => 'quotes',
  title: id => { const q = byId('quotes', id); return q ? `Fee proposal ${q.number}` : 'New fee proposal'; },
  render(id) {
    if (!(PED && PED.doc.id === id)) { const ex = byId('quotes', id); if (!ex) return notFound(); PED = { doc: clone(ex), isNew: false, dirty: false }; }
    else if (!PED.isNew && !PED.dirty) { const ex = byId('quotes', id); if (ex) PED.doc = clone(ex); }
    const d = PED.doc, L = pedLocked(), dis = L ? 'disabled' : '';
    const net = totals(d.lines).net;
    const B = (label, fn, cls = '') => `<button class="btn ${cls}" onclick="${fn}">${label}</button>`;
    const acts = [];
    if (!L) acts.push(B(PED.isNew ? 'Create proposal' : 'Save', 'pedSave()', 'primary'));
    if (!PED.isNew) {
      if (['draft', 'sent'].includes(d.status)) acts.push(B('✉ Send to client', 'pedSend()'), B('✓ Accepted', "pedStatus('accepted')"), B('✗ Rejected', "pedStatus('rejected')"));
      if (['draft', 'sent', 'accepted'].includes(d.status) && can('projects')) acts.push(B('→ Create project', 'pedConvert()', 'accent'));
      if (d.projectId) acts.push(`<a class="btn" href="#/project/${d.projectId}">Open project</a>`);
      acts.push(B('Duplicate', 'pedDuplicate()'), B('🖨 Print / PDF', 'pedPrint()'));
    }
    return `<div class="page-actions"><a class="btn" href="#/quotes">← Proposals</a><span class="spacer"></span>${acts.join('')}</div>
    ${card('Project & client', `<div class="form-grid cols-4">
      <div class="field"><label>Client *</label><select ${dis} onchange="pedSet('customerId',this.value)">${opt(db.customers, d.customerId, { empty: '— select client —' })}</select>${L ? '' : `<small><a href="#" onclick="editCustomer(null,c=>{PED.doc.customerId=c.id;PED.dirty=true;rerender()});return false">+ new client</a></small>`}</div>
      <div class="field full"><label>Project name *</label><input ${dis} value="${esc(d.projectName)}" oninput="pedSet('projectName',this.value)" placeholder="e.g. Family house in Vari"></div>
      <div class="field"><label>Project type</label><select ${dis} onchange="pedSet('projectType',this.value)">${db.settings.projectTypes.map(x => `<option ${x === d.projectType ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></div>
      <div class="field"><label>Site address</label><input ${dis} value="${esc(d.siteAddress)}" oninput="pedSet('siteAddress',this.value)"></div>
      <div class="field"><label>Area (m²)</label><input ${dis} type="number" value="${d.area || ''}" oninput="pedSet('area',+this.value)"></div>
      <div class="field"><label>Est. construction budget (€)</label><input ${dis} type="number" value="${d.constructionBudget || ''}" oninput="pedSet('constructionBudget',+this.value)"></div>
      <div class="field"><label>Date</label><input ${dis} type="date" value="${d.date}" onchange="pedSet('date',this.value)"></div>
      <div class="field"><label>Valid until</label><input ${dis} type="date" value="${d.validUntil}" onchange="pedSet('validUntil',this.value)"></div>
      <div class="field"><label>Status</label><div class="static">${PED.isNew ? badge('draft') + ' <small>not saved yet</small>' : badge(d.status)}</div></div>
    </div>`)}
    ${card('Phases & fees', `<div class="table-wrap"><table class="tbl lines"><thead><tr><th>Phase / service</th><th class="num">Qty</th><th>Unit</th><th class="num">Fee</th><th class="num">Disc. %</th><th class="num">Amount</th><th></th></tr></thead><tbody>
      ${d.lines.map((l, i) => `<tr>
        <td><input ${dis} value="${esc(l.desc)}" oninput="pedLine(${i},'desc',this.value)" placeholder="e.g. Preliminary design"></td>
        <td><input ${dis} type="number" step="any" class="num w-xs" value="${l.qty}" oninput="pedLine(${i},'qty',this.value)"></td>
        <td><input ${dis} class="w-sm" value="${esc(l.unit || '')}" oninput="pedLine(${i},'unit',this.value)" list="units-dl"></td>
        <td><input ${dis} type="number" step="0.01" class="num w-sm" value="${l.price}" oninput="pedLine(${i},'price',this.value)"></td>
        <td><input ${dis} type="number" step="any" class="num w-xs" value="${l.discount}" oninput="pedLine(${i},'discount',this.value)"></td>
        <td class="num" id="pl-${i}">${money(lineNet(l))}</td>
        <td>${L ? '' : `<button class="icon-btn" title="Remove" onclick="pedRemoveLine(${i})">&times;</button>`}</td></tr>`).join('')}
      </tbody></table></div><datalist id="units-dl"><option value="phase"><option value="hour"><option value="m²"><option value="visit"><option value="lump sum"></datalist>
      ${L ? '' : `<div class="line-tools"><button class="btn sm" onclick="pedAddLine()">+ Add line</button><button class="btn sm" onclick="pedStandardPhases()">Add standard phases</button>
        <span class="spacer"></span><label class="inline">Fee calculator: <input id="ped-pct" type="number" step="0.1" class="num w-xs" value="8"> % of construction budget <button class="btn sm" onclick="pedCalc()">Apply</button></label></div>`}
      <p class="muted sm">Each line becomes a project phase with its fee when the proposal is turned into a project.</p>`)}
    <div class="grid-2">
      ${card('Payment schedule', `<div class="table-wrap"><table class="tbl lines"><thead><tr><th>Installment</th><th class="num">%</th><th class="num">Amount (net)</th><th></th></tr></thead><tbody>
        ${d.installments.map((x, i) => `<tr><td><input ${dis} value="${esc(x.label)}" oninput="pedInst(${i},'label',this.value)" placeholder="e.g. On building permit issue"></td>
          <td><input ${dis} type="number" step="any" class="num w-xs" value="${x.percent}" oninput="pedInst(${i},'percent',this.value)"></td>
          <td class="num" id="pi-${i}">${money(net * (+x.percent || 0) / 100)}</td><td>${L ? '' : `<button class="icon-btn" onclick="pedRemoveInst(${i})">&times;</button>`}</td></tr>`).join('')}
        </tbody></table></div><div class="line-tools">${L ? '' : '<button class="btn sm" onclick="pedAddInst()">+ Add installment</button>'}<span class="spacer"></span><span id="ped-sched"></span></div>`)}
      ${card('Totals', `<div id="ped-totals">${pedTotalsHTML()}</div>`)}
    </div>
    <div class="grid-2">
      ${card('Scope & notes', `<textarea ${dis} rows="5" oninput="pedSet('notes',this.value)" placeholder="Scope of work, deliverables, exclusions">${esc(d.notes)}</textarea>`)}
      ${card('Terms', `<textarea ${dis} rows="5" oninput="pedSet('terms',this.value)">${esc(d.terms)}</textarea>`)}
    </div>`;
  },
  after() { if (PED) pedTotals(); },
});
function pedNeedSaved() { if (PED.dirty) { toast('Save your changes first', 'err'); return false; } return true; }
function pedSave() {
  const d = PED.doc;
  if (!d.customerId) return toast('Select a client', 'err');
  if (!d.projectName.trim()) return toast('Enter the project name', 'err');
  d.lines = d.lines.filter(l => l.desc || l.price);
  if (!d.lines.length) { d.lines = [blankFeeLine()]; return toast('Add at least one phase with a fee', 'err'); }
  d.installments = d.installments.filter(x => x.label || x.percent);
  if (d.installments.length && Math.abs(scheduleTotal(d.installments) - 100) > 0.01) return toast(`The payment schedule adds up to ${pct(scheduleTotal(d.installments))} — it must be 100%`, 'err');
  Object.assign(d, totals(d.lines));
  if (PED.isNew) { d.number = nextNo('quote'); d.createdBy = me().id; db.quotes.push(clone(d)); PED.isNew = false; }
  else { const i = db.quotes.findIndex(x => x.id === d.id); db.quotes[i] = clone(d); }
  PED.dirty = false; saveDB(); toast('Proposal saved'); rerender();
}
const pedRec = () => byId('quotes', PED.doc.id);
function pedStatus(s) { if (!pedNeedSaved()) return; pedRec().status = s; saveDB(); rerender(); }
function pedSend() {
  if (!pedNeedSaved()) return;
  const q = pedRec(); const c = byId('customers', q.customerId);
  if (!c?.email) return toast('The client has no email address', 'err');
  q.status = 'sent'; q.sentAt = new Date().toISOString();
  sendTemplate('quoteSent', c.email, { customer: c.name, number: q.number, project: q.projectName, total: money(q.total), date: fmtDate(q.validUntil) }, q.number, c.id);
  saveDB(); toast(`Proposal email queued to ${c.email} — attach the PDF from “Print / PDF” if needed`); rerender();
}
function pedDuplicate() {
  const d = PED.doc;
  newProposal({ customerId: d.customerId, projectName: d.projectName + ' (copy)', projectType: d.projectType, siteAddress: d.siteAddress, area: d.area, constructionBudget: d.constructionBudget, lines: clone(d.lines), installments: clone(d.installments), notes: d.notes, terms: d.terms });
}
/** Turn an accepted proposal into a project: lines become phases, the schedule becomes installments. */
function pedConvert() {
  if (!pedNeedSaved()) return;
  const q = pedRec();
  const phases = q.lines.map((l, i) => ({ id: uid(), name: l.desc || `Phase ${i + 1}`, fee: lineNet(l), status: i === 0 ? 'progress' : 'todo', dueDate: '', budgetHours: 0 }));
  const find = re => phases.find(ph => re.test(ph.name))?.id || '';
  const installments = (q.installments || []).map((x, i) => {
    const lab = x.label.toLowerCase();
    let phaseId = '';
    if (/permit|άδει/.test(lab)) phaseId = find(/permit|άδει/i);
    else if (/final|οριστ/.test(lab)) phaseId = find(/final|οριστ/i);
    else if (/prelim|προμελ/.test(lab)) phaseId = find(/prelim|προμελ/i);
    else if (/construction drawings|κατασκευ/.test(lab)) phaseId = find(/construction drawings|κατασκευ/i);
    else if (/handover|completion|final payment|παράδοσ|ολοκλήρ/.test(lab) || (i === q.installments.length - 1 && i > 0)) phaseId = phases[phases.length - 1]?.id || '';
    return { id: uid(), label: x.label, percent: x.percent, phaseId, dueDate: phaseId ? '' : today(), invoiceId: '' };
  });
  const p = { id: uid(), number: nextNo('project'), name: q.projectName, customerId: q.customerId, type: q.projectType, status: 'active', siteAddress: q.siteAddress, city: byId('customers', q.customerId)?.city || '',
    kaek: '', permitNo: '', permitDate: '', area: q.area, constructionBudget: q.constructionBudget, startDate: today(), dueDate: '', managerId: me().id, team: [me().id],
    phases, installments, collaborators: [], files: [], links: [], notes: q.notes, quoteId: q.id };
  db.projects.push(p); q.status = 'converted'; q.projectId = p.id;
  saveDB(); toast(`Project created — check the payment schedule triggers`); go('project/' + p.id);
}
function pedPrint() {
  const q = PED.doc, c = db.settings.company, cust = byId('customers', q.customerId);
  printHTML(`<div class="print-doc">
    <header><div><h1>${esc(c.name)}</h1><div>${esc(c.address)}<br>VAT ${esc(c.vat)} · ${esc(c.taxOffice || '')}<br>${esc(c.phone)} · ${esc(c.email)}</div></div>
    <div class="pd-title"><h2>Fee proposal</h2><div>No. <b>${esc(q.number)}</b><br>Date ${fmtDate(q.date)}<br>Valid until ${fmtDate(q.validUntil)}</div></div></header>
    <section class="pd-party"><small>To</small><br><b>${esc(cust?.name || '')}</b><br>${esc(cust?.address || '')} ${esc(cust?.city || '')}</section>
    <p><b>Project:</b> ${esc(q.projectName)}${q.siteAddress ? ` · ${esc(q.siteAddress)}` : ''}${q.area ? ` · ${num(q.area)} m²` : ''} · ${esc(q.projectType || '')}</p>
    ${q.notes ? `<p class="pd-notes">${esc(q.notes)}</p>` : ''}
    <table><thead><tr><th>Phase / service</th><th class="num">Qty</th><th class="num">Fee</th><th class="num">Amount</th></tr></thead>
    <tbody>${q.lines.map(l => `<tr><td>${esc(l.desc)}</td><td class="num">${num(l.qty, 2)} ${esc(l.unit || '')}</td><td class="num">${money(l.price)}</td><td class="num">${money(lineNet(l))}</td></tr>`).join('')}</tbody></table>
    <table class="pd-totals"><tr><td>Fees</td><td>${money(q.net)}</td></tr><tr><td>VAT ${db.settings.vatRate}%</td><td>${money(q.vat)}</td></tr><tr class="grand"><td>Total</td><td>${money(q.total)}</td></tr></table>
    ${q.installments?.length ? `<h3>Payment schedule</h3><table><tbody>${q.installments.map(x => `<tr><td>${esc(x.label)}</td><td class="num">${num(x.percent, 1)}%</td><td class="num">${money(q.net * x.percent / 100)} + VAT</td></tr>`).join('')}</tbody></table>` : ''}
    ${q.terms ? `<p class="pd-notes"><b>Terms.</b> ${esc(q.terms)}</p>` : ''}</div>`);
}
