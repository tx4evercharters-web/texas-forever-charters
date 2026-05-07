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
    if (!base) return reject(new Error('SUPABASE_URL env var is not set on this function. Check Vercel project env vars for the current environment.'));
    if (!key)  return reject(new Error('SUPABASE_SECRET_KEY env var is not set on this function. Check Vercel project env vars for the current environment.'));
    let url;
    try { url = new URL(base.replace(/\/+$/, '') + '/rest/v1' + path); }
    catch (e) { return reject(new Error(`Failed to build Supabase URL from SUPABASE_URL=${JSON.stringify(base)} + path=${JSON.stringify(path)}: ${e.message}`)); }
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

  // Upsert the matching customer record (failure here must not undo the booking save)
  try {
    if (booking.customer_email) {
      await upsertCustomerForBooking({
        email:        booking.customer_email,
        phone:        booking.phone,
        full_name:    booking.full_name,
        booking_date: booking.booked_at || booking.date,
        grand_total:  booking.grand_total,
        newsletter:   booking.newsletter,
      });
    }
  } catch (err) {
    console.error('[storage] customer upsert failed for', booking.session_id, '—', err.message);
  }
}

async function patchBooking(session_id, updates) {
  if (!session_id) return null;
  const rows = await request(
    'PATCH',
    '/bookings?session_id=eq.' + encodeURIComponent(session_id),
    updates,
    { Prefer: 'return=representation' }
  );
  return rows && rows[0] ? rows[0] : null;
}

async function findBookingBySessionId(session_id) {
  if (!session_id) return null;
  const rows = await request('GET', '/bookings?session_id=eq.' + encodeURIComponent(session_id) + '&limit=1');
  return rows && rows[0] ? rows[0] : null;
}

async function deleteBookingRow(session_id) {
  if (!session_id) return false;
  await request('DELETE', '/bookings?session_id=eq.' + encodeURIComponent(session_id), null, { Prefer: 'return=minimal' });
  return true;
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
  const allowed = ['notes', 'tags', 'full_name', 'email', 'phone', 'city', 'state', 'newsletter_subscribed', 'sms_subscribed'];
  const updates = {};
  for (const k of allowed) {
    if (fields[k] !== undefined) updates[k] = fields[k];
  }
  if (updates.email) updates.email = String(updates.email).trim().toLowerCase() || null;
  if (Object.keys(updates).length === 0) return null;
  const rows = await request(
    'PATCH',
    '/customers?id=eq.' + encodeURIComponent(id),
    updates,
    { Prefer: 'return=representation' }
  );
  return rows && rows[0] ? rows[0] : null;
}

async function createCustomer(fields) {
  const full_name = (fields.full_name || '').trim();
  if (!full_name) throw new Error('full_name is required');
  const email = fields.email ? String(fields.email).trim().toLowerCase() : null;

  // Dedup by email when one is provided
  if (email) {
    const existing = await findCustomerByEmail(email);
    if (existing) return { duplicate: true, existing };
  }

  const record = {
    full_name,
    email,
    phone:                 fields.phone || null,
    city:                  fields.city || null,
    state:                 fields.state || null,
    notes:                 fields.notes || null,
    tags:                  Array.isArray(fields.tags) ? fields.tags : [],
    newsletter_subscribed: !!fields.newsletter_subscribed,
    sms_subscribed:        !!fields.sms_subscribed,
    total_bookings:        0,
    total_spent:           0,
    lifetime_value:        0,
  };
  const created = await request('POST', '/customers', record, { Prefer: 'return=representation' });
  const row = Array.isArray(created) ? created[0] : created;
  return { duplicate: false, customer: row };
}

async function deleteCustomer(id) {
  if (!id) throw new Error('id is required');
  const idEnc = encodeURIComponent(id);
  // Detach bookings first so the customer row can be removed without orphaning data
  await request('PATCH', `/bookings?customer_id=eq.${idEnc}`, { customer_id: null }, { Prefer: 'return=minimal' });
  await request('DELETE', `/customers?id=eq.${idEnc}`, null, { Prefer: 'return=minimal' });
  return { ok: true };
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

function truthyFlag(v) {
  if (v === true) return true;
  if (v == null || v === false) return false;
  const t = String(v).trim().toLowerCase();
  return t === 'true' || t === '1' || t === 'yes' || t === 'y' || t === 'subscribed' || t === 'on';
}

async function upsertCustomerForBooking({ email, phone, full_name, booking_date, grand_total, newsletter, sms_subscribed }) {
  if (!email) return null;
  const lc = email.trim().toLowerCase();
  const existing = await findCustomerByEmail(lc);
  const amount = parseFloat(grand_total) || 0;
  const dateIso = booking_date || new Date().toISOString();
  const wantsNewsletter = truthyFlag(newsletter);
  const wantsSms        = truthyFlag(sms_subscribed);

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
    // Sticky: once subscribed, stay subscribed. Only flip to true here.
    if (wantsNewsletter && !existing.newsletter_subscribed) updates.newsletter_subscribed = true;
    if (wantsSms        && !existing.sms_subscribed)        updates.sms_subscribed        = true;
    await request('PATCH', `/customers?id=eq.${existing.id}`, updates, { Prefer: 'return=minimal' });
    return existing.id;
  }

  const record = {
    email:              lc,
    phone:              phone     || null,
    full_name:          full_name || null,
    first_booking_date: dateIso,
    last_booking_date:  dateIso,
    total_bookings:     1,
    total_spent:        amount,
    lifetime_value:     amount,
  };
  if (wantsNewsletter) record.newsletter_subscribed = true;
  if (wantsSms)        record.sms_subscribed        = true;

  const created = await request('POST', '/customers', record, { Prefer: 'return=representation' });
  return Array.isArray(created) ? created[0]?.id : created?.id;
}

