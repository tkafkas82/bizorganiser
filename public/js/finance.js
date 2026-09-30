'use strict';
/* =========================================================================
   Invoices (service invoices / receipts, withholding, credit notes,
   myDATA), expenses, collaborators & their payments
   ========================================================================= */

const INV_TYPES = { '2.1': 'Service invoice (2.1)', '11.2': 'Service receipt (11.2)', '5.1': 'Credit note (5.1)', '11.4': 'Retail credit note (11.4)', '1.1': 'Sales invoice (1.1)', '11.1': 'Retail receipt (11.1)' };
const numberKey = type => isCredit({ type }) ? 'credit' : type === '11.2' || type === '11.1' ? 'receipt' : 'invoice';
const PAY_METHODS = [['bank', 'Bank transfer'], ['card', 'Card'], ['cash', 'Cash']];

/* ---------- creating invoices ---------- */
/** Create a one-line fee invoice / receipt (optionally for a payment installment). */
function createInvoice({ customerId, projectId = '', type, date = today(), dueDate, desc, amount, withholdingRate = 0, paymentMethod = 'bank', installment }) {
  const lines = [{ desc, qty: 1, unit: 'service', price: round2(amount), discount: 0 }];
  const wh = type === '11.2' ? 0 : +withholdingRate || 0;
  const inv = { id: uid(), number: nextNo(numberKey(type)), type, customerId, projectId, installmentId: installment?.id || '',
    date, dueDate: dueDate || date, paymentMethod, withholdingRate: wh, lines, ...totals(lines, wh), payments: [], mydata: { status: 'pending' } };
  db.invoices.push(inv);
  if (installment) installment.invoiceId = inv.id;
  const cu = byId('customers', customerId);
  if (cu?.email) autoEmail('invoiceIssued', cu.email, { customer: cu.name, number: inv.number, total: money(inv.payable), date: fmtDate(inv.dueDate) }, inv.number, cu.id);
  saveDB();
  return inv;
}
function invoiceForm({ title, customerId, projectId, desc, amount, installment }) {
  const c = byId('customers', customerId);
  const t = today();
  openForm({
    title, wide: true,
    values: { customerId, projectId, type: invoiceTypeFor(c), date: t, dueDate: addDays(t, 15), desc, amount, withholdingRate: withholdingFor(c, amount), paymentMethod: 'bank' },
    fields: [
      { name: 'customerId', label: 'Client', type: 'select', options: pairs(db.customers, x => x.name, '— select —'), required: true },
      { name: 'projectId', label: 'Project', type: 'select', options: pairs(db.projects, projectLabel, '— none —') },
      { name: 'type', label: 'Document type', type: 'select', options: [['2.1', INV_TYPES['2.1'] + ' — businesses'], ['11.2', INV_TYPES['11.2'] + ' — individuals']] },
      { name: 'paymentMethod', label: 'Payment', type: 'select', options: PAY_METHODS },
      { name: 'date', label: 'Date', type: 'date', required: true },
      { name: 'dueDate', label: 'Due date', type: 'date' },
      { name: 'desc', label: 'Description', required: true, full: true },
      { name: 'amount', label: 'Fee amount (€, net of VAT)', type: 'number', required: true },
      { name: 'withholdingRate', label: 'Withholding tax %', type: 'number', help: `Business clients withhold ${db.settings.withholdingRate}% on fees above ${money(db.settings.withholdingThreshold)}` },
    ],
    extra: `<div id="inv-preview" class="note"></div>`,
    saveLabel: 'Issue invoice',
    onSave: d => {
      if (!(d.amount > 0)) return toast('Enter the amount', 'err');
      const inv = createInvoice({ ...d, installment });
      syncNow().then(() => { toast(`${INV_TYPES[inv.type]} ${byId('invoices', inv.id)?.number || ''} issued`); go('invoice/' + inv.id); });
    },
  });
  const upd = () => {
    const a = +document.getElementById('f_amount').value || 0, w = +document.getElementById('f_withholdingRate').value || 0;
    const tt = totals([{ qty: 1, price: a, discount: 0 }], w);
    document.getElementById('inv-preview').innerHTML = `Net ${money(tt.net)} + VAT ${money(tt.vat)} = <b>${money(tt.total)}</b>${tt.withheld ? ` − withholding ${money(tt.withheld)} → client pays <b>${money(tt.payable)}</b>` : ''}`;
  };
  const cs = document.getElementById('f_customerId');
  cs.onchange = () => { const cc = byId('customers', cs.value); document.getElementById('f_type').value = invoiceTypeFor(cc); document.getElementById('f_withholdingRate').value = withholdingFor(cc, +document.getElementById('f_amount').value || 0); upd(); };
  ['f_amount', 'f_withholdingRate'].forEach(i => { document.getElementById(i).oninput = upd; });
  document.getElementById('f_type').onchange = e => { if (e.target.value === '11.2') document.getElementById('f_withholdingRate').value = 0; upd(); };
  upd();
}
function invoiceInstallment(pid, iid) {
  const p = byId('projects', pid); const ins = p.installments.find(x => x.id === iid);
  if (ins.invoiceId) return go('invoice/' + ins.invoiceId);
  const amount = installmentAmount(p, ins);
  if (!(amount > 0)) return toast('This installment has no amount — set the phase fees first', 'err');
  invoiceForm({ title: `Invoice — ${ins.label}`, customerId: p.customerId, projectId: p.id, desc: `${p.name} — ${ins.label} (${num(ins.percent, 2)}% of the agreed fee)`, amount, installment: ins });
}
function newInvoice(preset = {}) {
  const p = byId('projects', preset.projectId);
  invoiceForm({ title: 'New invoice', customerId: preset.customerId || p?.customerId || '', projectId: preset.projectId || '', desc: p ? `${p.name} — ` : '', amount: 0 });
}

