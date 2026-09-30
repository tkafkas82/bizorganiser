'use strict';
/* =========================================================================
   Default settings and demo data — an architectural office
   ========================================================================= */

function defaultSettings() {
  return {
    company: { name: 'Demo Architects', vat: 'EL099999999', taxOffice: 'Athens A', email: 'studio@demoarchitects.example', phone: '+30 210 000 0000', address: '1 Example Street, 10000 Athens', iban: 'GR00 0000 0000 0000 0000 0000 000' },
    vatRate: 24,
    withholdingRate: 20,            // % withheld by business clients on professional fees
    withholdingThreshold: 300,      // applies when the net fee exceeds this amount
    withholdingCategory: 3,         // myDATA withheldPercentCategory for 20% fees
    defaultHourlyCost: 25,          // € per hour, used for project profitability when a person has no own rate
    prefixes: { quote: 'PR', project: 'PRJ', invoice: 'INV', receipt: 'REC', credit: 'CN', expense: 'EXP' },
    projectTypes: ['New residence', 'Renovation', 'Interior design', 'Commercial building', 'Holiday home', 'Legalisation of unauthorised works', 'Energy upgrade', 'Urban planning study'],
    phaseTemplates: ['Survey & brief', 'Preliminary design', 'Final design', 'Building permit', 'Construction drawings', 'Site supervision'],
    paymentTemplates: [{ label: 'On signing the contract', percent: 30 }, { label: 'On building permit issue', percent: 40 }, { label: 'On handover', percent: 30 }],
    expenseCategories: ['Structural engineer', 'MEP engineer', 'Surveyor / topography', 'Printing & models', 'Permit fees & TEE', 'Travel', 'Software & licences', 'Other'],
    clientTypes: ['Individual', 'Company', 'Public sector'],
    automations: { quoteSent: true, invoiceIssued: true, paymentReminder: true, creditNote: true },
    templates: {
      quoteSent: { name: 'Fee proposal sent', subject: 'Fee proposal {{number}} — {{project}}', body: 'Dear {{customer}},\n\nPlease find attached our fee proposal {{number}} for "{{project}}", totalling {{total}} (incl. VAT), valid until {{date}}.\n\nWe would be happy to discuss it with you.\n\nKind regards,\n{{company}}' },
      invoiceIssued: { name: 'Invoice issued', subject: 'Invoice {{number}}', body: 'Dear {{customer}},\n\nInvoice {{number}} for {{total}} has been issued, due on {{date}}.\n\nKind regards,\n{{company}}' },
      paymentReminder: { name: 'Payment reminder', subject: 'Payment reminder — invoice {{number}}', body: 'Dear {{customer}},\n\nOur records show an open balance of {{total}} on invoice {{number}}, due {{date}}. Please arrange payment at your earliest convenience.\n\nKind regards,\n{{company}}' },
      creditNote: { name: 'Credit note issued', subject: 'Credit note {{number}}', body: 'Dear {{customer}},\n\nWe have issued credit note {{number}} for {{total}}, crediting invoice {{date}}.\n\nKind regards,\n{{company}}' },
    },
  };
}

