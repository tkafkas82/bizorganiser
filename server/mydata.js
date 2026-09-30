'use strict';
/* =========================================================================
   AADE myDATA — ERP channel client (SendInvoices).

   Element order follows the official XSD (schema v2.0.x, namespace v1.0).
   Modes:  simulate   — builds and validates the XML, returns a fake MARK
           test       — https://mydataapidev.aade.gr (developer sandbox)
           production — https://mydatapi.aade.gr/myDATA

   NOTE: under the Greek B2B e-invoicing mandate (all businesses from
   1 Oct 2026) B2B invoices must be issued through a licensed e-invoicing
   provider or AADE's "timologio" app. Check with your accountant before
   using production mode for invoice types 1.1 / 2.1 / 5.1.
   ========================================================================= */
const crypto = require('crypto');

const URLS = {
  test: 'https://mydataapidev.aade.gr/SendInvoices',
  production: 'https://mydatapi.aade.gr/myDATA/SendInvoices',
};
const VAT_CATEGORY = { 24: 1, 13: 2, 6: 3, 17: 4, 9: 5, 4: 6, 0: 7 };
const PAYMENT_TYPE = { bank: 1, cash: 3, cod: 3, card: 7, credit: 5 };

const x = s => String(s ?? '').replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
const amt = n => (Math.round((+n || 0) * 100) / 100).toFixed(2);
const r2 = n => Math.round((+n || 0) * 100) / 100;
const afm = v => String(v || '').replace(/^EL/i, '').replace(/\D/g, '');
const lineNet = l => r2((+l.qty || 0) * (+l.price || 0) * (1 - (+l.discount || 0) / 100));

function validate({ invoice, customer, company, vatRate, original }) {
  if (afm(company.vat).length !== 9) return 'Company VAT number (Settings → Company) must be a 9-digit Greek VAT number.';
  if (VAT_CATEGORY[vatRate] === undefined) return `VAT rate ${vatRate}% has no myDATA VAT category.`;
  if (vatRate === 0) return '0% VAT needs a VAT exemption category, which this version does not support.';
  if (!invoice.lines?.length) return 'Invoice has no lines.';
  if (!(invoice.total > 0)) return 'Invoice total must be greater than zero.';
  if (invoice.type !== '11.1') {
    if (!customer?.vat) return 'The customer has no VAT number (ΑΦΜ). B2B invoices need a valid counterpart VAT number.';
    if (afm(customer.vat).length !== 9) return `Customer VAT "${customer.vat}" is not a valid 9-digit Greek VAT number.`;
  }
  if (invoice.type === '5.1') {
    if (!original) return 'Credit note: the original invoice was not found.';
    if (original.mydata?.status !== 'transmitted' || !original.mydata.mark) return `Send the original invoice ${original.number} to myDATA first.`;
  }
  return '';
}

function classification(invoice, isService) {
  return {
    type: invoice.type === '11.1' ? 'E3_561_003' : 'E3_561_001',
    category: isService || invoice.type === '2.1' ? 'category1_3' : 'category1_1',
  };
}