/* ---------- invoices list ---------- */
page('invoices', {
  title: 'Invoices',
  render() {
    const f = UI.invFilter || '';
    const rows = db.invoices.filter(i => !f || (f === 'mydata' ? i.mydata?.status !== 'transmitted' && !i.cancelled : f === 'open' ? ['unpaid', 'partial', 'overdue'].includes(invStatus(i)) : invStatus(i) === f)).sort((a, b) => b.date.localeCompare(a.date));
    const pendingMd = db.invoices.filter(i => i.mydata?.status !== 'transmitted' && !i.cancelled);
    const openInv = db.invoices.filter(i => !i.cancelled && balanceOf(i) > 0);
    const due = db.projects.filter(p => p.status !== 'cancelled').flatMap(p => (p.installments || []).filter(i => installmentDue(p, i)).map(i => ({ p, i })));
    return `<div class="kpis">
      ${kpi('Receivables', money(sum(openInv, balanceOf)), `${openInv.length} open`)}
      ${kpi('Overdue', money(sum(db.invoices.filter(i => invStatus(i) === 'overdue'), balanceOf)))}
      ${kpi('Installments due', due.length, money(sum(due, x => installmentAmount(x.p, x.i))) + ' net')}
      ${kpi('Not sent to myDATA', pendingMd.length)}
    </div>
    ${due.length ? card('Payment installments due', table([
      { label: 'Project', render: x => `<a href="#/project/${x.p.id}/payments"><b>${esc(x.p.name)}</b></a><br><small>${esc(nameOf('customers', x.p.customerId))}</small>` },
      { label: 'Installment', render: x => `${esc(x.i.label)} <small class="muted">(${num(x.i.percent, 2)}%)</small>` },
      { label: 'Due because', render: x => x.i.phaseId ? `“${esc(phaseOf(x.p, x.i.phaseId)?.name || '')}” is done` : fmtDate(x.i.dueDate) },
      { label: 'Amount (net)', cls: 'num', render: x => money(installmentAmount(x.p, x.i)) },
      { label: '', render: x => `<button class="btn sm primary" onclick="invoiceInstallment('${x.p.id}','${x.i.id}')">€ Invoice</button>` },
    ], due)) : ''}
    ${card('Invoices & receipts', table([
      { label: 'Number', render: i => `<b>${esc(i.number)}</b><br><small>${esc(INV_TYPES[i.type] || i.type)}</small>` },
      { label: 'Client', render: i => esc(nameOf('customers', i.customerId)) },
      { label: 'Project', render: i => `<small>${esc(byId('projects', i.projectId)?.name || '')}</small>` },
      { label: 'Date', render: i => fmtDate(i.date) },
      { label: 'Total', cls: 'num', render: i => money(i.total) },
      { label: 'To receive', cls: 'num', render: i => isCredit(i) ? '—' : money(payableOf(i)) },
      { label: 'Balance', cls: 'num', render: i => money(balanceOf(i)) },
      { label: 'Status', render: i => badge(invStatus(i)) },
      { label: 'myDATA', render: i => i.mydata?.status === 'transmitted' ? '<span class="badge b-transmitted">MARK ✓</span>' : i.cancelled ? '' : '<span class="badge b-pending">Pending</span>' },
    ], rows, { href: i => `invoice/${i.id}`, id: 'tbl-inv', empty: 'No invoices yet.' }),
      `<select onchange="UI.invFilter=this.value;rerender()">${[['', 'All'], ['open', 'Open (unpaid)'], ['overdue', 'Overdue'], ['paid', 'Paid'], ['mydata', 'Not sent to myDATA'], ['credit', 'Credit notes'], ['cancelled', 'Cancelled']].map(([v, l]) => `<option value="${v}" ${f === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
       ${searchBox('tbl-inv')} ${pendingMd.length ? `<button class="btn" onclick="mydataBatch()">Send ${pendingMd.length} to myDATA</button>` : ''} <button class="btn primary" onclick="newInvoice()">+ New invoice</button>`)}`;
  },
});

/* ---------- invoice page ---------- */
const MYDATA_MODE = { simulate: 'Simulation (nothing is sent to AADE)', test: 'AADE test environment', production: 'AADE production' };
const mandateWarning = inv => SYNC.integrations.mydata === 'production' && ['2.1', '5.1', '1.1'].includes(inv.type)
  ? `<div class="note warn"><b>Check before sending:</b> under the Greek B2B e-invoicing mandate (all businesses from 1 Oct 2026), B2B invoices and credit notes must be issued through a licensed e-invoicing provider or AADE's timologio app. Sending them only over the myDATA ERP channel may not be compliant — confirm with your accountant.</div>` : '';
page('invoice', {
  nav: 'invoices', perm: () => 'invoices', title: id => (INV_TYPES[byId('invoices', id)?.type] || 'Invoice').replace(/ \(.*\)/, '') + ' ' + (byId('invoices', id)?.number || ''),
  render(id) {
    const i = byId('invoices', id); if (!i) return notFound();
    const c = byId('customers', i.customerId); const p = byId('projects', i.projectId);
    const st = invStatus(i); const md = i.mydata || {}; const tx = md.status === 'transmitted';
    return `<div class="page-actions"><a class="btn" href="#/invoices">← Invoices</a><span class="spacer"></span>
      ${!tx && !i.cancelled ? `<button class="btn accent" onclick="mydataSend('${id}')">Send to myDATA</button>` : ''}
      ${balanceOf(i) > 0 && !i.cancelled ? `<button class="btn primary" onclick="recordPayment('${id}')">€ Record payment</button><button class="btn" onclick="paymentReminder('${id}')">✉ Reminder</button>` : ''}
      ${!i.cancelled && !isCredit(i) ? `<button class="btn" onclick="issueCreditNote('${id}')">↩ Credit note</button>` : ''}
      <button class="btn" onclick="invoiceEmail('${id}')">✉ Email</button>
      <button class="btn" onclick="printInvoice('${id}')">🖨 Print / PDF</button>
      ${!tx && !i.cancelled ? `<button class="btn danger" onclick="cancelInvoice('${id}')">Cancel</button>` : ''}
    </div>
    ${!tx && !i.cancelled ? mandateWarning(i) : ''}
    <div class="kpis">${kpi('Total', money(i.total))}${i.withheld ? kpi('Withholding', money(i.withheld), `${num(i.withholdingRate)}% of the net fee`) : ''}
      ${isCredit(i) ? kpi('Credits', `<a href="#/invoice/${i.creditOf}">${esc(byId('invoices', i.creditOf)?.number || '')}</a>`) : `${kpi('To receive', money(payableOf(i)))}${kpi('Paid', money(paidOf(i)))}${creditsOf(i).length ? kpi('Credited', money(creditedOf(i))) : ''}${kpi('Balance', money(balanceOf(i)))}`}${kpi('Status', badge(st))}</div>
    <div class="grid-2">
      ${card(INV_TYPES[i.type] || 'Invoice', `<dl class="dl"><dt>Client</dt><dd><a href="#/customer/${c?.id}">${esc(c?.name)}</a> · VAT ${esc(c?.vat || '—')}</dd>
        ${p ? `<dt>Project</dt><dd><a href="#/project/${p.id}/payments">${esc(p.name)}</a></dd>` : ''}
        ${i.installmentId && p ? `<dt>Installment</dt><dd>${esc(p.installments.find(x => x.id === i.installmentId)?.label || '')}</dd>` : ''}
        <dt>Date</dt><dd>${fmtDate(i.date)}</dd>${isCredit(i) ? `<dt>Reason</dt><dd>${esc(i.reason || '—')}</dd>` : `<dt>Due</dt><dd>${fmtDate(i.dueDate)}</dd>`}
        ${creditsOf(i).length ? `<dt>Credit notes</dt><dd>${creditsOf(i).map(cn => `<a href="#/invoice/${cn.id}">${esc(cn.number)}</a>`).join(', ')}</dd>` : ''}</dl>`)}
      ${card('myDATA (AADE)', tx ? `<dl class="dl"><dt>Status</dt><dd>${badge('transmitted')}${md.env === 'simulated' ? ' <span class="tag">simulation</span>' : md.env === 'test' ? ' <span class="tag">test environment</span>' : ''}</dd><dt>MARK</dt><dd class="mono">${esc(md.mark)}</dd><dt>UID</dt><dd class="mono sm">${esc(md.uid)}</dd><dt>Sent</dt><dd>${fmtDateTime(md.transmittedAt)}</dd></dl>`
        : `<p>${i.cancelled ? 'Cancelled.' : 'Not sent yet. myDATA returns a MARK (registration number).'}</p>${md.error ? `<p class="text-bad">Last attempt: ${esc(md.error)}</p>` : ''}<p class="muted sm">Connection: <b>${esc(MYDATA_MODE[SYNC.integrations.mydata] || 'Simulation')}</b>.</p>`)}
    </div>
    ${card('Lines', table([
      { label: 'Description', render: l => esc(l.desc) }, { label: 'Qty', cls: 'num', render: l => num(l.qty, 2) },
      { label: 'Fee', cls: 'num', render: l => money(l.price) }, { label: 'Amount', cls: 'num', render: l => money(lineNet(l)) },
    ], i.lines, { foot: `<tfoot><tr><td colspan="3">Net</td><td class="num">${money(i.net)}</td></tr><tr><td colspan="3">VAT ${db.settings.vatRate}%</td><td class="num">${money(i.vat)}</td></tr><tr><td colspan="3">Total</td><td class="num">${money(i.total)}</td></tr>${i.withheld ? `<tr><td colspan="3">Withholding tax ${num(i.withholdingRate)}%</td><td class="num">−${money(i.withheld)}</td></tr>` : ''}<tr class="grand"><td colspan="3">${isCredit(i) ? 'Credited' : 'To receive'}</td><td class="num">${money(payableOf(i))}</td></tr></tfoot>` }))}
    ${isCredit(i) ? '' : card('Payments', table([
      { label: 'Date', render: x => fmtDate(x.date) }, { label: 'Method', render: x => esc(x.method) }, { label: 'Amount', cls: 'num', render: x => money(x.amount) },
    ], i.payments, { empty: 'No payments recorded.' }))}`;
  },
});
async function mydataSend(id, silent) {
  if (!(await syncNow())) { if (!silent) toast('Could not save changes — try again', 'err'); return false; }
  try {
    const r = await api('/api/mydata/send', { method: 'POST', body: { invoiceId: id } });
    applyServerRecord('invoices', id, r.invoice, r.version);
    const md = r.invoice.mydata || {};
    if (!silent) { if (md.status === 'transmitted') toast(`Registered in myDATA${md.env === 'simulated' ? ' (simulation)' : ''} — MARK ${md.mark}`); else toast('myDATA rejected: ' + (md.error || 'unknown error'), 'err'); rerender(); }
    return md.status === 'transmitted';
  } catch (e) { if (!silent) toast(e.message, 'err'); return false; }
}
async function mydataBatch() {
  const list = db.invoices.filter(i => i.mydata?.status !== 'transmitted' && !i.cancelled).sort((a, b) => (isCredit(a) - isCredit(b)) || a.date.localeCompare(b.date));
  toast(`Sending ${list.length} document(s) to myDATA…`);
  let ok = 0; for (const i of list) if (await mydataSend(i.id, true)) ok++;
  toast(`${ok} registered in myDATA${list.length - ok ? `, ${list.length - ok} rejected (open them to see why)` : ''}`, list.length - ok ? 'warn' : 'ok'); rerender();
}
function recordPayment(id) {
  const inv = byId('invoices', id);
  openForm({
    title: `Payment for ${inv.number}`,
    fields: [{ name: 'amount', label: 'Amount received (€)', type: 'number', required: true }, { name: 'date', label: 'Date', type: 'date', required: true },
      { name: 'method', label: 'Method', type: 'select', options: [['bank transfer', 'Bank transfer'], ['card', 'Card'], ['cash', 'Cash'], ['cheque', 'Cheque']] }],
    values: { amount: balanceOf(inv), date: today() },
    extra: inv.withheld ? `<p class="muted sm">The client withholds ${money(inv.withheld)} and pays it to the tax office, so you receive ${money(payableOf(inv))} in total.</p>` : '',
    onSave: d => { if (!(d.amount > 0)) return toast('Amount must be positive', 'err'); inv.payments.push({ id: uid(), ...d }); saveDB(); toast('Payment recorded'); rerender(); },
  });
}
function paymentReminder(id) {
  const inv = byId('invoices', id); const c = byId('customers', inv.customerId);
  if (!c?.email) return toast('The client has no email address', 'err');
  sendTemplate('paymentReminder', c.email, { customer: c.name, number: inv.number, total: money(balanceOf(inv)), date: fmtDate(inv.dueDate) }, inv.number, c.id);
  saveDB(); toast('Reminder email queued'); rerender();
}
function invoiceEmail(id) {
  const inv = byId('invoices', id); const c = byId('customers', inv.customerId);
  if (!c?.email) return toast('The client has no email address', 'err');
  if (isCredit(inv)) sendTemplate('creditNote', c.email, { customer: c.name, number: inv.number, total: money(inv.total), date: byId('invoices', inv.creditOf)?.number || '' }, inv.number, c.id);
  else sendTemplate('invoiceIssued', c.email, { customer: c.name, number: inv.number, total: money(payableOf(inv)), date: fmtDate(inv.dueDate) }, inv.number, c.id);
  saveDB(); toast(`Email queued to ${c.email}`);
}
function printInvoice(id) {
  const inv = byId('invoices', id); const md = inv.mydata || {}; const c = db.settings.company; const cust = byId('customers', inv.customerId); const p = byId('projects', inv.projectId);
  printHTML(`<div class="print-doc">
    <header><div><h1>${esc(c.name)}</h1><div>${esc(c.address)}<br>VAT ${esc(c.vat)} · Tax office ${esc(c.taxOffice || '')}<br>${esc(c.phone)} · ${esc(c.email)}</div></div>
    <div class="pd-title"><h2>${esc((INV_TYPES[inv.type] || 'Invoice').replace(/ \(.*\)/, ''))}</h2><div>No. <b>${esc(inv.number)}</b><br>Date ${fmtDate(inv.date)}${isCredit(inv) ? '' : `<br>Due ${fmtDate(inv.dueDate)}`}</div></div></header>
    <section class="pd-party"><small>To</small><br><b>${esc(cust?.name || '')}</b><br>${esc(cust?.address || '')} ${esc(cust?.postalCode || '')} ${esc(cust?.city || '')}<br>${cust?.vat ? 'VAT ' + esc(cust.vat) + (cust.taxOffice ? ' · ' + esc(cust.taxOffice) : '') : ''}</section>
    ${p ? `<p><b>Project:</b> ${esc(p.name)}${p.siteAddress ? ' · ' + esc(p.siteAddress) : ''}</p>` : ''}
    <table><thead><tr><th>Description</th><th class="num">Amount</th></tr></thead><tbody>${inv.lines.map(l => `<tr><td>${esc(l.desc)}</td><td class="num">${money(lineNet(l))}</td></tr>`).join('')}</tbody></table>
    <table class="pd-totals"><tr><td>Net</td><td>${money(inv.net)}</td></tr><tr><td>VAT ${db.settings.vatRate}%</td><td>${money(inv.vat)}</td></tr><tr><td>Total</td><td>${money(inv.total)}</td></tr>
      ${inv.withheld ? `<tr><td>Withholding ${num(inv.withholdingRate)}%</td><td>−${money(inv.withheld)}</td></tr>` : ''}<tr class="grand"><td>${isCredit(inv) ? 'Credited' : 'Payable'}</td><td>${money(payableOf(inv))}</td></tr></table>
    ${isCredit(inv) ? `<p class="pd-notes">Credit note for ${esc(byId('invoices', inv.creditOf)?.number || '')}${inv.reason ? ' — ' + esc(inv.reason) : ''}</p>` : ''}
    ${md.mark ? `<div class="pd-mydata">myDATA MARK: <b>${esc(md.mark)}</b><br>UID: ${esc(md.uid)}${md.env === 'simulated' ? '<br>(simulation — not registered with AADE)' : ''}</div>` : ''}
    <p class="pd-foot">IBAN ${esc(c.iban || '')}</p></div>`);
}
function cancelInvoice(id) {
  confirmBox('Cancel this invoice? (Documents already registered in myDATA need a credit note instead.)', () => {
    const inv = byId('invoices', id); inv.cancelled = true;
    for (const p of db.projects) for (const ins of p.installments || []) if (ins.invoiceId === id) ins.invoiceId = '';
    saveDB(); rerender();
  }, 'Cancel invoice');
}
function issueCreditNote(id) {
  const inv = byId('invoices', id);
  const credited = sum(creditsOf(inv), c => c.net);
  const left = round2(inv.net - credited);
  if (left <= 0) return toast('This invoice has already been fully credited', 'warn');
  openForm({
    title: `Credit note for ${inv.number}`,
    fields: [{ name: 'amount', label: `Amount to credit (€ net, up to ${money(left)})`, type: 'number', required: true }, { name: 'reason', label: 'Reason', full: true, required: true, list: ['Fee reduction', 'Scope change', 'Invoicing error', 'Project cancelled'] }],
    values: { amount: left },
    saveLabel: 'Issue credit note',
    onSave: d => {
      const amount = Math.min(left, +d.amount || 0); if (!(amount > 0)) return toast('Enter an amount', 'err');
      const lines = [{ desc: `Credit for ${inv.number}: ${d.reason}`, qty: 1, unit: 'service', price: amount, discount: 0 }];
      const type = inv.type === '11.2' || inv.type === '11.1' ? '11.4' : '5.1';
      const cn = { id: uid(), number: nextNo('credit'), type, creditOf: inv.id, customerId: inv.customerId, projectId: inv.projectId, date: today(), dueDate: today(), paymentMethod: inv.paymentMethod || 'bank',
        withholdingRate: inv.withholdingRate || 0, lines, ...totals(lines, inv.withholdingRate || 0), payments: [], mydata: { status: 'pending' }, reason: d.reason };
      db.invoices.push(cn);
      const c = byId('customers', inv.customerId);
      if (c?.email) autoEmail('creditNote', c.email, { customer: c.name, number: cn.number, total: money(cn.total), date: inv.number }, cn.number, c.id);
      saveDB(); syncNow().then(() => go('invoice/' + cn.id));
    },
  });
}

/* ---------- expenses ---------- */
const expenseBalance = e => round2(e.total - expensePaid(e));
const expenseStatus = e => expenseBalance(e) <= 0.005 ? 'paid' : e.dueDate && e.dueDate < today() ? 'overdue' : expensePaid(e) > 0 ? 'partial' : 'unpaid';
function expensesTable(rows) {
  return table([
    { label: 'Date', render: e => `${fmtDate(e.date)}<br><small class="muted">${esc(e.number || '')}</small>` },
    { label: 'Collaborator / payee', render: e => e.supplierId ? `<a href="#/supplier/${e.supplierId}">${esc(nameOf('suppliers', e.supplierId))}</a>` : '<span class="muted">—</span>' },
    { label: 'Project', render: e => e.projectId ? `<a href="#/project/${e.projectId}/expenses">${esc(byId('projects', e.projectId)?.name || '')}</a>` : '<span class="muted">Office</span>' },
    { label: 'Description', render: e => `${esc(e.description || '')}<br><small class="muted">${esc(e.category || '')}${e.ref ? ' · ' + esc(e.ref) : ''}</small>` },
    { label: 'Net', cls: 'num', render: e => money(e.net) }, { label: 'Total', cls: 'num', render: e => money(e.total) },
    { label: 'Paid', cls: 'num', render: e => money(expensePaid(e)) },
    { label: 'Status', render: e => badge(expenseStatus(e)) },
    { label: '', render: e => `${expenseBalance(e) > 0 ? `<button class="btn xs primary" onclick="payExpense('${e.id}')">Pay</button> ` : ''}<button class="btn xs" onclick="editExpense('${e.id}')">Edit</button>` },
  ], rows, { empty: 'No expenses.' });
}
function editExpense(id, preset = {}) {
  const e = id ? byId('expenses', id) : { date: today(), vatRate: 24, category: '', ...preset };
  openForm({
    title: id ? 'Edit expense / bill' : 'New expense / bill', wide: true, values: e,
    fields: [
      { name: 'date', label: 'Date', type: 'date', required: true },
      { name: 'dueDate', label: 'Due date', type: 'date' },
      { name: 'supplierId', label: 'Collaborator / payee', type: 'select', options: pairs(db.suppliers, s => s.name, '— none —') },
      { name: 'projectId', label: 'Project', type: 'select', options: pairs(db.projects, projectLabel, '— office expense —') },
      { name: 'category', label: 'Category', list: db.settings.expenseCategories },
      { name: 'ref', label: 'Their invoice no.' },
      { name: 'description', label: 'Description', required: true, full: true },
      { name: 'net', label: 'Net amount (€)', type: 'number', required: true },
      { name: 'vatRate', label: 'VAT %', type: 'select', options: [['24', '24%'], ['13', '13%'], ['6', '6%'], ['0', '0% / not applicable']] },
    ],
    buttons: id ? [{ label: 'Delete', danger: true, onClick: () => { db.expenses = db.expenses.filter(x => x.id !== id); saveDB(); rerender(); } }] : [],
    onSave: d => {
      if (!(d.net > 0)) return toast('Enter the net amount', 'err');
      const rate = +d.vatRate || 0;
      const vals = { ...d, vatRate: rate, vat: round2(d.net * rate / 100), total: round2(d.net * (1 + rate / 100)) };
      if (id) Object.assign(e, vals); else db.expenses.push({ id: uid(), number: nextNo('expense'), payments: [], ...vals });
      saveDB(); rerender(); toast('Expense saved');
    },
  });
}
function payExpense(id) {
  const e = byId('expenses', id);
  openForm({
    title: `Payment — ${e.description}`, values: { amount: expenseBalance(e), date: today() },
    fields: [{ name: 'amount', label: 'Amount paid (€)', type: 'number', required: true }, { name: 'date', label: 'Date', type: 'date', required: true },
      { name: 'method', label: 'Method', type: 'select', options: [['bank transfer', 'Bank transfer'], ['cash', 'Cash'], ['card', 'Card']] }],
    onSave: d => { if (!(d.amount > 0)) return toast('Amount must be positive', 'err'); (e.payments = e.payments || []).push({ id: uid(), ...d }); saveDB(); rerender(); toast('Payment recorded'); },
  });
}
page('expenses', {
  title: 'Expenses',
  render() {
    const fp = UI.expProject || '', fs = UI.expStatus || '';
    const rows = db.expenses.filter(e => (!fp || (fp === 'office' ? !e.projectId : e.projectId === fp)) && (!fs || (fs === 'open' ? expenseBalance(e) > 0 : expenseStatus(e) === fs))).sort((a, b) => b.date.localeCompare(a.date));
    const year = today().slice(0, 4);
    const open = db.expenses.filter(e => expenseBalance(e) > 0);
    return `<div class="kpis">${kpi(`Expenses ${year}`, money(sum(db.expenses.filter(e => e.date.startsWith(year)), e => e.net)), 'net')}${kpi('Unpaid', money(sum(open, expenseBalance)), `${open.length} bills`)}</div>` +
      card('Expenses & collaborator bills', expensesTable(rows),
        `<select onchange="UI.expProject=this.value;rerender()"><option value="">All projects</option><option value="office" ${fp === 'office' ? 'selected' : ''}>Office expenses</option>${opt(db.projects, fp, { label: projectLabel })}</select>
         <select onchange="UI.expStatus=this.value;rerender()"><option value="">All</option><option value="open" ${fs === 'open' ? 'selected' : ''}>Unpaid</option><option value="paid" ${fs === 'paid' ? 'selected' : ''}>Paid</option></select>
         <button class="btn primary" onclick="editExpense()">+ Expense</button>`);
  },
});

/* ---------- collaborators ---------- */
/** One row per collaborator × project: agreed, billed, paid, outstanding. */
function collaboratorRows(filter = {}) {
  const out = [];
  for (const p of db.projects) {
    const ids = new Set([...(p.collaborators || []).map(c => c.supplierId), ...db.expenses.filter(e => e.projectId === p.id && e.supplierId).map(e => e.supplierId)]);
    for (const sid of ids) {
      if (filter.supplierId && sid !== filter.supplierId) continue;
      const c = (p.collaborators || []).find(x => x.supplierId === sid) || { supplierId: sid, role: '', agreedFee: 0 };
      out.push({ p, s: byId('suppliers', sid), c, ...collabFigures(p, c) });
    }
  }
  const officeBills = db.expenses.filter(e => !e.projectId && e.supplierId && (!filter.supplierId || e.supplierId === filter.supplierId));
  for (const [sid, bills] of groupBy(officeBills, e => e.supplierId)) {
    out.push({ p: null, s: byId('suppliers', sid), c: { supplierId: sid, role: 'Office', agreedFee: 0 }, bills, billed: sum(bills, e => e.net), billedGross: sum(bills, e => e.total), paid: sum(bills, expensePaid), unpaidBills: round2(sum(bills, e => e.total) - sum(bills, expensePaid)), remaining: 0 });
  }
  return out;
}
function collaboratorTable(rows, { showCollaborator = true, showProject = true } = {}) {
  return table([
    ...(showCollaborator ? [{ label: 'Collaborator', render: r => `<a href="#/supplier/${r.s?.id}"><b>${esc(r.s?.name || '—')}</b></a><br><small>${esc(r.s?.specialty || '')}</small>` }] : []),
    ...(showProject ? [{ label: 'Project', render: r => r.p ? `<a href="#/project/${r.p.id}/collaborators">${esc(r.p.name)}</a><br><small>${esc(r.p.number)}</small>` : '<span class="muted">Office</span>' }] : []),
    { label: 'Role', render: r => esc(r.c.role || '') },
    { label: 'Agreed fee', cls: 'num', render: r => money(r.c.agreedFee) },
    { label: 'Billed (net)', cls: 'num', render: r => money(r.billed) },
    { label: 'Billed incl. VAT', cls: 'num', render: r => money(r.billedGross) },
    { label: 'Paid', cls: 'num', render: r => money(r.paid) },
    { label: 'Unpaid bills', cls: 'num', render: r => `<span class="${r.unpaidBills > 0 ? 'text-warn' : ''}">${money(r.unpaidBills)}</span>` },
    { label: 'Still to bill', cls: 'num', render: r => money(Math.max(0, r.remaining)) },
  ], rows, {
    empty: 'Nothing recorded yet.',
    foot: rows.length ? `<tfoot><tr><td colspan="${1 + showCollaborator + showProject}">Total</td><td class="num">${money(sum(rows, r => +r.c.agreedFee || 0))}</td><td class="num">${money(sum(rows, r => r.billed))}</td><td class="num">${money(sum(rows, r => r.billedGross))}</td><td class="num">${money(sum(rows, r => r.paid))}</td><td class="num">${money(sum(rows, r => r.unpaidBills))}</td><td class="num">${money(sum(rows, r => Math.max(0, r.remaining)))}</td></tr></tfoot>` : '',
  });
}
function exportCollaboratorCSV(supplierId) {
  const rows = collaboratorRows({ supplierId });
  const lines = [['Collaborator', 'Specialty', 'Project no.', 'Project', 'Role', 'Agreed fee', 'Billed net', 'Billed incl. VAT', 'Paid', 'Unpaid bills', 'Still to bill']];
  for (const r of rows) lines.push([r.s?.name, r.s?.specialty, r.p?.number || '', r.p?.name || 'Office', r.c.role, +r.c.agreedFee || 0, r.billed, r.billedGross, r.paid, r.unpaidBills, Math.max(0, r.remaining)]);
  lines.push([]); lines.push(['Payments']); lines.push(['Collaborator', 'Project', 'Bill date', 'Their invoice', 'Description', 'Payment date', 'Amount', 'Method']);
  for (const r of rows) for (const b of r.bills) for (const x of b.payments || []) lines.push([r.s?.name, r.p?.name || 'Office', b.date, b.ref || '', b.description, x.date, x.amount, x.method]);
  downloadFile(`collaborator-payments${supplierId ? '-' + (byId('suppliers', supplierId)?.name || '') : ''}-${today()}.csv`, toCSV(lines), 'text/csv');
}
page('suppliers', {
  title: 'Collaborators',
  render() {
    const all = collaboratorRows();
    return card(`Collaborators (${db.suppliers.length})`, table([
      { label: 'Name', render: s => `<b>${esc(s.name)}</b><br><small>${esc(s.kind || '')}</small>` },
      { label: 'Specialty', render: s => esc(s.specialty || '') },
      { label: 'Contact', render: s => `${esc(s.email || '')}<br><small>${esc(s.phone || '')}</small>` },
      { label: 'Projects', cls: 'num', render: s => all.filter(r => r.s?.id === s.id && r.p).length },
      ...(can('expenses') ? [
        { label: 'Agreed', cls: 'num', render: s => money(sum(all.filter(r => r.s?.id === s.id), r => +r.c.agreedFee || 0)) },
        { label: 'Paid', cls: 'num', render: s => money(sum(all.filter(r => r.s?.id === s.id), r => r.paid)) },
        { label: 'Unpaid bills', cls: 'num', render: s => { const v = sum(all.filter(r => r.s?.id === s.id), r => r.unpaidBills); return `<span class="${v > 0 ? 'text-warn' : ''}">${money(v)}</span>`; } },
      ] : []),
    ], db.suppliers, { href: s => `supplier/${s.id}`, id: 'tbl-s', empty: 'No collaborators yet.' }),
      `${searchBox('tbl-s')} ${can('expenses') ? '<a class="btn" href="#/reports/collaborators">Payments report</a>' : ''} <button class="btn primary" onclick="editSupplier()">+ New collaborator</button>`);
  },
});
function editSupplier(id, after) {
  const s = id ? byId('suppliers', id) : { kind: 'Person' };
  openForm({
    title: id ? 'Edit collaborator' : 'New collaborator', values: s, wide: true,
    fields: [
      { name: 'name', label: 'Name', required: true, full: true },
      { name: 'kind', label: 'Person or firm', type: 'select', options: [['Person', 'Person'], ['Company', 'Firm']] },
      { name: 'specialty', label: 'Specialty', list: db.settings.expenseCategories },
      { name: 'vat', label: 'VAT number' }, { name: 'email', label: 'Email', type: 'email' }, { name: 'phone', label: 'Phone' }, { name: 'city', label: 'City' },
      { name: 'iban', label: 'IBAN (for payments)', full: true },
      { name: 'notes', label: 'Notes', type: 'textarea', full: true },
    ],
    onSave: d => {
      if (id) Object.assign(s, d); else { const n = { id: uid(), ...d }; db.suppliers.push(n); if (after) setTimeout(() => after(n)); }
      saveDB(); rerender(); toast('Collaborator saved');
    },
  });
}
page('supplier', {
  nav: 'suppliers', perm: () => 'suppliers', title: id => nameOf('suppliers', id, 'Collaborator'),
  render(id) {
    const s = byId('suppliers', id); if (!s) return notFound();
    const rows = collaboratorRows({ supplierId: id });
    const bills = db.expenses.filter(e => e.supplierId === id).sort((a, b) => b.date.localeCompare(a.date));
    const money_ = can('expenses');
    return `<div class="page-actions"><a class="btn" href="#/suppliers">← Collaborators</a><span class="spacer"></span>
      ${money_ ? `<button class="btn" onclick="editExpense(null,{supplierId:'${id}',category:'${esc(s.specialty || '')}'})">+ Bill</button><button class="btn" onclick="exportCollaboratorCSV('${id}')">⬇ Export CSV</button><button class="btn" onclick="printCollaborator('${id}')">🖨 Statement</button>` : ''}
      <button class="btn" onclick="editSupplier('${id}')">Edit</button></div>
    ${money_ ? `<div class="kpis">${kpi('Agreed fees', money(sum(rows, r => +r.c.agreedFee || 0)))}${kpi('Billed (net)', money(sum(rows, r => r.billed)))}${kpi('Paid', money(sum(rows, r => r.paid)))}${kpi('Unpaid bills', money(sum(rows, r => r.unpaidBills)))}</div>` : ''}
    ${card('Details', `<dl class="dl"><dt>Type</dt><dd>${esc(s.kind || '')}</dd><dt>Specialty</dt><dd>${esc(s.specialty || '')}</dd><dt>VAT</dt><dd>${esc(s.vat || '')}</dd><dt>Email</dt><dd>${esc(s.email || '')}</dd><dt>Phone</dt><dd>${esc(s.phone || '')}</dd>${s.iban ? `<dt>IBAN</dt><dd class="mono">${esc(s.iban)}</dd>` : ''}${s.notes ? `<dt>Notes</dt><dd>${esc(s.notes)}</dd>` : ''}</dl>`)}
    ${card('Per project', money_ ? collaboratorTable(rows, { showCollaborator: false }) : table([{ label: 'Project', render: r => r.p ? esc(r.p.name) : 'Office' }, { label: 'Role', render: r => esc(r.c.role || '') }], rows))}
    ${money_ ? card('Bills & payments', expensesTable(bills)) : ''}`;
  },
});
function printCollaborator(id) {
  const s = byId('suppliers', id); const rows = collaboratorRows({ supplierId: id }); const c = db.settings.company;
  printHTML(`<div class="print-doc"><header><div><h1>${esc(c.name)}</h1><div>${esc(c.address)}</div></div><div class="pd-title"><h2>Collaborator statement</h2><div>${esc(s.name)}<br>${fmtDate(today())}</div></div></header>
    <table><thead><tr><th>Project</th><th>Role</th><th class="num">Agreed</th><th class="num">Billed (net)</th><th class="num">Paid</th><th class="num">Unpaid bills</th></tr></thead>
    <tbody>${rows.map(r => `<tr><td>${esc(r.p?.name || 'Office')}</td><td>${esc(r.c.role || '')}</td><td class="num">${money(r.c.agreedFee)}</td><td class="num">${money(r.billed)}</td><td class="num">${money(r.paid)}</td><td class="num">${money(r.unpaidBills)}</td></tr>`).join('')}</tbody></table>
    <h3>Payments</h3><table><thead><tr><th>Date</th><th>Project</th><th>For</th><th class="num">Amount</th></tr></thead><tbody>
    ${rows.flatMap(r => r.bills.flatMap(b => (b.payments || []).map(x => `<tr><td>${fmtDate(x.date)}</td><td>${esc(r.p?.name || 'Office')}</td><td>${esc(b.description)}${b.ref ? ' (' + esc(b.ref) + ')' : ''}</td><td class="num">${money(x.amount)}</td></tr>`))).join('')}</tbody></table></div>`);
}
