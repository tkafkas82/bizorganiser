'use strict';
/* =========================================================================
   Courier integrations.
     ACS      — ACS Web Services REST (ACSAutoRest): create voucher, print
                label, tracking, daily pickup list
     BOX NOW  — Partner API: delivery requests to parcel lockers, labels,
                parcel tracking
     others   — "manual": the user types the tracking number from the
                courier's own system (ELTA, Geniki, Speedex, own vehicle…)
   Every courier also supports "simulate" for demos and training.
   ========================================================================= */
const crypto = require('crypto');

const DEFAULT_CONFIG = {
  acs: { mode: 'simulate', apiKey: '', companyId: '', companyPassword: '', userId: '', userPassword: '', billingCode: '', printType: 2 },
  boxnow: { mode: 'simulate', env: 'stage', clientId: '', clientSecret: '', originLocationId: '', contactName: '', contactEmail: '', contactPhone: '' },
  other: { mode: 'simulate' },
};
const SECRET_PATHS = ['couriers.acs.apiKey', 'couriers.acs.companyPassword', 'couriers.acs.userPassword', 'couriers.boxnow.clientSecret'];
const ACS_URL = 'https://webservices.acscourier.net/ACSRestServices/api/ACSAutoRest';
const BOXNOW_URL = { stage: 'https://api-stage.boxnow.gr', production: 'https://api-production.boxnow.gr' };

const keyOf = courier => courier === 'ACS' ? 'acs' : courier === 'BOX NOW' ? 'boxnow' : 'other';
const modeOf = (cfg, courier) => cfg?.[keyOf(courier)]?.mode || 'simulate';
const status = cfg => ({ ACS: modeOf(cfg, 'ACS'), 'BOX NOW': modeOf(cfg, 'BOX NOW'), other: modeOf(cfg, 'other') });
const today = () => new Date().toISOString().slice(0, 10);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const phone = p => { const d = String(p || '').replace(/[^\d+]/g, ''); return d.startsWith('+') ? d : d.startsWith('00') ? '+' + d.slice(2) : d.length === 10 ? '+30' + d : d; };
const fakeTracking = courier => ({ 'ACS': '', 'ELTA Courier': 'EL', 'Geniki Taxydromiki': 'GT', 'Speedex': 'SP', 'BOX NOW': '9', 'Own vehicle': 'OWN' }[courier] ?? 'TR') + String(crypto.randomInt(100000000, 999999999));

/* ---------------- ACS ---------------- */
async function acsCall(c, alias, params) {
  if (!c.apiKey || !c.companyId || !c.userId) throw new Error('ACS credentials are missing (Settings → Integrations).');
  const res = await fetch(ACS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', AcsApiKey: c.apiKey },
    body: JSON.stringify({ ACSAlias: alias, ACSInputParameters: { Company_ID: c.companyId, Company_Password: c.companyPassword, User_ID: c.userId, User_Password: c.userPassword, Language: 'EN', ...params } }),
    signal: AbortSignal.timeout(30000),
  });
  if (res.status === 403) throw new Error('ACS refused the API key (HTTP 403).');
  if (res.status === 406) throw new Error('ACS rate limit exceeded — try again in a moment.');
  const data = await res.json().catch(() => { throw new Error(`ACS returned HTTP ${res.status} with an unreadable body.`); });
  if (data.ACSExecution_HasError) throw new Error('ACS: ' + (data.ACSExecutionErrorMessage || 'unknown error'));
  const out = data.ACSOutputResponce || data.ACSOutputResponse || {};
  const val = out.ACSValueOutput?.[0] || {};
  if (val.Error_Message) throw new Error('ACS: ' + val.Error_Message);
  return out;
}
const acs = {
  async book({ c, delivery, order, customer, company }) {
    const cod = delivery.cod && +delivery.codAmount > 0;
    const out = await acsCall(c, 'ACS_Create_Voucher', {
      Pickup_Date: today(), Sender: company.name,
      Recipient_Name: customer?.name || '', Recipient_Address: delivery.address || customer?.address || '', Recipient_Address_Number: '',
      Recipient_Zipcode: delivery.postalCode || customer?.postalCode || '', Recipient_Region: customer?.city || '',
      Recipient_Phone: customer?.phone || '', Recipient_Cell_Phone: delivery.phone || customer?.phone || '', Recipient_Email: customer?.email || '', Recipient_Country: 'GR',
      Billing_Code: c.billingCode, Charge_Type: 2, Item_Quantity: 1, Weight: Math.max(0.5, +delivery.weight || 0.5),
      Cod_Ammount: cod ? +(+delivery.codAmount).toFixed(2) : 0, Cod_Payment_Way: 0, Acs_Delivery_Products: cod ? 'COD' : '',
      Reference_Key1: order?.number || delivery.number, Reference_Key2: delivery.number,
    });
    const v = out.ACSValueOutput?.[0] || {};
    if (!v.Voucher_No) throw new Error('ACS did not return a voucher number.');
    return { tracking: String(v.Voucher_No), ref: String(v.Voucher_No), labelAvailable: true };
  },
  async label({ c, delivery }) {
    const out = await acsCall(c, 'ACS_Print_Voucher_V2', { Voucher_No: delivery.tracking, Print_Type: +c.printType || 2, Start_Position: 1 });
    const obj = out.ACSObjectOutput || {};
    const raw = obj[delivery.tracking] ?? Object.values(obj)[0];
    if (!raw) throw new Error('ACS returned no label.');
    return { contentType: 'application/pdf', body: Array.isArray(raw) ? Buffer.from(raw) : Buffer.from(String(raw), 'base64') };
  },
  async track({ c, delivery }) {
    const [sum, det] = await Promise.all([
      acsCall(c, 'ACS_Trackingsummary', { Voucher_No: delivery.tracking }),
      acsCall(c, 'ACS_TrackingDetails', { Voucher_No: delivery.tracking }),
    ]);
    const s = sum.ACSTableOutput?.Table_Data?.[0] || {};
    const events = (det.ACSTableOutput?.Table_Data || []).map(e => ({ at: e.checkpoint_date_time, text: [e.checkpoint_action, e.checkpoint_location, e.checkpoint_notes].filter(Boolean).join(' · ') }));
    let st = null;
    if (+s.delivery_flag === 1 || +s.shipment_status === 4) st = 'delivered';
    else if (events.length) st = 'in_transit';
    return { status: st, courierStatus: +s.returned_flag === 1 ? 'Returned to sender' : (s.non_delivery_reason_code ? `Not delivered (reason ${s.non_delivery_reason_code})` : ''), events };
  },
  async closeDay({ c }) {
    const out = await acsCall(c, 'ACS_Issue_Pickup_List', { Pickup_Date: today(), MyData: '' });
    const v = out.ACSValueOutput?.[0] || {};
    return { pickupList: String(v.PickupList_No || v.Mass_Number || '') };
  },
};