function seedDB(empty = false) {
  let s = 20261001;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const pick = a => a[Math.floor(rnd() * a.length)];
  const rint = (a, b) => a + Math.floor(rnd() * (b - a + 1));

  const d = {
    version: 2, counters: {}, settings: defaultSettings(), session: { userId: 'u1' },
    users: [
      { id: 'u1', name: 'Admin User', email: 'admin@demoarchitects.example', role: 'admin' },
      { id: 'u2', name: 'Eleni (Architect)', email: 'eleni@demoarchitects.example', role: 'architect' },
      { id: 'u3', name: 'Nikos (Architect)', email: 'nikos@demoarchitects.example', role: 'architect' },
      { id: 'u4', name: 'Anna (Accounting)', email: 'accounts@demoarchitects.example', role: 'accounting' },
    ],
    team: [], customers: [], suppliers: [], activities: [], quotes: [], projects: [], tasks: [], timeEntries: [], invoices: [], expenses: [], emails: [],
  };
  if (empty) return d;
  const prev = db; db = d;
  const t = today();

  d.team = [
    { id: 'u1', title: 'Principal architect', hourlyCost: 45 },
    { id: 'u2', title: 'Architect', hourlyCost: 28 },
    { id: 'u3', title: 'Architect', hourlyCost: 26 },
    { id: 'u4', title: 'Office manager', hourlyCost: 20 },
  ];
  const C = (id, name, type, city, extra = {}) => ({
    id, name, type, vat: type === 'Individual' ? '' : 'EL' + String(100000000 + rint(0, 899999999)),
    email: name.toLowerCase().replace(/[^a-z]+/g, '.').replace(/^\.|\.$/g, '') + '@example.com', phone: '+30 69' + rint(10000000, 99999999),
    address: `${rint(1, 120)} ${pick(['Ermou', 'Solonos', 'Vas. Sofias', 'Kifisias', 'Tsimiski'])} St`, city, postalCode: String(rint(10431, 85100)),
    notes: '', createdAt: addDays(t, -rint(60, 700)), ...extra,
  });
  d.customers = [
    C('c1', 'Georgios & Maria Papadakis', 'Individual', 'Athens'),
    C('c2', 'Aegean Boutique Hotels SA', 'Company', 'Mykonos'),
    C('c3', 'Dimitra Karagianni', 'Individual', 'Thessaloniki'),
    C('c4', 'Olive Grove Developments Ltd', 'Company', 'Kalamata'),
    C('c5', 'Municipality of Nea Smyrni', 'Public sector', 'Athens'),
    C('c6', 'Andreas Vlachos', 'Individual', 'Chania'),
  ];
  d.suppliers = [
    { id: 's1', name: 'StructCalc Engineers', kind: 'Company', specialty: 'Structural engineer', vat: 'EL800000001', email: 'office@structcalc.example', phone: '+30 210 111 1111', city: 'Athens', iban: '', notes: '' },
    { id: 's2', name: 'Maria Ioannou', kind: 'Person', specialty: 'MEP engineer', vat: 'EL800000002', email: 'ioannou@mep.example', phone: '+30 210 222 2222', city: 'Athens', iban: '', notes: '' },
    { id: 's3', name: 'Petros Galanis', kind: 'Person', specialty: 'Surveyor / topography', vat: 'EL800000003', email: 'galanis@survey.example', phone: '+30 210 333 3333', city: 'Piraeus', iban: '', notes: '' },
    { id: 's4', name: 'PrintLab Plotting', kind: 'Company', specialty: 'Printing & models', vat: 'EL800000004', email: 'orders@printlab.example', phone: '+30 210 444 4444', city: 'Athens', iban: '', notes: '' },
  ];

  const phasesFor = (fee, names, doneCount, start) => {
    const weights = { 'Survey & brief': 0.08, 'Preliminary design': 0.2, 'Final design': 0.22, 'Building permit': 0.15, 'Construction drawings': 0.2, 'Site supervision': 0.15 };
    const sumW = names.reduce((a, n) => a + (weights[n] || 0.15), 0);
    return names.map((n, i) => ({ id: uid(), name: n, fee: Math.round(fee * (weights[n] || 0.15) / sumW / 10) * 10, status: i < doneCount ? 'done' : i === doneCount ? 'progress' : 'todo', dueDate: addDays(start, 30 * (i + 1)), budgetHours: Math.round(fee * (weights[n] || 0.15) / sumW / 40) }));
  };
  const P = (id, name, cid, type, fee, doneCount, startOff, extra = {}) => {
    const start = addDays(t, -startOff);
    const names = extra.names || d.settings.phaseTemplates;
    const phases = phasesFor(fee, names, doneCount, start);
    const total = phases.reduce((a, p) => a + p.fee, 0);
    const permitIdx = names.indexOf('Building permit');
    const installments = [
      { id: uid(), label: 'On signing the contract', percent: 30, phaseId: '', dueDate: start, invoiceId: '' },
      { id: uid(), label: 'On building permit issue', percent: 40, phaseId: permitIdx >= 0 ? phases[permitIdx].id : phases[Math.floor(phases.length / 2)].id, dueDate: '', invoiceId: '' },
      { id: uid(), label: 'On handover', percent: 30, phaseId: phases[phases.length - 1].id, dueDate: '', invoiceId: '' },
    ];
    return {
      id, number: nextNo('project'), name, customerId: cid, type, status: doneCount >= phases.length ? 'completed' : 'active',
      siteAddress: `${rint(1, 90)} ${pick(['Anemomylon', 'Thalassis', 'Elias', 'Akropoleos'])} St`, city: byId('customers', cid).city,
      kaek: String(rint(100000000, 999999999)) + String(rint(100, 999)), permitNo: doneCount > permitIdx && permitIdx >= 0 ? `${rint(100, 999)}/${t.slice(0, 4)}` : '', permitDate: '',
      area: rint(80, 900), constructionBudget: Math.round(total * rint(9, 14) / 1000) * 1000, startDate: start, dueDate: phases[phases.length - 1].dueDate,
      managerId: pick(['u1', 'u2', 'u3']), team: ['u1', pick(['u2', 'u3'])], phases, installments, files: [], links: [{ id: uid(), title: 'Drawings folder (shared drive)', url: 'https://example.com/drive/' + id, shared: false }], notes: '', ...extra.more,
    };
  };
  d.projects = [
    P('p1', 'Papadakis family house, Vari', 'c1', 'New residence', 24000, 3, 150),
    P('p2', 'Hotel Aegean — 12 suites renovation', 'c2', 'Renovation', 68000, 2, 120),
    P('p3', 'Apartment interior, Kalamaria', 'c3', 'Interior design', 9000, 1, 45, { names: ['Survey & brief', 'Preliminary design', 'Final design', 'Construction drawings'] }),
    P('p4', 'Olive Grove villas masterplan', 'c4', 'Commercial building', 42000, 1, 60),
    P('p5', 'Public library energy upgrade', 'c5', 'Energy upgrade', 15000, 6, 320),
  ];
  // invoices for installments that are due
  for (const p of d.projects) {
    const fee = p.phases.reduce((a, x) => a + x.fee, 0);
    const cust = byId('customers', p.customerId);
    for (const ins of p.installments) {
      const trig = p.phases.find(x => x.id === ins.phaseId);
      const due = ins.phaseId ? trig && trig.status === 'done' : true;
      if (!due) continue;
      const date = ins.phaseId ? addDays(trig.dueDate, 2) > t ? addDays(t, -rint(1, 10)) : addDays(trig.dueDate, 2) : addDays(p.startDate, 1);
      const lines = [{ desc: `${p.name} — ${ins.label} (${ins.percent}% of fee)`, qty: 1, unit: 'service', price: Math.round(fee * ins.percent) / 100, discount: 0 }];
      const wh = cust.type !== 'Individual' ? d.settings.withholdingRate : 0;
      const inv = { id: uid(), number: nextNo(cust.type === 'Individual' ? 'receipt' : 'invoice'), type: cust.type === 'Individual' ? '11.2' : '2.1', customerId: cust.id, projectId: p.id, installmentId: ins.id,
        date, dueDate: addDays(date, 15), paymentMethod: 'bank', withholdingRate: wh, lines, ...totals(lines, wh), payments: [], mydata: { status: 'pending' } };
      if (daysBetween(date, t) > 20) inv.payments.push({ id: uid(), date: addDays(date, rint(3, 18)), amount: inv.payable, method: 'bank transfer' });
      if (daysBetween(date, t) > 10) inv.mydata = fakeMark(date);
      d.invoices.push(inv); ins.invoiceId = inv.id;
    }
  }
  // tasks
  const taskTitles = ['Site visit and photos', 'Update floor plans', 'Coordinate with structural engineer', 'Prepare 3D views for client', 'Submit documents to e-Adeies', 'Material samples meeting', 'Revise facade', 'Energy study inputs (KENAK)', 'Bill of quantities', 'Check fire safety requirements'];
  for (const p of d.projects.filter(x => x.status === 'active')) {
    const ph = p.phases.find(x => x.status === 'progress') || p.phases[0];
    for (let i = 0; i < rint(2, 4); i++) d.tasks.push({ id: uid(), projectId: p.id, phaseId: ph.id, title: pick(taskTitles), assigneeId: pick(p.team), dueDate: addDays(t, rint(-3, 14)), status: pick(['todo', 'todo', 'progress', 'done']), priority: rnd() < 0.2 ? 'high' : 'normal', notes: '' });
  }
  // time entries over the last 8 weeks
  for (let day = 56; day >= 0; day--) {
    const date = addDays(t, -day); const wd = parseD(date).getDay(); if (wd === 0 || wd === 6) continue;
    for (const u of ['u1', 'u2', 'u3']) {
      const p = pick(d.projects.filter(x => x.team.includes(u) || u === 'u1'));
      const ph = p.phases.find(x => x.status === 'progress') || p.phases[p.phases.length - 1];
      d.timeEntries.push({ id: uid(), userId: u, projectId: p.id, phaseId: ph.id, date, hours: rint(2, 7), description: pick(['Design development', 'Drawings', 'Client meeting', 'Site visit', 'Coordination', 'Permit documents']), billable: true });
    }
  }
  // expenses
  const E = (pid, sid, cat, desc, net, off) => {
    const date = addDays(t, -off);
    const e = { id: uid(), number: nextNo('expense'), projectId: pid, supplierId: sid, date, dueDate: addDays(date, 30), category: cat, description: desc, ref: 'Bill ' + rint(100, 999), net, vatRate: 24, vat: round2(net * 0.24), total: round2(net * 1.24), payments: [] };
    if (off > 20) e.payments.push({ id: uid(), date: addDays(date, 10), amount: e.total, method: 'bank transfer' });
    else if (off > 10) e.payments.push({ id: uid(), date: addDays(date, 5), amount: round2(e.total / 2), method: 'bank transfer' });
    d.expenses.push(e);
  };
  E('p1', 's1', 'Structural engineer', 'Structural study — family house', 2800, 90);
  E('p1', 's3', 'Surveyor / topography', 'Topographic survey', 650, 140);
  E('p2', 's2', 'MEP engineer', 'MEP preliminary study', 3500, 30);
  E('p2', 's4', 'Printing & models', 'Presentation boards', 180, 12);
  E('p4', 's3', 'Surveyor / topography', 'Land survey 3 plots', 1400, 20);
  E('p5', '', 'Permit fees & TEE', 'TEE fees', 320, 200);
  // collaborators assigned to projects with their agreed fee
  const collab = (pid, sid, role, fee) => byId('projects', pid).collaborators.push({ id: uid(), supplierId: sid, role, agreedFee: fee, notes: '' });
  d.projects.forEach(p => { p.collaborators = []; });
  collab('p1', 's1', 'Structural study & supervision', 4200); collab('p1', 's3', 'Topographic survey', 650);
  collab('p2', 's2', 'MEP studies', 7800); collab('p2', 's1', 'Structural assessment', 5200); collab('p2', 's4', 'Printing', 600);
  collab('p4', 's3', 'Land survey', 1400); collab('p4', 's1', 'Structural concept', 3000);
  // proposals
  const Q = (cid, projectName, type, status, off, fee) => {
    const date = addDays(t, -off);
    const lines = d.settings.phaseTemplates.slice(0, 4).map((n, i) => ({ desc: n, qty: 1, unit: 'phase', price: Math.round(fee * [0.15, 0.3, 0.3, 0.25][i] / 10) * 10, discount: 0 }));
    d.quotes.push({ id: uid(), number: nextNo('quote'), customerId: cid, projectName, projectType: type, siteAddress: '', area: rint(90, 400), constructionBudget: fee * 10, date, validUntil: addDays(date, 30), lines, installments: clone(d.settings.paymentTemplates), notes: '', terms: 'Fees exclude VAT, state fees and the fees of other engineers (structural, MEP) unless listed.', status, ...totals(lines) });
  };
  Q('c6', 'Stone house restoration, Apokoronas', 'Renovation', 'sent', 6, 14000);
  Q('c3', 'Kitchen & living room redesign', 'Interior design', 'draft', 2, 4500);
  Q('c2', 'Hotel spa extension', 'Commercial building', 'sent', 18, 30000);
  Q('c1', 'Garden pavilion', 'New residence', 'rejected', 70, 6000);
  // calendar
  const acts = [[0, 'meeting', 'c2', 'Design review with hotel management'], [1, 'call', 'c6', 'Follow up on fee proposal'], [2, 'site', 'c1', 'Site visit — foundations'], [-1, 'task', 'c4', 'Send masterplan options', false], [5, 'meeting', 'c3', 'Materials presentation'], [9, 'site', 'c5', 'Final inspection']];
  d.activities = acts.map(([off, type, cid, title]) => ({ id: uid(), type, customerId: cid, projectId: d.projects.find(p => p.customerId === cid)?.id || '', title, date: addDays(t, off), time: pick(['09:30', '11:00', '13:00', '16:30']), done: false, notes: '', userId: pick(['u1', 'u2', 'u3']) }));
  db = prev;
  return d;
}

function fakeMark(date) {
  const hex = () => Array.from({ length: 40 }, () => '0123456789ABCDEF'[Math.floor(Math.random() * 16)]).join('');
  return { status: 'transmitted', mark: String(400000000000000 + Math.floor(Math.random() * 99999999999999)), uid: hex(), transmittedAt: (date || today()) + 'T12:00:00', env: 'simulated' };
}
