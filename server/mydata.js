'use strict';
/* =========================================================================
   AADE myDATA — ERP channel client (SendInvoices).

   Document types: 2.1 service invoice, 11.2 service receipt, 5.1 credit
   note (B2B), 11.4 retail credit note; 1.1 / 11.1 are still accepted.
   Withholding tax on fees is sent per line (withheldAmount +
   withheldPercentCategory) and in the summary.
   Element order follows the official XSD (schema v2.0.x, namespace v1.0).

   Modes:  simulate   — builds and validates the XML, returns a fake MARK
           test       — https://mydataapidev.aade.gr (developer sandbox)
           production — https://mydatapi.aade.gr/myDATA

   NOTE: under the Greek B2B e-invoicing mandate (all businesses from
   1 Oct 2026) B2B invoices must be issued through a licensed e-invoicing
   provider or AADE's "timologio" app. Check with your accountant before
   using production mode for B2B documents. Test the withholding fields in
   the AADE test environment before production use.
   ========================================================================= */
const crypto = require('crypto');

const URLS = { test: 'https://mydataapidev.aade.gr/SendInvoices', production: 'https://mydatapi.aade.gr/myDATA/SendInvoices' };
const VAT_CATEGORY = { 24: 1, 13: 2, 6: 3, 17: 4, 9: 5, 4: 6, 0: 7 };
const PAYMENT_TYPE = { bank: 1, cash: 3, cod: 3, card: 7, credit: 5 };
const RETAIL = ['11.1', '11.2', '11.4'];
const B2B_NEEDS_COUNTERPART = ['1.1', '2.1', '5.1'];

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
  if (B2B_NEEDS_COUNTERPART.includes(invoice.type)) {
    if (!customer?.vat) return 'The client has no VAT number (ΑΦΜ). Service invoices (2.1) need a valid counterpart VAT number — use a service receipt (11.2) for individuals.';
    if (afm(customer.vat).length !== 9) return `Client VAT "${customer.vat}" is not a valid 9-digit Greek VAT number.`;
  }
  if (['5.1', '11.4'].includes(invoice.type)) {
    if (!original) return 'Credit note: the original document was not found.';
    if (original.mydata?.status !== 'transmitted' || !original.mydata.mark) return `Send the original document ${original.number} to myDATA first.`;
  }
  return '';
}

/** Income classification: retail vs. wholesale/B2B, goods vs. services. */
function classification(invoice, original) {
  const base = ['5.1', '11.4'].includes(invoice.type) && original ? original.type : invoice.type;
  const retail = RETAIL.includes(invoice.type) || RETAIL.includes(base);
  const services = ['2.1', '11.2'].includes(base);
  return { type: retail ? 'E3_561_003' : 'E3_561_001', category: services ? 'category1_3' : 'category1_1' };
}

/** Spread a document-level amount over lines in proportion to their net value, fixing rounding on the last line. */
function spread(total, nets) {
  const sumNet = nets.reduce((a, n) => a + n, 0);
  const parts = nets.map(n => sumNet ? r2(total * n / sumNet) : 0);
  if (parts.length) parts[parts.length - 1] = r2(parts[parts.length - 1] + total - parts.reduce((a, p) => a + p, 0));
  return parts;
}

function buildXML({ invoice, customer, company, vatRate, original, withholdingCategory = 3 }) {
  const m = String(invoice.number).match(/^(.*?)[-\s/]*(\d+)$/);
  const series = (m && m[1]) || '0', aa = m ? String(+m[2]) : String(invoice.number);
  const cat = VAT_CATEGORY[vatRate];
  const cls = classification(invoice, original);
  const nets = invoice.lines.map(lineNet);
  const vats = spread(invoice.vat ?? r2(nets.reduce((a, n) => a + n, 0) * vatRate / 100), nets);
  const withheld = spread(+invoice.withheld || 0, nets);
  const totalNet = r2(nets.reduce((a, n) => a + n, 0));
  const totalVat = r2(vats.reduce((a, n) => a + n, 0));
  const totalWithheld = r2(withheld.reduce((a, n) => a + n, 0));
  const gross = r2(totalNet + totalVat - totalWithheld);

  const details = invoice.lines.map((l, i) => `    <invoiceDetails>
      <lineNumber>${i + 1}</lineNumber>
      <netValue>${amt(nets[i])}</netValue>
      <vatCategory>${cat}</vatCategory>
      <vatAmount>${amt(vats[i])}</vatAmount>${withheld[i] ? `
      <withheldAmount>${amt(withheld[i])}</withheldAmount>
      <withheldPercentCategory>${+withholdingCategory || 3}</withheldPercentCategory>` : ''}
      <incomeClassification>
        <icls:classificationType>${cls.type}</icls:classificationType>
        <icls:classificationCategory>${cls.category}</icls:classificationCategory>
        <icls:amount>${amt(nets[i])}</icls:amount>
      </incomeClassification>
    </invoiceDetails>`).join('\n');

  const counterpart = RETAIL.includes(invoice.type) ? '' : `
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
  const correlated = ['5.1', '11.4'].includes(invoice.type) && original?.mydata?.mark ? `
      <correlatedInvoices>${x(original.mydata.mark)}</correlatedInvoices>` : '';

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
      <currency>EUR</currency>${correlated}
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
      <totalWithheldAmount>${amt(totalWithheld)}</totalWithheldAmount>
      <totalFeesAmount>0.00</totalFeesAmount>
      <totalStampDutyAmount>0.00</totalStampDutyAmount>
      <totalOtherTaxesAmount>0.00</totalOtherTaxesAmount>
      <totalDeductionsAmount>0.00</totalDeductionsAmount>
      <totalGrossValue>${amt(gross)}</totalGrossValue>
      <incomeClassification>
        <icls:classificationType>${cls.type}</icls:classificationType>
        <icls:classificationCategory>${cls.category}</icls:classificationCategory>
        <icls:amount>${amt(totalNet)}</icls:amount>
      </incomeClassification>
    </invoiceSummary>
  </invoice>
</InvoicesDoc>`;
}

const tag = (xml, name) => { const mm = xml.match(new RegExp(`<(?:\\w+:)?${name}>([\\s\\S]*?)</(?:\\w+:)?${name}>`)); return mm ? mm[1].trim() : ''; };
const unx = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
function parseResponse(xml) {
  const resp = tag(xml, 'response') || xml;
  const status = tag(resp, 'statusCode');
  const errors = [...resp.matchAll(/<(?:\w+:)?error>([\s\S]*?)<\/(?:\w+:)?error>/g)].map(mm => `${unx(tag(mm[1], 'message'))}${tag(mm[1], 'code') ? ` (code ${tag(mm[1], 'code')})` : ''}`);
  return { status, mark: tag(resp, 'invoiceMark'), uid: tag(resp, 'invoiceUid'), qrUrl: unx(tag(resp, 'qrUrl')), errors };
}

/** Send one document. Returns {mark, uid, qrUrl, env}; throws Error(message) on rejection. */
async function send({ cfg, invoice, customer, company, vatRate, original, withholdingCategory }) {
  const problem = validate({ invoice, customer, company, vatRate, original });
  if (problem) throw new Error(problem);
  const xml = buildXML({ invoice, customer, company, vatRate, original, withholdingCategory });
  const mode = cfg?.mode || 'simulate';
  if (mode === 'simulate') return { mark: String(400000000000000 + crypto.randomInt(0, 99999999999)), uid: crypto.randomBytes(20).toString('hex').toUpperCase(), qrUrl: '', env: 'simulated', xml };
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
