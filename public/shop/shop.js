'use strict';
/* =========================================================================
   Public e-shop. Configured in BizOrganiser → Settings → E-shop builder.
   Orders go to POST /api/public/orders and appear in Orders (source e-shop).
   ========================================================================= */
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(+n || 0);
const r2 = n => Math.round((+n || 0) * 100) / 100;
let SHOP = null, cat = '';

/* ---------- cart (this browser only) ---------- */
function loadCart() { try { return JSON.parse(localStorage.getItem('shop.cart') || '[]'); } catch { return []; } }
let CART = loadCart();
function saveCart() { try { localStorage.setItem('shop.cart', JSON.stringify(CART)); } catch { /* private mode: keep in memory */ } $('cart-n').textContent = CART.length ? CART.reduce((a, i) => a + i.qty, 0) : ''; }
function toast(msg, err) { const t = $('toast'); t.textContent = msg; t.className = 'on' + (err ? ' err' : ''); clearTimeout(t._h); t._h = setTimeout(() => { t.className = ''; }, 2600); }

const product = id => SHOP.products.find(p => p.id === id);
function color(cat) { let h = 0; for (const ch of String(cat)) h = (h * 31 + ch.charCodeAt(0)) % 360; return `hsl(${h} 55% 45%)`; }
const img = p => p.image ? `<img class="ph" src="${esc(p.image)}" alt="${esc(p.name)}">` : `<div class="ph" style="background:${color(p.category)}" aria-hidden="true">${esc(p.name.replace(/[^A-Za-z]/g, '').slice(0, 2).toUpperCase())}</div>`;
const avail = p => ({ in: '<span class="avail in">In stock</span>', available: '<span class="avail in">Available</span>', low: '<span class="avail low">Only a few left</span>', out: '<span class="avail out">Made to order — ships a little later</span>' }[p.availability]);
const card = p => `<a class="prod" href="#/p/${esc(p.id)}">${img(p)}<div class="body"><small class="muted">${esc(p.category)}</small><h3>${esc(p.name)}</h3><div class="price">${money(p.price)}</div>${avail(p)}</div></a>`;

async function boot() {
  try { const res = await fetch('/api/public/shop'); SHOP = await res.json(); if (!res.ok) throw new Error(SHOP.error); }
  catch (e) { $('main').innerHTML = `<p class="center">The shop is not available right now. ${esc(e.message || '')}</p>`; return; }
  document.documentElement.style.setProperty('--accent', SHOP.accent);
  document.title = SHOP.title;
  $('logo').innerHTML = SHOP.logo ? `<img src="${esc(SHOP.logo)}" alt="">${esc(SHOP.title)}` : esc(SHOP.title);
  $('foot').innerHTML = `<b>${esc(SHOP.company.name)}</b><span>${esc(SHOP.company.address)}</span><span>${esc(SHOP.company.phone)}</span><a href="mailto:${esc(SHOP.company.email)}">${esc(SHOP.company.email)}</a><span>VAT ${esc(SHOP.company.vat)}</span><a href="#/terms">Terms & returns</a>`;
  CART = CART.filter(i => product(i.productId));
  saveCart(); route();
}
window.addEventListener('hashchange', () => { route(); window.scrollTo(0, 0); });

