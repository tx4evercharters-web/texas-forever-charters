const https = require('https');
const TFCTimeSlots = require('./timeslots');

const ADD_ON_PRICES = {
  drone_footage:  200,
  towels:           8, // per towel
  water_bottles:   25,
  ice:             25,
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

  // Prefer webhook-provided fee breakdown; fall back to reverse-calc when missing.
  // The fallback assumes NO promo (LAKELIFE10) applied — rare path for new
  // bookings since the webhook always sends explicit fields. Math reflects
  // the post-2026-05-12 pricing (5% admin, no flat processing fee).
  let tax_amount       = parseFloat(booking.tax_amount || 0);
  let charter_subtotal = parseFloat(booking.charter_subtotal || 0);
  if (!tax_amount || !charter_subtotal) {
    const grandTotal      = parseFloat(booking.grand_total || 0);
    const subtotalPreFees = parseFloat(booking.charter_subtotal_pre_fees || (grandTotal / (1.05 * 1.085 * 1.029)));
    const adminFee        = Math.round(subtotalPreFees * 0.05 * 100) / 100;
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

async function findBookingByPaymentIntent(payment_intent_id) {
  if (!payment_intent_id) return null;
  const rows = await request('GET', '/bookings?payment_intent_id=eq.' + encodeURIComponent(payment_intent_id) + '&limit=1');
  return rows && rows[0] ? rows[0] : null;
}

/* Look up a booking by its customer-portal token. Filters out soft-deleted
   rows at the query layer so the portal endpoint can treat null returns as
   "404 not found" without re-checking deleted_at in JS. portal_token is a
   32-char hex string provisioned by the Phase 2 migration; uniqueness is
   enforced by a partial unique index on (portal_token) WHERE NOT NULL. */
async function findBookingByPortalToken(token) {
  if (!token) return null;
  const rows = await request(
    'GET',
    '/bookings?portal_token=eq.' + encodeURIComponent(token) +
    '&deleted_at=is.null&limit=1'
  );
  return rows && rows[0] ? rows[0] : null;
}

/* 16-byte hex token used as the public-facing booking identifier for
   /booking/<portal_token>. Matches the Phase 2 migration's
   encode(gen_random_bytes(16), 'hex') backfill pattern (32 hex chars).
   crypto is required lazily so this module's lightweight import path
   stays unchanged for callers that never generate tokens. */
function generatePortalToken() {
  return require('crypto').randomBytes(16).toString('hex');
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

// Returns the full blackout rows so callers can render per-vessel and
// per-time-slot scopes. Each row: { id, date, vessel, time_slot }.
async function getBlackouts() {
  const rows = (await request('GET', '/blackouts?order=date.asc&select=*')) || [];
  return rows.map(r => ({
    id:        r.id || null,
    date:      r.date,
    vessel:    r.vessel    || 'both',
    time_slot: r.time_slot || 'all',
  }));
}

// Add one blackout. Defaults preserve the original "block the whole day for
// both vessels" semantic so legacy callers passing just a date still work.
async function addBlackout(input) {
  const isString = typeof input === 'string';
  const date      = isString ? input : input.date;
  const vessel    = isString ? 'both' : (input.vessel    || 'both');
  const time_slot = isString ? 'all'  : (input.time_slot || 'all');
  if (!date) throw new Error('date required');
  if (!['yacht', 'pontoon', 'both'].includes(vessel)) throw new Error('vessel must be yacht, pontoon, or both');

  await request(
    'POST',
    '/blackouts?on_conflict=date,vessel,time_slot',
    { date, vessel, time_slot },
    { 'Prefer': 'resolution=ignore-duplicates,return=minimal' }
  );
  return getBlackouts();
}

// Remove a single blackout row by id.
async function removeBlackoutById(id) {
  if (!id) throw new Error('id required');
  await request('DELETE', '/blackouts?id=eq.' + encodeURIComponent(id), null, {});
  return getBlackouts();
}

// Legacy: remove ALL blackouts on a given date regardless of vessel/time_slot
// scope. Kept so older admin callers don't break; new UI uses the id path.
async function removeBlackout(date) {
  if (!date) throw new Error('date required');
  await request('DELETE', '/blackouts?date=eq.' + encodeURIComponent(date), null, {});
  return getBlackouts();
}

/* G16: find active bookings that an about-to-be-saved blackout would
   block. "Active" excludes cancelled and refunded. Match semantic is
   exact-string on time_slot (e.g. '10:00am' === '10:00am'); duration
   overlap (a 4hr 10:00am booking vs a 1:00pm blackout) is a known miss
   documented in docs/queue/g16-followup-blackout-edges.md and out of
   scope for the initial conflict-surfacing commit. */
async function findBookingConflictsForBlackout({ date, vessel, time_slot }) {
  if (!date) throw new Error('date required');
  const v  = vessel    || 'both';
  const ts = time_slot || 'all';
  const rows = (await request(
    'GET',
    '/bookings?date=eq.' + encodeURIComponent(date) +
      '&select=session_id,full_name,customer_email,phone,vessel,time_slot,date,charter_name,status,duration'
  )) || [];
  const matches = rows.filter(b => {
    if (b.status === 'cancelled' || b.status === 'refunded') return false;
    const vesselMatch = (v === 'both') || (b.vessel === v);
    const slotMatch   = (ts === 'all') || (b.time_slot === ts);
    return vesselMatch && slotMatch;
  });
  matches.sort((a, b) => {
    const sa = a.time_slot || '';
    const sb = b.time_slot || '';
    if (sa !== sb) return sa.localeCompare(sb);
    return (a.full_name || '').localeCompare(b.full_name || '');
  });
  return matches;
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
    /* Phase 2.5 — admin-created bookings get a portal_token at insert
       so the Copy/Send Portal Link button no longer has to backfill
       one on first click. The `booking.portal_token ||` guard preserves
       any token passed through by a future importer; not a known path
       today but cheap defense-in-depth. */
    portal_token:     booking.portal_token || generatePortalToken(),
  };

  await request('POST', '/bookings', record, { Prefer: 'return=minimal' });
  return { session_id, customer_id };
}

/* ── Waivers ── */

/* Fuzzy-match a booking by canonical charter coordinates. Used as a
   fallback by createWaiver and by scripts/backfill-waiver-links.js when
   a waiver has no usable session_id (manual bookings, generic
   /waiver.html visits, or stale links). Returns:
     { booking: <row>|null, candidates: <int>, ambiguous?: true }
   The caller treats `candidates !== 1` as "do not auto-link". */
async function findBookingByCharterMatch(charter_date, charter_time, vessel) {
  if (!charter_date || !charter_time || !vessel) {
    return { booking: null, candidates: 0 };
  }
  const t = TFCTimeSlots.normalize(charter_time);
  const v = String(vessel).toLowerCase().trim();
  if (!t || !v) return { booking: null, candidates: 0 };

  const path = '/bookings?select=id,session_id,date,time_slot,vessel,full_name,status' +
    '&date=eq.'      + encodeURIComponent(charter_date) +
    '&time_slot=eq.' + encodeURIComponent(t) +
    '&vessel=eq.'    + encodeURIComponent(v);
  const rows = await request('GET', path);
  if (!Array.isArray(rows) || rows.length === 0) {
    return { booking: null, candidates: 0 };
  }
  if (rows.length === 1) {
    return { booking: rows[0], candidates: 1 };
  }
  return { booking: null, candidates: rows.length, ambiguous: true };
}

async function createWaiver(fields) {
  // Step 1 — exact match by session_id (original behavior, fastest path).
  let booking = null;
  let autoLinked = false;
  if (fields.session_id) {
    booking = await findBookingBySessionId(fields.session_id);
  }

  // Step 2 — fuzzy fallback for waivers missing/stale session_id. Only
  // links when EXACTLY ONE booking matches the (date, time, vessel)
  // triple; ambiguous matches (multiple charters that day on the same
  // vessel at the same time — rare but possible) are left as orphans
  // for manual review.
  if (!booking) {
    const fuzzy = await findBookingByCharterMatch(
      fields.charter_date, fields.charter_time, fields.vessel
    );
    if (fuzzy.booking) {
      booking = fuzzy.booking;
      autoLinked = true;
      console.log('[createWaiver] fuzzy-linked to booking',
        booking.id, '(session:', booking.session_id || '—', ')',
        'via', fields.charter_date, TFCTimeSlots.normalize(fields.charter_time), fields.vessel);
    } else if (fuzzy.ambiguous) {
      console.warn('[createWaiver] fuzzy match ambiguous —',
        fuzzy.candidates, 'candidates for',
        fields.charter_date, fields.charter_time, fields.vessel,
        '— leaving booking_id NULL for manual review');
    }
  }

  /* Normalize charter_time on save so we never persist a non-canonical
     string (e.g., "10:30 AM" with a space) — both for fresh waivers and
     for any source that bypasses the waiver.html dropdown. Booking-side
     values are already canonical, so this only matters on the fallback
     path. */
  const normalizedFieldTime = fields.charter_time
    ? TFCTimeSlots.normalize(fields.charter_time)
    : null;

  const record = {
    booking_id:   booking ? booking.id : null,
    auto_linked:  autoLinked,
    session_id:   fields.session_id || null,
    charter_date: booking ? booking.date         : (fields.charter_date || null),
    charter_time: booking ? booking.time_slot    : (normalizedFieldTime || null),
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

/* Returns all waivers enriched with their linked-booking metadata and a
   computed link_status field. Used by the admin Waivers tab — the
   frontend needs the BOOKING'S session_id (not the waiver's own
   session_id, which may be stale or absent after a fuzzy match) so the
   "Open booking" button can drive openEditModal(session_id).

   Shape per row:
     { ...waiver fields,
       booking: { id, session_id, full_name, status, date, time_slot, vessel } | null,
       link_status: 'linked' | 'auto_linked' | 'orphan'
     }                                                                   */
async function listAllWaiversEnriched() {
  const waivers = await getAllWaivers();
  if (!Array.isArray(waivers) || waivers.length === 0) return [];

  /* Collect unique non-null booking_ids and fetch them in one batch.
     PostgREST `id=in.(uuid1,uuid2,...)` syntax — each id must be URL-
     encoded. Empty IN clauses are rejected, hence the early skip. */
  const bookingIds = [...new Set(
    waivers.map(w => w.booking_id).filter(Boolean)
  )];
  const bookingsById = {};
  if (bookingIds.length > 0) {
    const idList = bookingIds.map(encodeURIComponent).join(',');
    const rows = await request(
      'GET',
      '/bookings?id=in.(' + idList + ')' +
      '&select=id,session_id,full_name,status,date,time_slot,vessel'
    ) || [];
    for (const b of rows) bookingsById[b.id] = b;
  }

  return waivers.map(function (w) {
    const booking = w.booking_id ? (bookingsById[w.booking_id] || null) : null;
    let link_status;
    if (!booking) {
      link_status = 'orphan';
    } else if (w.auto_linked === true) {
      link_status = 'auto_linked';
    } else {
      link_status = 'linked';
    }
    return Object.assign({}, w, { booking, link_status });
  });
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

/* Count signed waivers linked to a specific booking by session_id. Used by
   the customer portal waiver-status block. Pattern mirrors
   countWaiversByIpInLastHour: PostgREST returns a Content-Range header
   like "0-0/N" when Prefer: count=exact is set, so we can read the count
   without loading any rows.

   Known limitation: waivers fuzzy-linked to a booking via booking_id alone
   (no session_id, per createWaiver's fallback path at line 581+) are NOT
   counted here. Rare edge case (manual-flow bookings where the waiver was
   signed before the booking was linked). Documented for a future
   enhancement that takes both session_id AND booking_id as inputs. */
async function countWaiversBySessionId(session_id) {
  if (!session_id) return 0;
  return new Promise((resolve, reject) => {
    const u = new URL(process.env.SUPABASE_URL + '/rest/v1/waivers?session_id=eq.' + encodeURIComponent(session_id) + '&select=id&limit=1');
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

/* ── Leads (consent-based exit-intent capture) ────────────────────────
   Helpers for the `leads` table. RLS is enabled with no policies, so
   only the service-role key (this lib's `request()` helper) can read or
   write. The capture-lead endpoint inserts; stripe-webhook updates
   status on lifecycle events; cron-reminders queries for the daily
   digest and the 90-day retention cleanup. ───────────────────────── */

/* Insert a new lead row. Caller is responsible for validating
   full_name + customer_email upstream (DB has NOT NULL constraints
   that will reject a bad row but with a cryptic error). add_ons should
   be a plain JS object — the JSONB column accepts it natively. */
async function saveLead(lead) {
  const rows = await request(
    'POST',
    '/leads',
    lead,
    { Prefer: 'return=representation' }
  );
  return rows && rows[0] ? rows[0] : null;
}

/* Find the most recent NON-CONVERTED lead for a customer email. Used by
   the webhook's checkout.session.completed handler to flip a captured
   lead into status='converted' when the customer comes back and pays.
   Excludes already-converted rows so re-completing a booking under the
   same email doesn't re-touch old conversions. */
async function findActiveLeadByEmail(customer_email) {
  if (!customer_email) return null;
  const rows = await request(
    'GET',
    '/leads?customer_email=eq.' + encodeURIComponent(customer_email) +
    '&status=neq.converted' +
    '&order=captured_at.desc&limit=1'
  );
  return rows && rows[0] ? rows[0] : null;
}

async function findLeadByStripeSession(stripe_session_id) {
  if (!stripe_session_id) return null;
  const rows = await request(
    'GET',
    '/leads?stripe_session_id=eq.' + encodeURIComponent(stripe_session_id) + '&limit=1'
  );
  return rows && rows[0] ? rows[0] : null;
}

async function findLeadByPaymentIntent(payment_intent_id) {
  if (!payment_intent_id) return null;
  const rows = await request(
    'GET',
    '/leads?payment_intent_id=eq.' + encodeURIComponent(payment_intent_id) + '&limit=1'
  );
  return rows && rows[0] ? rows[0] : null;
}

/* Generic PATCH by lead id. Trigger on the table auto-bumps updated_at. */
async function patchLead(id, updates) {
  if (!id) return null;
  const rows = await request(
    'PATCH',
    '/leads?id=eq.' + encodeURIComponent(id),
    updates,
    { Prefer: 'return=representation' }
  );
  return rows && rows[0] ? rows[0] : null;
}

/* List leads for the admin tab. `status` filter is optional; passing
   undefined returns all rows. Sort newest-first by captured_at. */
async function listLeads(opts) {
  opts = opts || {};
  let path = '/leads?select=*&order=captured_at.desc&limit=' + (opts.limit || 500);
  if (opts.status) {
    path += '&status=eq.' + encodeURIComponent(opts.status);
  }
  return (await request('GET', path)) || [];
}

/* Leads captured in the last N hours, optionally restricted to a list
   of statuses. Used by the daily-digest cron pass. */
async function listRecentLeads(hours, statuses) {
  const sinceIso = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  let path = '/leads?select=*' +
    '&captured_at=gte.' + encodeURIComponent(sinceIso) +
    '&order=captured_at.desc';
  if (Array.isArray(statuses) && statuses.length > 0) {
    path += '&status=in.(' + statuses.map(encodeURIComponent).join(',') + ')';
  }
  return (await request('GET', path)) || [];
}

/* Find bookings that *might* belong to a given lead — match by
   customer_email OR phone OR full_name within the last 30 days.
   Used by the Log Contact modal's "Booked → Which booking?" picker.
   Returns rows sorted most-recent-first, capped at 20.
   Empty strings/nulls in the lead's fields are skipped so we don't
   match on '' = ''. */
async function findBookingsForLead(lead, opts) {
  opts = opts || {};
  const filters = [];
  if (lead && lead.customer_email) {
    filters.push('customer_email.ilike.' + encodeURIComponent(lead.customer_email.trim().toLowerCase()));
  }
  if (lead && lead.phone) {
    filters.push('phone.ilike.' + encodeURIComponent('%' + lead.phone.trim() + '%'));
  }
  if (lead && lead.full_name) {
    filters.push('full_name.ilike.' + encodeURIComponent(lead.full_name.trim()));
  }
  if (filters.length === 0) return [];
  const sinceIso = new Date(Date.now() - (opts.days || 30) * 24 * 60 * 60 * 1000).toISOString();
  const path = '/bookings?select=session_id,date,time_slot,vessel,full_name,customer_email,grand_total,status' +
    '&or=(' + filters.join(',') + ')' +
    '&booked_at=gte.' + encodeURIComponent(sinceIso) +
    '&order=date.desc&limit=' + (opts.limit || 20);
  return (await request('GET', path)) || [];
}

/* Batch-fetch (session_id, date) tuples for a set of session IDs.
   Used by listLeads to compute outcome_editable for leads with
   linked bookings without making N separate round-trips. */
async function findBookingDatesBySessionIds(sessionIds) {
  if (!Array.isArray(sessionIds) || sessionIds.length === 0) return {};
  const inList = sessionIds.map(s => encodeURIComponent(s)).join(',');
  const rows = (await request('GET',
    '/bookings?select=session_id,date,status&session_id=in.(' + inList + ')'
  )) || [];
  const map = {};
  for (const r of rows) map[r.session_id] = { date: r.date, status: r.status };
  return map;
}

/* Hard-delete unconverted lead rows older than `days` days. Privacy
   policy commits us to a 90-day retention for unconverted leads;
   converted leads stay because they're a record of an actual booking
   relationship. */
async function deleteStaleLeads(days) {
  const cutoffIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  /* PostgREST DELETE returns the deleted rows when Prefer: return=representation
     is set, so the cron can log how many were purged. */
  const rows = await request(
    'DELETE',
    '/leads?captured_at=lt.' + encodeURIComponent(cutoffIso) +
    '&status=neq.converted',
    null,
    { Prefer: 'return=representation' }
  );
  return Array.isArray(rows) ? rows.length : 0;
}

module.exports = {
  getBookings, saveBooking, markBookingPaid, updateBookingPayment,
  getBlackouts, addBlackout, removeBlackout, removeBlackoutById, findBookingConflictsForBlackout,
  searchCustomers, findCustomerByEmail, addManualBooking,
  listCustomers, updateCustomer, createCustomer, deleteCustomer,
  importHistoricalBookings,
  patchBooking, findBookingBySessionId, findBookingByPaymentIntent, findBookingByPortalToken, generatePortalToken, deleteBookingRow,
  createWaiver, listWaivers, getAllWaivers, listAllWaiversEnriched, countWaiversByIpInLastHour, countWaiversBySessionId,
  saveLead, findActiveLeadByEmail, findLeadByStripeSession, findLeadByPaymentIntent,
  patchLead, listLeads, listRecentLeads, deleteStaleLeads,
  findBookingsForLead, findBookingDatesBySessionIds,
};