/* ---------------- BOX NOW ---------------- */
const tokens = new Map();
async function boxnowToken(c) {
  const k = c.env + c.clientId; const t = tokens.get(k);
  if (t && t.exp > Date.now() + 60000) return t.token;
  if (!c.clientId || !c.clientSecret) throw new Error('BOX NOW credentials are missing (Settings → Integrations).');
  const res = await fetch(BOXNOW_URL[c.env] + '/api/v1/auth-sessions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', client_id: c.clientId, client_secret: c.clientSecret }), signal: AbortSignal.timeout(20000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(`BOX NOW login failed (HTTP ${res.status}).`);
  tokens.set(k, { token: data.access_token, exp: Date.now() + (+data.expires_in || 3600) * 1000 });
  return data.access_token;
}
async function boxnowFetch(c, pathname, opts = {}) {
  const token = await boxnowToken(c);
  const res = await fetch(BOXNOW_URL[c.env] + pathname, { ...opts, headers: { Authorization: 'Bearer ' + token, ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...opts.headers }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) {
    const body = await res.text();
    let msg = body.slice(0, 300); try { const j = JSON.parse(body); msg = [j.code, j.message || j.title || j.detail].filter(Boolean).join(' ') || msg; } catch { /* keep text */ }
    throw new Error(`BOX NOW HTTP ${res.status}: ${msg}`);
  }
  return res;
}
const BOXNOW_STATE = { 'new': 'pending', 'wait-for-load': 'pending', 'in-transit': 'in_transit', 'in-depot': 'in_transit', 'in-final-destination': 'in_transit', 'delivered': 'delivered' };
const boxnow = {
  async book({ c, delivery, order, customer }) {
    if (!delivery.lockerId) throw new Error('Choose the BOX NOW locker ID for this delivery.');
    if (!c.originLocationId) throw new Error('Set your BOX NOW origin (warehouse) location ID in Settings → Integrations.');
    const cod = delivery.cod && +delivery.codAmount > 0;
    const body = {
      orderNumber: delivery.number, invoiceValue: (+order?.total || 0).toFixed(2), paymentMode: cod ? 'cod' : 'prepaid', amountToBeCollected: cod ? (+delivery.codAmount).toFixed(2) : '0.00',
      allowReturn: true,
      origin: { contactNumber: phone(c.contactPhone), contactEmail: c.contactEmail, contactName: c.contactName, locationId: String(c.originLocationId) },
      destination: { contactNumber: phone(delivery.phone || customer?.phone), contactEmail: customer?.email || '', contactName: customer?.name || '', locationId: String(delivery.lockerId) },
      items: [{ id: '1', name: order?.number || delivery.number, value: (+order?.total || 0).toFixed(2), compartmentSize: +delivery.compartmentSize || 2, weight: Math.max(0.1, +delivery.weight || 1) }],
    };
    const res = await boxnowFetch(c, '/api/v1/delivery-requests', { method: 'POST', body: JSON.stringify(body) });
    const data = await res.json();
    const parcel = data.parcels?.[0]?.id;
    if (!parcel) throw new Error('BOX NOW did not return a parcel number.');
    return { tracking: String(parcel), ref: String(data.id || ''), labelAvailable: true };
  },
  async label({ c, delivery }) {
    const res = await boxnowFetch(c, `/api/v1/parcels/${encodeURIComponent(delivery.tracking)}/label.pdf`);
    return { contentType: 'application/pdf', body: Buffer.from(await res.arrayBuffer()) };
  },
  async track({ c, delivery }) {
    const res = await boxnowFetch(c, `/api/v1/parcels?parcelId=${encodeURIComponent(delivery.tracking)}`);
    const p = (await res.json()).data?.[0];
    if (!p) return { status: null, events: [] };
    const events = (p.events || []).map(e => ({ at: e.createTime, text: [e.type, e.locationDisplayName].filter(Boolean).join(' · ') }));
    let st = BOXNOW_STATE[p.state] || null;
    if (st === 'in_transit' && !events.length) st = 'picked_up';
    return { status: st, courierStatus: BOXNOW_STATE[p.state] ? '' : p.state, events };
  },
};

/* ---------------- simulated & manual ---------------- */
function simulatedLabel({ delivery, order, customer, company }) {
  return {
    contentType: 'text/html; charset=utf-8',
    body: `<!doctype html><meta charset="utf-8"><title>Label ${esc(delivery.number)}</title>
<style>body{font:14px system-ui;margin:24px}.l{border:2px solid #000;width:380px;padding:14px}.big{font:700 26px monospace;letter-spacing:2px}.bar{height:60px;background:repeating-linear-gradient(90deg,#000 0 2px,#fff 2px 4px,#000 4px 7px,#fff 7px 9px);margin:10px 0}</style>
<div class="l"><b>${esc(delivery.courier)}</b> — SIMULATED LABEL (not valid for shipping)
<div class="bar"></div><div class="big">${esc(delivery.tracking)}</div><hr>
<b>From:</b> ${esc(company.name)}<br>${esc(company.address)}<br><br>
<b>To:</b> ${esc(customer?.name || '')}<br>${esc(delivery.address || '')}<br>${esc(delivery.phone || customer?.phone || '')}<br><br>
Order ${esc(order?.number || '')} · ${esc(delivery.weight || '')} kg${delivery.cod ? `<br><b>COD: €${(+delivery.codAmount).toFixed(2)}</b>` : ''}</div>
<script>print()</script>`,
  };
}

/* ---------------- public API ---------------- */
async function book({ cfg, delivery, order, customer, company, manualTracking }) {
  const k = keyOf(delivery.courier); const c = cfg[k] || {}; const mode = c.mode || 'simulate';
  if (mode === 'simulate') return { tracking: fakeTracking(delivery.courier), labelAvailable: true, mode: 'simulated' };
  if (k === 'other' || mode === 'manual') {
    const t = String(manualTracking || '').trim();
    if (!t) throw new Error(`Enter the ${delivery.courier} tracking number from the courier's own system.`);
    return { tracking: t.slice(0, 40), labelAvailable: false, mode: 'manual' };
  }
  const r = await (k === 'acs' ? acs : boxnow).book({ c, delivery, order, customer, company });
  return { ...r, mode: 'live' };
}
async function label({ cfg, delivery, order, customer, company }) {
  const k = keyOf(delivery.courier);
  if (delivery.courierMode === 'live') return (k === 'acs' ? acs : boxnow).label({ c: cfg[k], delivery });
  if (delivery.courierMode === 'manual') throw Object.assign(new Error('Print the label from the courier\'s own system.'), { status: 400, expose: true });
  return simulatedLabel({ delivery, order, customer, company });
}
async function track({ cfg, delivery }) {
  const k = keyOf(delivery.courier);
  if (delivery.courierMode === 'live') return (k === 'acs' ? acs : boxnow).track({ c: cfg[k], delivery });
  return { status: null, events: null }; // simulated/manual: status is updated by hand
}
async function closeDay({ cfg, courier }) {
  if (courier !== 'ACS') throw new Error('Only ACS needs a daily pickup list.');
  if (modeOf(cfg, 'ACS') !== 'live') return { pickupList: 'SIM-' + today().replace(/-/g, ''), simulated: true };
  return acs.closeDay({ c: cfg.acs });
}

module.exports = { book, label, track, closeDay, status, DEFAULT_CONFIG, SECRET_PATHS, keyOf };