function route() {
  if (!SHOP) return;
  if (!SHOP.enabled) { $('main').innerHTML = `<div class="ok-box"><div class="big">🛠</div><h2>We'll be back soon</h2><p class="muted">The online shop is closed at the moment. Contact us at ${esc(SHOP.company.email)}.</p></div>`; return; }
  const [, page = '', id] = location.hash.split('/');
  const m = $('main');
  if (page === 'p') m.innerHTML = viewProduct(decodeURIComponent(id || ''));
  else if (page === 'products') m.innerHTML = viewProducts();
  else if (page === 'cart') m.innerHTML = viewCart();
  else if (page === 'checkout') m.innerHTML = viewCheckout();
  else if (page === 'about') m.innerHTML = `<div class="panel"><h2>About us</h2><div class="prose">${esc(SHOP.about || '')}</div></div>`;
  else if (page === 'terms') m.innerHTML = `<div class="panel"><h2>Terms, delivery & returns</h2><div class="prose">${esc(SHOP.terms || '')}</div></div>`;
  else m.innerHTML = viewHome();
}
function viewHome() {
  const feat = SHOP.featured.map(product).filter(Boolean);
  return `<section class="hero"><h1>${esc(SHOP.heroTitle || SHOP.title)}</h1><p>${esc(SHOP.heroText || SHOP.tagline)}</p><a class="btn light" href="#/products">Shop now</a></section>
    ${feat.length ? `<h2>Popular</h2><div class="grid">${feat.map(card).join('')}</div>` : ''}
    <h2>All products</h2><div class="grid">${SHOP.products.slice(0, 8).map(card).join('')}</div>
    ${SHOP.products.length > 8 ? `<p class="center"><a class="btn" href="#/products">See all ${SHOP.products.length} products</a></p>` : ''}
    ${SHOP.freeShippingOver ? `<p class="center muted">Free shipping on orders over ${money(SHOP.freeShippingOver)}</p>` : ''}`;
}
function viewProducts() {
  const cats = [...new Set(SHOP.products.map(p => p.category))].sort();
  const list = SHOP.products.filter(p => !cat || p.category === cat);
  return `<h2>Products</h2><div class="cats"><button class="${!cat ? 'on' : ''}" onclick="cat='';route()">All</button>${cats.map(c => `<button class="${cat === c ? 'on' : ''}" onclick='cat=${esc(JSON.stringify(c))};route()'>${esc(c)}</button>`).join('')}</div>
    <div class="grid">${list.map(card).join('') || '<p class="muted">No products in this category.</p>'}</div>`;
}
function viewProduct(id) {
  const p = product(id);
  if (!p) return `<p class="center">This product is no longer available. <a href="#/products">See all products</a></p>`;
  return `<p><a href="#/products">← All products</a></p><div class="detail">${img(p)}<div><small class="muted">${esc(p.category)} · ${esc(p.sku)}</small><h1 style="margin:6px 0 12px">${esc(p.name)}</h1>
    <div class="price" style="font-size:26px">${money(p.price)} <small class="muted sm">incl. VAT, per ${esc(p.unit)}</small></div>${avail(p)}
    ${p.description ? `<p class="prose">${esc(p.description)}</p>` : ''}
    <div class="qty"><label for="qty" class="muted sm">Quantity</label><input id="qty" type="number" min="1" max="999" value="1"><button class="btn primary" onclick="add('${esc(p.id)}')">Add to cart</button></div>
    <p class="muted sm">${SHOP.freeShippingOver ? `Free shipping over ${money(SHOP.freeShippingOver)}. ` : ''}${SHOP.shippingFee ? `Shipping ${money(SHOP.shippingFee)}.` : ''}</p></div></div>`;
}
function add(id) {
  const q = Math.max(1, Math.min(999, Math.round(+$('qty').value || 1)));
  const it = CART.find(i => i.productId === id);
  if (it) it.qty = Math.min(999, it.qty + q); else CART.push({ productId: id, qty: q });
  saveCart(); toast(`Added to cart: ${product(id).name}`);
}
function setQty(id, v) { const q = Math.max(0, Math.min(999, Math.round(+v || 0))); CART = CART.map(i => i.productId === id ? { ...i, qty: q } : i).filter(i => i.qty > 0); saveCart(); route(); }
function totals(payment) {
  const goods = r2(CART.reduce((a, i) => a + product(i.productId).price * i.qty, 0));
  const ship = SHOP.freeShippingOver && goods >= SHOP.freeShippingOver ? 0 : SHOP.shippingFee;
  const cod = payment === 'cod' ? SHOP.codFee : 0;
  return { goods, ship, cod, total: r2(goods + ship + cod) };
}
function viewCart() {
  if (!CART.length) return `<div class="ok-box"><div class="big">🛒</div><h2>Your cart is empty</h2><a class="btn primary" href="#/products">Browse products</a></div>`;
  const t = totals();
  return `<h2>Your cart</h2><div class="panel"><table><tbody>${CART.map(i => { const p = product(i.productId); return `<tr><td><a href="#/p/${esc(p.id)}">${esc(p.name)}</a><br><small class="muted">${money(p.price)} each</small></td>
      <td class="num" style="width:110px"><input type="number" min="0" max="999" value="${i.qty}" onchange="setQty('${esc(p.id)}',this.value)" aria-label="Quantity"></td><td class="num" style="width:110px">${money(p.price * i.qty)}</td></tr>`; }).join('')}
    <tr><td colspan="2">Shipping</td><td class="num">${t.ship ? money(t.ship) : 'Free'}</td></tr>
    <tr class="total"><td colspan="2">Total incl. VAT</td><td class="num">${money(t.goods + t.ship)}</td></tr></tbody></table>
    ${SHOP.freeShippingOver && t.ship ? `<p class="muted sm">Add ${money(SHOP.freeShippingOver - t.goods)} more for free shipping.</p>` : ''}
    <p style="text-align:right"><a class="btn primary" href="#/checkout">Checkout →</a></p></div>`;
}
function viewCheckout() {
  if (!CART.length) return viewCart();
  const first = SHOP.payments.cod ? 'cod' : 'bank';
  const t = totals(first);
  return `<h2>Checkout</h2><form class="checkout" id="co" onsubmit="event.preventDefault();placeOrder()">
    <div class="panel"><div class="form">
      <div class="full"><label for="c_name">Full name</label><input id="c_name" required maxlength="120" autocomplete="name"></div>
      <div><label for="c_email">Email</label><input id="c_email" type="email" required maxlength="160" autocomplete="email"></div>
      <div><label for="c_phone">Phone</label><input id="c_phone" type="tel" required maxlength="40" autocomplete="tel"></div>
      <div class="full"><label for="c_addr">Street address</label><input id="c_addr" required maxlength="200" autocomplete="street-address"></div>
      <div><label for="c_city">City</label><input id="c_city" required maxlength="80" autocomplete="address-level2"></div>
      <div><label for="c_zip">Postal code</label><input id="c_zip" required maxlength="12" autocomplete="postal-code"></div>
      <div class="full"><label for="c_notes">Notes (artwork details, delivery instructions…)</label><textarea id="c_notes" rows="3" maxlength="1000"></textarea></div>
      <input class="hp" id="c_website" tabindex="-1" autocomplete="off" aria-hidden="true">
    </div></div>
    <div class="panel"><h3 style="margin-top:0">Payment</h3><div class="pay">
      ${SHOP.payments.cod ? `<label><input type="radio" name="pay" value="cod" ${first === 'cod' ? 'checked' : ''} onchange="updTotal()"> Cash on delivery${SHOP.codFee ? ` (+${money(SHOP.codFee)})` : ''}</label>` : ''}
      ${SHOP.payments.bank ? `<label><input type="radio" name="pay" value="bank" ${first === 'bank' ? 'checked' : ''} onchange="updTotal()"> Bank transfer</label>` : ''}
    </div>
    <table style="margin-top:14px"><tbody><tr><td>Products</td><td class="num">${money(t.goods)}</td></tr><tr><td>Shipping</td><td class="num">${t.ship ? money(t.ship) : 'Free'}</td></tr>
      <tr id="codrow" ${t.cod ? '' : 'hidden'}><td>Cash on delivery fee</td><td class="num">${money(SHOP.codFee)}</td></tr>
      <tr class="total"><td>Total incl. VAT</td><td class="num" id="grand">${money(t.total)}</td></tr></tbody></table>
    <p class="muted sm">By placing the order you accept our <a href="#/terms">terms</a>.</p>
    <button class="btn primary" id="place" style="width:100%">Place order</button></div></form>`;
}
function updTotal() {
  const pay = document.querySelector('input[name=pay]:checked')?.value;
  const t = totals(pay); $('grand').textContent = money(t.total); $('codrow').hidden = !t.cod;
}
async function placeOrder() {
  const v = id => $(id).value.trim();
  $('place').disabled = true;
  try {
    const res = await fetch('/api/public/orders', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'BizOrganiser' },
      body: JSON.stringify({
        customer: { name: v('c_name'), email: v('c_email'), phone: v('c_phone'), address: v('c_addr'), city: v('c_city'), postalCode: v('c_zip') },
        lines: CART.map(({ productId, qty }) => ({ productId, qty })), payment: document.querySelector('input[name=pay]:checked')?.value, notes: v('c_notes'), website: v('c_website'),
      }),
    });
    const r = await res.json();
    if (!res.ok) throw new Error(r.error || 'The order could not be placed.');
    CART = []; saveCart();
    $('main').innerHTML = `<div class="panel ok-box"><div class="big">✅</div><h2>Thank you — order ${esc(r.number)} is confirmed</h2>
      <p>We've emailed you a confirmation. Total: <b>${money(r.total)}</b>.</p>
      ${r.bank ? `<p>Please pay by bank transfer to <b>${esc(r.bank.beneficiary)}</b><br>IBAN <b>${esc(r.bank.iban)}</b><br>Reference: <b>${esc(r.bank.reference)}</b></p>` : '<p>You pay the courier on delivery.</p>'}
      <a class="btn" href="#/">Back to the shop</a></div>`;
    history.replaceState(null, '', '#/done');
  } catch (e) { toast(e.message, true); $('place').disabled = false; }
}
boot();