function normalizePhoneDigits(p) {
  return String(p || '').replace(/\D/g, '').slice(-10);
}

async function importHistoricalBookings(rows) {
  const results = { imported: 0, customers_created: 0, customers_matched: 0, errors: [] };
  if (!Array.isArray(rows) || rows.length === 0) return results;

  // Pre-load customers once for fast in-memory lookup; keys updated as we go
  const allCustomers = (await request('GET', '/customers?limit=10000')) || [];
  const byEmail = new Map();
  const byPhone = new Map();
  for (const c of allCustomers) {
    if (c.email) byEmail.set(c.email.toLowerCase(), c);
    const ph = normalizePhoneDigits(c.phone);
    if (ph.length >= 7) byPhone.set(ph, c);
  }

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    try {
      const emailRaw = (r.customer_email || '').trim().toLowerCase();
      const email = emailRaw && emailRaw.includes('@') ? emailRaw : null;
      const phone = r.phone ? String(r.phone).trim() : null;
      const phoneNorm = normalizePhoneDigits(phone);

      if (!email && phoneNorm.length < 7) {
        results.errors.push({ row: i + 1, error: 'Missing both email and phone — cannot dedup customer' });
        continue;
      }

      const total      = parseFloat(r.grand_total || r.total || 0) || 0;
      const date       = r.date || '';
      const booked_at  = r.booked_at || (date ? date + 'T12:00:00Z' : new Date().toISOString());
      const session_id = r.session_id ||
        'historical_' + Date.now() + '_' + i + '_' + Math.random().toString(36).slice(2, 6);

      // Match by email first, fall back to phone
      let existing = null;
      if (email) existing = byEmail.get(email);
      if (!existing && phoneNorm.length >= 7) existing = byPhone.get(phoneNorm);

      const wantsNewsletter = truthyFlag(r.newsletter);
      const wantsSms        = truthyFlag(r.sms_subscribed);

      let customer_id;
      if (existing) {
        const updates = {
          total_bookings:    (parseInt(existing.total_bookings) || 0) + 1,
          total_spent:       (parseFloat(existing.total_spent)   || 0) + total,
          lifetime_value:    (parseFloat(existing.lifetime_value)|| 0) + total,
          last_booking_date: (!existing.last_booking_date || booked_at > existing.last_booking_date) ? booked_at : existing.last_booking_date,
          phone:             phone     || existing.phone,
          full_name:         r.full_name || existing.full_name,
          email:             email     || existing.email,
        };
        if (!existing.first_booking_date || booked_at < existing.first_booking_date) updates.first_booking_date = booked_at;
        if (wantsNewsletter && !existing.newsletter_subscribed) updates.newsletter_subscribed = true;
        if (wantsSms        && !existing.sms_subscribed)        updates.sms_subscribed        = true;
        await request('PATCH', `/customers?id=eq.${existing.id}`, updates, { Prefer: 'return=minimal' });
        Object.assign(existing, updates);
        customer_id = existing.id;
        results.customers_matched += 1;
      } else {
        const newRec = {
          email,
          phone:              phone || null,
          full_name:          r.full_name || null,
          first_booking_date: booked_at,
          last_booking_date:  booked_at,
          total_bookings:     1,
          total_spent:        total,
          lifetime_value:     total,
        };
        if (wantsNewsletter) newRec.newsletter_subscribed = true;
        if (wantsSms)        newRec.sms_subscribed        = true;
        const created = await request('POST', '/customers', newRec, { Prefer: 'return=representation' });
        const newCust = Array.isArray(created) ? created[0] : created;
        customer_id = newCust && newCust.id;
        if (newCust) {
          if (newCust.email) byEmail.set(newCust.email.toLowerCase(), newCust);
          if (phoneNorm.length >= 7) byPhone.set(phoneNorm, newCust);
        }
        results.customers_created += 1;
      }

      const record = {
        session_id,
        booked_at,
        customer_id,
        date,
        time_slot:               r.time_slot || null,
        duration:                r.duration ? parseInt(r.duration) : null,
        party_size:              r.party_size ? parseInt(r.party_size) : null,
        vessel:                  r.vessel || null,
        experience:              r.experience || null,
        charter_name:            r.charter_name || null,
        full_name:               r.full_name || null,
        customer_email:          email,
        phone:                   phone,
        city:                    r.city || null,
        state:                   r.state || null,
        grand_total:             total,
        amount_total:            Math.round(total * 100),
        source:                  'historical_import',
        source_notes:            r.source_notes || null,
        payment_type:            'full',
        payment_method_external: 'external_platform',
        paid_in_full:            true,
        remaining_balance:       0,
        created_by_admin:        true,
        add_ons:                 null,
        add_on_total:            0,
      };

      await request('POST', '/bookings', record, { Prefer: 'return=minimal' });
      results.imported += 1;
    } catch (err) {
      results.errors.push({ row: i + 1, error: err.message });
    }
  }
  return results;
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

