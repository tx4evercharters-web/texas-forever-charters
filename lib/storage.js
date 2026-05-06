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

  const add_on_total = calcAddOns(booking.add_ons);

  // Prefer webhook-provided fee breakdown; fall back to reverse-calc when missing
  let tax_amount       = parseFloat(booking.tax_amount || 0);
  let charter_subtotal = parseFloat(booking.charter_subtotal || 0);
  if (!tax_amount || !charter_subtotal) {
    const grandTotal      = parseFloat(booking.grand_total || 0);
    const subtotalPreFees = parseFloat(booking.charter_subtotal_pre_fees || (grandTotal / (1.10 * 1.085 * 1.029)));
    const adminFee        = Math.round(subtotalPreFees * 0.10 * 100) / 100;
    const calcTax         = Math.round((subtotalPreFees + adminFee) * 0.085 * 100) / 100;
    if (!tax_amount)       tax_amount       = parseFloat(calcTax.toFixed(2));
    if (!charter_subtotal) charter_subtotal = parseFloat((subtotalPreFees - add_on_total).toFixed(2));
  }

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

async function updateBookingPayment(session_id, fields) {
  // Whitelist what can be updated to avoid stray columns
  const allowed = ['amount_total', 'paid_in_full', 'remaining_balance', 'payment_method_external', 'payment_type'];
  const updates = {};
  for (const k of allowed) {
    if (fields[k] !== undefined) updates[k] = fields[k];
  }
  if (Object.keys(updates).length === 0) return null;

  const rows = await request(
    'PATCH',
    '/bookings?session_id=eq.' + encodeURIComponent(session_id),
    updates,
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

/* ── Customers ── */

async function listCustomers() {
  return (await request('GET', '/customers?order=lifetime_value.desc.nullslast&limit=1000')) || [];
}

async function updateCustomer(id, fields) {
  if (!id) return null;
  // Whitelist editable fields
  const allowed = ['notes', 'tags', 'full_name', 'phone', 'city', 'state'];
  const updates = {};
  for (const k of allowed) {
    if (fields[k] !== undefined) updates[k] = fields[k];
  }
  if (Object.keys(updates).length === 0) return null;
  const rows = await request(
    'PATCH',
    '/customers?id=eq.' + encodeURIComponent(id),
    updates,
    { Prefer: 'return=representation' }
  );
  return rows && rows[0] ? rows[0] : null;
}

async function searchCustomers(query) {
  const q = (query || '').trim();
  if (q.length < 2) return [];
  const enc = encodeURIComponent('%' + q.toLowerCase() + '%');
  const path = `/customers?or=(email.ilike.${enc},phone.ilike.${enc},full_name.ilike.${enc})&order=last_booking_date.desc.nullslast&limit=8`;
  return (await request('GET', path)) || [];
}

async function findCustomerByEmail(email) {
  if (!email) return null;
  const e = encodeURIComponent(email.trim().toLowerCase());
  const rows = (await request('GET', `/customers?email=eq.${e}&limit=1`)) || [];
  return rows[0] || null;
}

async function upsertCustomerForBooking({ email, phone, full_name, booking_date, grand_total }) {
  if (!email) return null;
  const lc = email.trim().toLowerCase();
  const existing = await findCustomerByEmail(lc);
  const amount = parseFloat(grand_total) || 0;
  const dateIso = booking_date || new Date().toISOString();

  if (existing) {
    const updates = {
      total_bookings:    (parseInt(existing.total_bookings) || 0) + 1,
      total_spent:       (parseFloat(existing.total_spent) || 0) + amount,
      lifetime_value:    (parseFloat(existing.lifetime_value) || 0) + amount,
      last_booking_date: (!existing.last_booking_date || dateIso > existing.last_booking_date) ? dateIso : existing.last_booking_date,
      phone:             phone     || existing.phone,
      full_name:         full_name || existing.full_name,
    };
    if (!existing.first_booking_date || dateIso < existing.first_booking_date) {
      updates.first_booking_date = dateIso;
    }
    await request('PATCH', `/customers?id=eq.${existing.id}`, updates, { Prefer: 'return=minimal' });
    return existing.id;
  }

  const created = await request('POST', '/customers', {
    email:              lc,
    phone:              phone     || null,
    full_name:          full_name || null,
    first_booking_date: dateIso,
    last_booking_date:  dateIso,
    total_bookings:     1,
    total_spent:        amount,
    lifetime_value:     amount,
  }, { Prefer: 'return=representation' });
  return Array.isArray(created) ? created[0]?.id : created?.id;
}

async function addManualBooking(booking) {
  const session_id = booking.session_id ||
    'manual_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const booked_at  = booking.booked_at || new Date().toISOString();

  const customer_id = await upsertCustomerForBooking({
    email:        booking.customer_email,
    phone:        booking.phone,
    full_name:    booking.full_name,
    booking_date: booked_at,
    grand_total:  booking.grand_total,
  });

  // Convert add_ons object → JSON string to match webhook's stored shape
  const addOnsField = booking.add_ons && typeof booking.add_ons === 'object'
    ? JSON.stringify(booking.add_ons)
    : booking.add_ons;

  const record = {
    ...booking,
    session_id,
    booked_at,
    customer_id,
    add_ons:          addOnsField,
    add_on_total:     calcAddOns(booking.add_ons),
    created_by_admin: true,
  };

  await request('POST', '/bookings', record, { Prefer: 'return=minimal' });
  return { session_id, customer_id };
}

module.exports = {
  getBookings, saveBooking, markBookingPaid, updateBookingPayment,
  getBlackouts, addBlackout, removeBlackout,
  searchCustomers, findCustomerByEmail, addManualBooking,
  listCustomers, updateCustomer,
};
