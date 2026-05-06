const https = require('https');

const ADD_ON_PRICES = {
  drone_footage:  200,
  towels:           8, // per towel
  water_bottles:   25,
  ice:             50,
  beer_pong:       50,
};
const TAX_RATE = 0.085;

function request(method, path, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const base = process.env.SUPABASE_URL;
    const key  = process.env.SUPABASE_SECRET_KEY;
    const url  = new URL(base + '/rest/v1' + path);
    const bodyStr = body ? JSON.stringify(body) : null;

    const headers = {
      'apikey':        key,
      'Authorization': 'Bearer ' + key,
      'Content-Type':  'application/json',
      'Accept':        'application/json',
      ...extraHeaders,
    };
    if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);

    const req = https.request(
      { hostname: url.hostname, path: url.pathname + url.search, method, headers },
      (res) => {
        let raw = '';
        res.on('data', c => { raw += c; });
        res.on('end', () => {
          if (res.statusCode >= 400) {
            return reject(new Error(`Supabase ${method} ${path} → ${res.statusCode}: ${raw}`));
          }
          try { resolve(raw ? JSON.parse(raw) : null); } catch { resolve(null); }
        });
      }
    );
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function calcAddOns(addOnsRaw) {
  let a = {};
  try { a = typeof addOnsRaw === 'string' ? JSON.parse(addOnsRaw) : (addOnsRaw || {}); } catch { /* ignore */ }

  let total = 0;
  if (a.drone_footage)  total += ADD_ON_PRICES.drone_footage;
  if (a.towels)         total += ADD_ON_PRICES.towels * (parseInt(a.towels) || 1);
  if (a.water_bottles)  total += ADD_ON_PRICES.water_bottles;
  if (a.ice)            total += ADD_ON_PRICES.ice;
  if (a.beer_pong)      total += ADD_ON_PRICES.beer_pong;

  return total;
}

async function getBookings() {
  return (await request('GET', '/bookings?order=booked_at.desc')) || [];
}

async function saveBooking(booking) {
  console.log('[storage] saveBooking session:', booking.session_id);

  const add_on_total     = calcAddOns(booking.add_ons);
  const grandTotal       = parseFloat(booking.grand_total) || 0;
  const preTax           = grandTotal / (1 + TAX_RATE);
  const tax_amount       = parseFloat((grandTotal - preTax).toFixed(2));
  const charter_subtotal = parseFloat((preTax - add_on_total).toFixed(2));

  await request(
    'POST',
    '/bookings?on_conflict=session_id',
    { ...booking, add_on_total, tax_amount, charter_subtotal },
    { 'Prefer': 'resolution=merge-duplicates,return=minimal' }
  );

  console.log('[storage] saved booking:', booking.session_id);
}

async function markBookingPaid(session_id) {
  const rows = await request(
    'PATCH',
    '/bookings?session_id=eq.' + encodeURIComponent(session_id),
    { paid_in_full: true, remaining_balance: 0, payment_type: 'full' },
    { 'Prefer': 'return=representation' }
  );
  return rows && rows[0] ? rows[0] : null;
}

async function getBlackouts() {
  const rows = (await request('GET', '/blackouts?order=date.asc')) || [];
  return rows.map(r => r.date);
}

async function addBlackout(date) {
  await request(
    'POST',
    '/blackouts?on_conflict=date',
    { date },
    { 'Prefer': 'resolution=ignore-duplicates,return=minimal' }
  );
  return getBlackouts();
}

async function removeBlackout(date) {
  await request('DELETE', '/blackouts?date=eq.' + encodeURIComponent(date), null, {});
  return getBlackouts();
}

module.exports = { getBookings, saveBooking, markBookingPaid, getBlackouts, addBlackout, removeBlackout };