/* ── Waivers ── */

async function createWaiver(fields) {
  // Look up the booking by session_id (if provided) so we can stamp booking_id
  // and copy the canonical charter details onto the waiver row.
  let booking = null;
  if (fields.session_id) {
    booking = await findBookingBySessionId(fields.session_id);
  }

  const record = {
    booking_id:   booking ? booking.id : null,
    session_id:   fields.session_id || null,
    charter_date: booking ? booking.date         : (fields.charter_date || null),
    charter_time: booking ? booking.time_slot    : (fields.charter_time || null),
    vessel:       booking ? booking.vessel       : (fields.vessel       || null),
    organizer_name: booking ? (booking.full_name || booking.charter_name) : (fields.organizer_name || null),
    signer_first_name: fields.signer_first_name,
    signer_last_name:  fields.signer_last_name,
    signer_email:      fields.signer_email      || null,
    signer_phone:      fields.signer_phone      || null,
    date_of_birth:     fields.date_of_birth     || null,
    age:               fields.age != null ? parseInt(fields.age) : null,
    emergency_contact_name:         fields.emergency_contact_name         || null,
    emergency_contact_phone:        fields.emergency_contact_phone        || null,
    emergency_contact_relationship: fields.emergency_contact_relationship || null,
    is_minor:              !!fields.is_minor,
    guardian_name:         fields.guardian_name         || null,
    guardian_relationship: fields.guardian_relationship || null,
    media_release_accepted: fields.media_release_accepted !== false,
    waiver_text_version:    fields.waiver_text_version || 'v1',
    digital_signature:      fields.digital_signature,
    ip_address:             fields.ip_address || null,
    user_agent:             fields.user_agent || null,
  };
  const rows = await request('POST', '/waivers', record, { Prefer: 'return=representation' });
  return Array.isArray(rows) ? rows[0] : rows;
}

async function listWaivers(filter) {
  const f = filter || {};
  const params = ['order=signed_at.desc', 'limit=500'];
  if (f.session_id)     params.push('session_id=eq.' + encodeURIComponent(f.session_id));
  if (f.booking_id)     params.push('booking_id=eq.' + encodeURIComponent(f.booking_id));
  if (f.charter_date)   params.push('charter_date=eq.' + encodeURIComponent(f.charter_date));
  if (f.signer_email)   params.push('signer_email=ilike.' + encodeURIComponent(f.signer_email.toLowerCase()));
  return (await request('GET', '/waivers?' + params.join('&'))) || [];
}

async function getAllWaivers() {
  return (await request('GET', '/waivers?order=signed_at.desc&limit=10000')) || [];
}

async function countWaiversByIpInLastHour(ip) {
  if (!ip) return 0;
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  // PostgREST count via Prefer: count=exact; we ask for 0 rows + just the count
  return new Promise((resolve, reject) => {
    const u = new URL(process.env.SUPABASE_URL + '/rest/v1/waivers?ip_address=eq.' + encodeURIComponent(ip) + '&signed_at=gte.' + encodeURIComponent(since) + '&select=id&limit=1');
    const req = require('https').request({
      hostname: u.hostname,
      path:     u.pathname + u.search,
      method:   'GET',
      headers: {
        apikey:        process.env.SUPABASE_SECRET_KEY,
        Authorization: 'Bearer ' + process.env.SUPABASE_SECRET_KEY,
        Prefer:        'count=exact',
      },
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error('count failed: ' + res.statusCode + ' ' + raw));
        const range = res.headers['content-range'] || '';
        const n = parseInt((range.split('/')[1] || '0'), 10) || 0;
        resolve(n);
      });
    });
    req.on('error', reject);
    req.end();
  });
}

module.exports = {
  getBookings, saveBooking, markBookingPaid, updateBookingPayment,
  getBlackouts, addBlackout, removeBlackout,
  searchCustomers, findCustomerByEmail, addManualBooking,
  listCustomers, updateCustomer, createCustomer, deleteCustomer,
  importHistoricalBookings,
  patchBooking, findBookingBySessionId, deleteBookingRow,
  createWaiver, listWaivers, getAllWaivers, countWaiversByIpInLastHour,
};
