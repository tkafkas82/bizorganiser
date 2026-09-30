'use strict';
/* =========================================================================
   Demo data — a printing & signage company with ~6 months of history
   ========================================================================= */

function defaultSettings() {
  return {
    company: { name: 'Demo Print & Signs', vat: 'EL099999999', taxOffice: 'Athens A', email: 'info@demoprint.example', phone: '+30 210 000 0000', address: '1 Example Street, 10000 Athens', iban: 'GR00 0000 0000 0000 0000 0000 000' },
    vatRate: 24,
    prefixes: { quote: 'QT', order: 'SO', wo: 'WO', po: 'PO', invoice: 'INV', delivery: 'DLV', bill: 'BILL' },
    productionSteps: ['Prepress / artwork check', 'Printing', 'Finishing', 'Quality control', 'Packing'],
    couriers: ['ACS', 'ELTA Courier', 'Geniki Taxydromiki', 'Speedex', 'BOX NOW', 'Own vehicle'],
    regions: ['Attica', 'Thessaloniki', 'Crete', 'Western Greece', 'Dodecanese', 'Peloponnese'],
    groups: ['Retail', 'Agency', 'Hospitality', 'Corporate'],
    automations: { quoteSent: true, orderConfirmed: true, orderShipped: true, invoiceIssued: true, poSent: true, paymentReminder: true, b2bOrder: true, eshopOrder: true, creditNote: true },
    shop: {
      enabled: true, title: 'Demo Print & Signs — Online shop', tagline: 'Professional printing, delivered',
      heroTitle: 'Print that gets noticed', heroText: 'Business cards, flyers, banners and labels — order online, we print and ship all over Greece.',
      accent: '#2458d6', logo: '', about: 'We are a family print shop in Athens with 20 years of experience in offset and digital printing.',
      terms: 'Prices include VAT. Orders ship within 3–5 working days after artwork approval. You can return unused, non-personalised products within 14 days.',
      shippingFee: 4.9, freeShippingOver: 80, codFee: 2, payCod: true, payBank: true, featured: ['p1', 'p2', 'p4'],
    },
    templates: {
      quoteSent: { name: 'Quote sent', subject: 'Quote {{number}} from {{company}}', body: 'Dear {{customer}},\n\nPlease find attached our quote {{number}} for a total of {{total}} (incl. VAT), valid until {{date}}.\n\nWe remain at your disposal for any clarification.\n\nKind regards,\n{{company}}' },
      orderConfirmed: { name: 'Order confirmed', subject: 'Order {{number}} confirmed', body: 'Dear {{customer}},\n\nThank you for your order {{number}} ({{total}}). Expected completion: {{date}}.\n\nKind regards,\n{{company}}' },
      orderShipped: { name: 'Order shipped', subject: 'Your order {{number}} has shipped', body: 'Dear {{customer}},\n\nYour order {{number}} was handed to {{courier}}. Tracking number: {{tracking}}.\n\nKind regards,\n{{company}}' },
      invoiceIssued: { name: 'Invoice issued', subject: 'Invoice {{number}}', body: 'Dear {{customer}},\n\nInvoice {{number}} for {{total}} has been issued, due on {{date}}.\n\nKind regards,\n{{company}}' },
      paymentReminder: { name: 'Payment reminder', subject: 'Payment reminder — invoice {{number}}', body: 'Dear {{customer}},\n\nOur records show an open balance of {{total}} on invoice {{number}}, due {{date}}. Please arrange payment at your earliest convenience.\n\nKind regards,\n{{company}}' },
      poSent: { name: 'Purchase order to supplier', subject: 'Purchase order {{number}}', body: 'Dear {{customer}},\n\nPlease find our purchase order {{number}} ({{total}}). Requested delivery: {{date}}.\n\nKind regards,\n{{company}}' },
      b2bOrder: { name: 'New B2B order (internal)', subject: 'New B2B order {{number}} from {{customer}}', body: 'A new order {{number}} for {{total}} was placed on the B2B portal by {{customer}}.' },
      eshopOrder: { name: 'New e-shop order (internal)', subject: 'New e-shop order {{number}} from {{customer}}', body: 'A new order {{number}} for {{total}} was placed on the e-shop by {{customer}}.' },
      creditNote: { name: 'Credit note issued', subject: 'Credit note {{number}}', body: 'Dear {{customer}},\n\nWe have issued credit note {{number}} for {{total}}, crediting invoice {{date}}.\n\nKind regards,\n{{company}}' },
    },
  };
}