/** Build the InvoicesDoc XML for one invoice. products: lookup for service detection. */
function buildXML({ invoice, customer, company, vatRate, original, productKind = () => 'product' }) {
  const m = String(invoice.number).match(/^(.*?)[-\s/]*(\d+)$/);
  const series = (m && m[1]) || '0', aa = m ? String(+m[2]) : String(invoice.number);
  const cat = VAT_CATEGORY[vatRate];

  // per-line VAT, with the rounding difference put on the last line so totals match the invoice
  const lines = invoice.lines.map(l => ({ l, net: lineNet(l), vat: r2(lineNet(l) * vatRate / 100) }));
  const vatDiff = r2((invoice.vat ?? r2(invoice.net * vatRate / 100)) - lines.reduce((a, y) => a + y.vat, 0));
  if (lines.length && Math.abs(vatDiff) < 0.05) lines[lines.length - 1].vat = r2(lines[lines.length - 1].vat + vatDiff);
  const totalNet = r2(lines.reduce((a, y) => a + y.net, 0));
  const totalVat = r2(lines.reduce((a, y) => a + y.vat, 0));

  const classTotals = new Map();
  const details = lines.map((y, i) => {
    const c = classification(invoice, productKind(y.l.productId) === 'service');
    const k = c.type + '|' + c.category;
    classTotals.set(k, r2((classTotals.get(k) || 0) + y.net));
    return `    <invoiceDetails>
      <lineNumber>${i + 1}</lineNumber>
      <netValue>${amt(y.net)}</netValue>
      <vatCategory>${cat}</vatCategory>
      <vatAmount>${amt(y.vat)}</vatAmount>
      <incomeClassification>
        <icls:classificationType>${c.type}</icls:classificationType>
        <icls:classificationCategory>${c.category}</icls:classificationCategory>
        <icls:amount>${amt(y.net)}</icls:amount>
      </incomeClassification>
    </invoiceDetails>`;
  }).join('\n');

  const counterpart = invoice.type === '11.1' ? '' : `
    <counterpart>
      <vatNumber>${x(afm(customer.vat))}</vatNumber>
      <country>GR</country>
      <branch>0</branch>${customer.postalCode && customer.city ? `
      <address>
        <postalCode>${x(customer.postalCode)}</postalCode>
        <city>${x(customer.city)}</city>
      </address>` : ''}
    </counterpart>`;

  const payKey = invoice.paymentMethod === 'bank' && (customer?.paymentTerms || 0) > 0 ? 'credit' : (invoice.paymentMethod || 'bank');
  const gross = r2(totalNet + totalVat);

  return `<?xml version="1.0" encoding="UTF-8"?>
<InvoicesDoc xmlns="http://www.aade.gr/myDATA/invoice/v1.0" xmlns:icls="https://www.aade.gr/myDATA/incomeClassificaton/v1.0" xmlns:ecls="https://www.aade.gr/myDATA/expensesClassificaton/v1.0">
  <invoice>
    <issuer>
      <vatNumber>${x(afm(company.vat))}</vatNumber>
      <country>GR</country>
      <branch>0</branch>
    </issuer>${counterpart}
    <invoiceHeader>
      <series>${x(series)}</series>
      <aa>${x(aa)}</aa>
      <issueDate>${x(invoice.date)}</issueDate>
      <invoiceType>${x(invoice.type)}</invoiceType>
      <currency>EUR</currency>${invoice.type === '5.1' ? `
      <correlatedInvoices>${x(original.mydata.mark)}</correlatedInvoices>` : ''}
    </invoiceHeader>
    <paymentMethods>
      <paymentMethodDetails>
        <type>${PAYMENT_TYPE[payKey] || 1}</type>
        <amount>${amt(gross)}</amount>
      </paymentMethodDetails>
    </paymentMethods>
${details}
    <invoiceSummary>
      <totalNetValue>${amt(totalNet)}</totalNetValue>
      <totalVatAmount>${amt(totalVat)}</totalVatAmount>
      <totalWithheldAmount>0.00</totalWithheldAmount>
      <totalFeesAmount>0.00</totalFeesAmount>
      <totalStampDutyAmount>0.00</totalStampDutyAmount>
      <totalOtherTaxesAmount>0.00</totalOtherTaxesAmount>
      <totalDeductionsAmount>0.00</totalDeductionsAmount>
      <totalGrossValue>${amt(gross)}</totalGrossValue>
${[...classTotals].map(([k, v]) => { const [t, c] = k.split('|'); return `      <incomeClassification>
        <icls:classificationType>${t}</icls:classificationType>
        <icls:classificationCategory>${c}</icls:classificationCategory>
        <icls:amount>${amt(v)}</icls:amount>
      </incomeClassification>`; }).join('\n')}
    </invoiceSummary>
  </invoice>
</InvoicesDoc>`;
}

const tag = (xml, name) => { const m = xml.match(new RegExp(`<(?:\\w+:)?${name}>([\\s\\S]*?)</(?:\\w+:)?${name}>`)); return m ? m[1].trim() : ''; };
const unx = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
function parseResponse(xml) {
  const resp = tag(xml, 'response') || xml;
  const status = tag(resp, 'statusCode');
  const errors = [...resp.matchAll(/<(?:\w+:)?error>([\s\S]*?)<\/(?:\w+:)?error>/g)].map(m => `${unx(tag(m[1], 'message'))}${tag(m[1], 'code') ? ` (code ${tag(m[1], 'code')})` : ''}`);
  return { status, mark: tag(resp, 'invoiceMark'), uid: tag(resp, 'invoiceUid'), qrUrl: unx(tag(resp, 'qrUrl')), errors };
}

/**
 * Send an invoice. Returns {mark, uid, qrUrl, env}; throws Error(message) on rejection.
 */
async function send({ cfg, invoice, customer, company, vatRate, original, productKind }) {
  const problem = validate({ invoice, customer, company, vatRate, original });
  if (problem) throw new Error(problem);
  const xml = buildXML({ invoice, customer, company, vatRate, original, productKind });
  const mode = cfg?.mode || 'simulate';
  if (mode === 'simulate') {
    return { mark: String(400000000000000 + crypto.randomInt(0, 99999999999)), uid: crypto.randomBytes(20).toString('hex').toUpperCase(), qrUrl: '', env: 'simulated', xml };
  }
  if (!cfg.userId || !cfg.subscriptionKey) throw new Error('myDATA credentials are missing (Settings → Integrations).');
  const res = await fetch(URLS[mode], {
    method: 'POST',
    headers: { 'aade-user-id': cfg.userId, 'ocp-apim-subscription-key': cfg.subscriptionKey, 'Content-Type': 'text/xml; charset=utf-8', Accept: 'application/xml' },
    body: xml, signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  if (res.status === 401 || res.status === 403) throw new Error(`myDATA refused the credentials (HTTP ${res.status}). Check the user ID and subscription key.`);
  if (!res.ok) throw new Error(`myDATA HTTP ${res.status}: ${text.slice(0, 300)}`);
  const r = parseResponse(text);
  if (r.status !== 'Success' || !r.mark) throw new Error(`myDATA ${r.status || 'error'}: ${r.errors.join('; ') || text.slice(0, 300)}`);
  return { mark: r.mark, uid: r.uid, qrUrl: r.qrUrl, env: mode };
}

module.exports = { send, buildXML, parseResponse, validate };