function seedDB(empty = false) {
  let s = 20260928;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const pick = a => a[Math.floor(rnd() * a.length)];
  const rint = (a, b) => a + Math.floor(rnd() * (b - a + 1));

  const d = {
    version: 1, counters: {}, settings: defaultSettings(), session: { userId: 'u1' },
    users: [
      { id: 'u1', name: 'Admin User', email: 'admin@demoprint.example', role: 'admin' },
      { id: 'u2', name: 'Sofia (Sales)', email: 'sales@demoprint.example', role: 'sales' },
      { id: 'u3', name: 'Kostas (Production)', email: 'production@demoprint.example', role: 'production' },
      { id: 'u4', name: 'Anna (Accounting)', email: 'accounts@demoprint.example', role: 'accounting' },
    ],
    reps: [], customers: [], suppliers: [], products: [], supplierPrices: [], priceLists: [], activities: [],
    quotes: [], orders: [], workOrders: [], deliveries: [], invoices: [], purchaseOrders: [], bills: [], emails: [], stockMoves: [], rfqs: [],
  };
  const prev = db; db = d;
  if (empty) { db = prev; return d; }

  d.reps = [
    { id: 'r1', name: 'Maria Papadopoulou', email: 'maria@demoprint.example', phone: '+30 690 000 0001', commission: 5 },
    { id: 'r2', name: 'Nikos Georgiou', email: 'nikos@demoprint.example', phone: '+30 690 000 0002', commission: 7 },
    { id: 'r3', name: 'Eleni Dimitriou', email: 'eleni@demoprint.example', phone: '+30 690 000 0003', commission: 6 },
  ];
  d.priceLists = [
    { id: 'pl1', name: 'Agency −10%', discount: 10, overrides: [] },
    { id: 'pl2', name: 'Key accounts', discount: 15, overrides: [{ productId: 'p1', price: 17.5 }, { productId: 'p4', price: 89 }] },
  ];
  const C = (id, name, city, region, group, rep, pl, extra = {}) => ({
    id, name, vat: 'EL' + String(100000000 + rint(0, 899999999)), email: name.toLowerCase().replace(/[^a-z]+/g, '') + '@example.com',
    phone: '+30 2' + rint(100000000, 999999999), address: `${rint(1, 120)} Main Street`, city, postalCode: String(rint(10431, 85100)), region, group, repId: rep, priceListId: pl,
    paymentTerms: pick([0, 30, 30, 60]), notes: '', createdAt: addDays(today(), -rint(200, 900)), ...extra,
  });
  d.customers = [
    C('c1', 'Aegean Coffee House', 'Athens', 'Attica', 'Hospitality', 'r1', ''),
    C('c2', 'Blue Wave Advertising', 'Athens', 'Attica', 'Agency', 'r2', 'pl1'),
    C('c3', 'Olympus Retail Group', 'Thessaloniki', 'Thessaloniki', 'Retail', 'r2', 'pl2'),
    C('c4', 'Knossos Hotels', 'Heraklion', 'Crete', 'Hospitality', 'r3', 'pl2'),
    C('c5', 'Patras Motors', 'Patras', 'Western Greece', 'Corporate', 'r3', ''),
    C('c6', 'Rhodes Island Shop', 'Rhodes', 'Dodecanese', 'Retail', 'r1', ''),
    C('c7', 'Acropolis Law Partners', 'Athens', 'Attica', 'Corporate', 'r1', ''),
    C('c8', 'Nafplio Bakery', 'Nafplio', 'Peloponnese', 'Retail', 'r3', '', { vat: '' }),
  ];
  d.suppliers = [
    { id: 's1', name: 'PaperCo Hellas', vat: 'EL800000001', email: 'orders@paperco.example', phone: '+30 210 111 1111', city: 'Athens', contact: 'G. Ioannou', notes: '' },
    { id: 's2', name: 'InkSource Ltd', vat: 'EL800000002', email: 'sales@inksource.example', phone: '+30 231 222 2222', city: 'Thessaloniki', contact: 'P. Nikolaou', notes: '' },
    { id: 's3', name: 'SignMaterials SA', vat: 'EL800000003', email: 'info@signmat.example', phone: '+30 210 333 3333', city: 'Piraeus', contact: 'D. Vlachos', notes: '' },
  ];
  const P = (id, sku, name, category, unit, cost, price, stock, minStock, supplierId, kind = 'product') =>
    ({ id, sku, name, category, unit, cost, price, stock, minStock, supplierId, kind, b2b: kind !== 'material', eshop: ['p1', 'p2', 'p3', 'p4', 'p5', 'p7', 'p13', 'p14'].includes(id), eshopPrice: 0, description: '', image: '' });
  d.products = [
    P('p1', 'BC-350', 'Business cards 350gsm (500 pcs)', 'Business stationery', 'box', 9, 22, 120, 30, 's1'),
    P('p2', 'FL-A5', 'Flyers A5 170gsm (1000 pcs)', 'Promotional print', 'pack', 38, 85, 60, 20, 's1'),
    P('p3', 'BR-A4', 'Tri-fold brochure A4 (500 pcs)', 'Promotional print', 'pack', 95, 210, 25, 10, 's1'),
    P('p4', 'RU-85', 'Roll-up banner 85×200cm', 'Signage', 'pcs', 42, 110, 18, 5, 's3'),
    P('p5', 'PVC-M2', 'PVC banner (per m²)', 'Signage', 'm²', 6.5, 18, 400, 100, 's3'),
    P('p6', 'VW-M2', 'Vehicle vinyl wrap (per m²)', 'Signage', 'm²', 14, 45, 150, 50, 's3'),
    P('p7', 'LB-1000', 'Product labels roll (1000 pcs)', 'Labels', 'roll', 28, 65, 40, 15, 's1'),
    P('p8', 'PK-100', 'Folding carton boxes (100 pcs)', 'Packaging', 'pack', 55, 130, 22, 10, 's1'),
    P('p9', 'PP-130', 'Coated paper 130gsm SRA3 (500 sh.)', 'Materials', 'pack', 24, 34, 35, 20, 's1', 'material'),
    P('p10', 'INK-CMYK', 'CMYK ink set', 'Materials', 'set', 180, 240, 6, 4, 's2', 'material'),
    P('p11', 'SRV-DES', 'Graphic design (per hour)', 'Services', 'hour', 18, 45, 0, 0, '', 'service'),
    P('p12', 'SRV-INS', 'Installation service (per hour)', 'Services', 'hour', 20, 50, 0, 0, '', 'service'),
    P('p13', 'ST-500', 'Die-cut stickers (500 pcs)', 'Labels', 'pack', 30, 72, 8, 10, 's1'),
    P('p14', 'LH-A4', 'Letterhead A4 (500 sheets)', 'Business stationery', 'pack', 26, 58, 30, 10, 's1'),
  ];
  for (const p of d.products.filter(p => p.kind !== 'service')) {
    for (const sp of d.suppliers) {
      if (sp.id === p.supplierId || rnd() < 0.35) d.supplierPrices.push({ id: uid(), supplierId: sp.id, productId: p.id, price: round2(p.cost * (0.9 + rnd() * 0.25)), leadDays: rint(2, 10), updated: addDays(today(), -rint(5, 90)) });
    }
  }

  // ---- history ----
  const t = today();
  const months = lastMonths(6);
  const sellable = d.products.filter(p => p.kind !== 'material');
  const mkLines = cust => Array.from({ length: rint(1, 3) }, () => {
    const p = pick(sellable);
    const qty = p.unit === 'm²' ? rint(5, 40) : p.unit === 'hour' ? rint(1, 6) : rint(1, 10);
    return { productId: p.id, desc: p.name, qty, unitCost: p.cost, price: priceFor(cust, p), discount: rnd() < 0.2 ? 5 : 0 };
  });
  const dateIn = (m, i) => { let x = `${m.key}-${pad(rint(1, 28))}`; if (x > t) x = addDays(t, -rint(0, 3)); return x; };

  months.forEach((m, mi) => {
    const recent = mi >= 4;
    for (let i = 0; i < rint(6, 9); i++) {
      const cust = pick(d.customers); const date = dateIn(m, i);
      const lines = mkLines(cust); const tt = totals(lines);
      const q = { id: uid(), number: nextNo('quote'), customerId: cust.id, repId: cust.repId, date, validUntil: addDays(date, 30), lines, notes: '', status: 'converted', ...tt, createdBy: 'u2' };
      const age = daysBetween(date, t);
      const roll = rnd();
      if (age < 20 && roll < 0.4) { q.status = pick(['draft', 'sent', 'sent']); d.quotes.push(q); continue; }
      if (roll < 0.15) { q.status = 'rejected'; d.quotes.push(q); continue; }
      d.quotes.push(q);
      const o = { id: uid(), number: nextNo('order'), customerId: cust.id, repId: cust.repId, quoteId: q.id, date: addDays(date, rint(0, 3)) > t ? date : addDays(date, rint(0, 3)), dueDate: addDays(date, rint(5, 12)), lines: clone(lines), notes: '', source: rnd() < 0.3 ? 'b2b' : 'internal', paymentMethod: pick(['bank', 'bank', 'cod', 'card']), status: 'delivered', ...tt };
      q.orderId = o.id;
      if (age < 5) o.status = pick(['new', 'production']);
      else if (age < 12) o.status = pick(['production', 'ready', 'shipped']);
      d.orders.push(o);
      if (['production', 'ready', 'shipped', 'delivered'].includes(o.status)) {
        const done = o.status !== 'production';
        const wo = { id: uid(), number: nextNo('wo'), orderId: o.id, customerId: o.customerId, dueDate: o.dueDate, priority: rnd() < 0.2 ? 'high' : 'normal', assigneeId: 'u3', status: done ? 'done' : (rnd() < 0.5 ? 'todo' : 'progress'), attachments: [{ name: 'artwork-final.pdf', size: 1843200 }], notes: '', steps: d.settings.productionSteps.map((n, si) => ({ name: n, done: done || (si < 2 && rnd() < 0.5) })) };
        if (!done) wo.status = wo.steps.some(x => x.done) ? 'progress' : 'todo';
        o.workOrderId = wo.id; d.workOrders.push(wo);
      }
      if (['shipped', 'delivered'].includes(o.status)) {
        const courier = pick(d.settings.couriers.slice(0, 5));
        const dl = { id: uid(), number: nextNo('delivery'), orderId: o.id, customerId: o.customerId, date: addDays(o.date, rint(3, 8)) > t ? t : addDays(o.date, rint(3, 8)), courier, tracking: genTracking(courier), address: `${cust.address}, ${cust.city}`, weight: rint(1, 25), cod: o.paymentMethod === 'cod', codAmount: o.paymentMethod === 'cod' ? o.total : 0, codCollected: o.status === 'delivered' && o.paymentMethod === 'cod', status: o.status === 'delivered' ? 'delivered' : 'in_transit', history: [] };
        o.deliveryId = dl.id; d.deliveries.push(dl);
      }
      if (o.status === 'delivered' || (o.status === 'shipped' && rnd() < 0.5)) {
        const inv = makeInvoice(o, o.date > t ? t : addDays(o.date, rint(1, 6)) > t ? t : addDays(o.date, rint(1, 6)));
        const invAge = daysBetween(inv.date, t);
        if (invAge > 12 || rnd() < 0.3) inv.mydata = fakeMark(inv.date);
        if (invAge > 25 && rnd() < 0.85) inv.payments.push({ id: uid(), date: addDays(inv.date, rint(5, 25)), amount: inv.total, method: o.paymentMethod === 'cod' ? 'cash (COD)' : 'bank transfer' });
        d.invoices.push(inv); o.invoiceId = inv.id;
      }
    }
  });
  // guaranteed work in progress: open quotes, jobs in production, one ready to ship
  [[2, 'sent'], [4, 'sent'], [1, 'draft'], [9, 'sent']].forEach(([off, status], k) => {
    const cust = d.customers[(k * 3 + 1) % d.customers.length]; const lines = mkLines(cust); const date = addDays(t, -off);
    d.quotes.push({ id: uid(), number: nextNo('quote'), customerId: cust.id, repId: cust.repId, date, validUntil: addDays(date, 30), lines, notes: '', status, ...totals(lines), createdBy: 'u2' });
  });
  [[1, 'production', 'high', 1], [2, 'production', 'normal', 3], [3, 'production', 'normal', 0], [0, 'new', '', 0], [4, 'ready', 'normal', 5]].forEach(([off, status, prio, doneSteps], k) => {
    const cust = d.customers[(k * 2 + 2) % d.customers.length]; const lines = mkLines(cust); const date = addDays(t, -off);
    const o = { id: uid(), number: nextNo('order'), customerId: cust.id, repId: cust.repId, date, dueDate: addDays(date, k === 0 ? 2 : 6), lines, notes: '', source: k % 2 ? 'b2b' : 'internal', paymentMethod: k === 4 ? 'cod' : 'bank', status, ...totals(lines) };
    d.orders.push(o);
    if (status !== 'new') {
      const steps = d.settings.productionSteps.map((n, si) => ({ name: n, done: si < doneSteps }));
      const wo = { id: uid(), number: nextNo('wo'), orderId: o.id, customerId: o.customerId, dueDate: o.dueDate, priority: prio, assigneeId: k === 2 ? '' : 'u3', status: doneSteps === steps.length ? 'done' : doneSteps ? 'progress' : 'todo', attachments: [{ name: 'artwork-v2.pdf', size: 2621440 }], notes: '', steps };
      o.workOrderId = wo.id; d.workOrders.push(wo);
    }
  });
  // a pending B2B order prepared by a rep, awaiting customer confirmation
  {
    const cust = d.customers[3]; const lines = [{ productId: 'p4', desc: d.products[3].name, qty: 6, unitCost: 42, price: priceFor(cust, d.products[3]), discount: 0 }];
    d.orders.push({ id: uid(), number: nextNo('order'), customerId: cust.id, repId: 'r3', date: t, dueDate: addDays(t, 7), lines, notes: 'Prepared by rep on the B2B portal', source: 'b2b', paymentMethod: 'bank', status: 'pending', createdByRep: 'r3', ...totals(lines) });
  }
  // purchase orders & bills
  {
    const lines = [{ productId: 'p9', desc: d.products[8].name, qty: 20, unitCost: 0, price: 23.5, discount: 0 }, { productId: 'p13', desc: d.products[12].name, qty: 15, unitCost: 0, price: 29, discount: 0 }];
    d.purchaseOrders.push({ id: uid(), number: nextNo('po'), supplierId: 's1', date: addDays(t, -2), expectedDate: addDays(t, 3), lines, notes: '', status: 'sent', ...totals(lines) });
    const l2 = [{ productId: 'p10', desc: d.products[9].name, qty: 4, unitCost: 0, price: 175, discount: 0 }];
    const po2 = { id: uid(), number: nextNo('po'), supplierId: 's2', date: addDays(t, -40), expectedDate: addDays(t, -33), lines: l2, notes: '', status: 'received', receivedAt: addDays(t, -34), ...totals(l2) };
    d.purchaseOrders.push(po2);
    d.bills.push({ id: uid(), number: nextNo('bill'), supplierRef: 'IS-55821', supplierId: 's2', poId: po2.id, date: po2.receivedAt, dueDate: addDays(po2.receivedAt, 30), net: po2.net, vat: po2.vat, total: po2.total, paid: true });
  }
  // activities / reminders
  const acts = [
    [0, 'call', 'c3', 'Call about autumn campaign banners'], [0, 'meeting', 'c4', 'Meeting: hotel signage refresh'], [-2, 'task', 'c8', 'Collect missing VAT number'],
    [1, 'email', 'c2', 'Send updated price list'], [3, 'meeting', 'c5', 'Showroom visit — vehicle wraps'], [6, 'call', 'c6', 'Follow up on quote'], [-5, 'call', 'c1', 'Check satisfaction with menus', true],
    [10, 'task', 'c7', 'Prepare letterhead proofs'],
  ];
  d.activities = acts.map(([off, type, cid, title, done]) => ({ id: uid(), type, customerId: cid, title, date: addDays(t, off), time: pick(['09:30', '11:00', '13:00', '16:30']), done: !!done, notes: '', userId: 'u2' }));
  d.emails = [];
  db = prev;
  return d;
}

function genTracking(courier) {
  const pre = { 'ACS': '', 'ELTA Courier': 'EL', 'Geniki Taxydromiki': 'GT', 'Speedex': 'SP', 'BOX NOW': 'BN', 'Own vehicle': 'OWN' }[courier] ?? 'TR';
  return pre + String(Math.floor(1e9 + Math.random() * 9e9));
}
function fakeMark(date) {
  const hex = () => Array.from({ length: 40 }, () => '0123456789ABCDEF'[Math.floor(Math.random() * 16)]).join('');
  return { status: 'transmitted', mark: String(400000000000000 + Math.floor(Math.random() * 99999999999999)), uid: hex(), transmittedAt: (date || today()) + 'T12:00:00' };
}
function makeInvoice(order, date = today()) {
  const cust = byId('customers', order.customerId);
  const tt = totals(order.lines);
  return {
    id: uid(), number: nextNo('invoice'), type: cust?.vat ? '1.1' : '11.1', orderId: order.id, customerId: order.customerId, repId: order.repId,
    date, dueDate: addDays(date, cust?.paymentTerms || 0), paymentMethod: order.paymentMethod || 'bank', lines: clone(order.lines), ...tt, payments: [], mydata: { status: 'pending' },
  };
}
