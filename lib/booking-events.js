const https = require('https');

/* ── booking_events audit-log helper ─────────────────────────────────
   First application use of the booking_events table since the Phase 2
   migration (commit ce62913) created it. The table has RLS enabled with
   no policies, so only the service-role key (this lib's request()
   helper) can read or write.

   logBookingEvent(booking_session_id, event_type, event_data, created_by)
   - Best-effort: catches errors and logs them but does NOT throw. A
     logging failure must not break the calling flow (e.g., a webhook
     handler that already mutated booking state). State mutation comes
     FIRST, audit row writes SECOND.
   - event_data is a plain object; PostgREST stores it natively in the
     jsonb column.

   The request() helper below is intentionally duplicated from
   lib/storage.js per the Phase 4 Commit 1 Option A pattern (duplicate-
   over-share until 3+ files need the same helper). Future consolidation
   when more lib files need direct Supabase access. */

function request(method, path, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const base = process.env.SUPABASE_URL;
    const key  = process.env.SUPABASE_SECRET_KEY;
    if (!base) return reject(new Error('SUPABASE_URL env var is not set on this function.'));
    if (!key)  return reject(new Error('SUPABASE_SECRET_KEY env var is not set on this function.'));
    let url;
    try { url = new URL(base.replace(/\/+$/, '') + '/rest/v1' + path); }
    catch (e) { return reject(new Error('Failed to build Supabase URL: ' + e.message)); }
    const bodyStr = body ? JSON.stringify(body) : null;

    const headers = {
      apikey:         key,
      Authorization:  'Bearer ' + key,
      'Content-Type': 'application/json',
      Accept:         'application/json',
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
            return reject(new Error('Supabase ' + method + ' ' + path + ' → ' + res.statusCode + ': ' + raw));
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

/* Append a row to booking_events. Best-effort: catches and logs any
   Supabase failure so the caller's state-mutation flow is not blocked
   by an audit-log write failure.

   Returns true on success, false on failure (caller usually ignores). */
async function logBookingEvent(booking_session_id, event_type, event_data, created_by) {
  if (!booking_session_id || !event_type) {
    console.error('[booking-events] missing required field — session_id:', booking_session_id, 'event_type:', event_type);
    return false;
  }
  try {
    await request('POST', '/booking_events', {
      booking_session_id,
      event_type,
      event_data: event_data || null,
      created_by:  created_by || 'system',
    }, { Prefer: 'return=minimal' });
    return true;
  } catch (err) {
    console.error('[booking-events] write failed (non-fatal):', event_type, 'session:', booking_session_id, '|', err.message);
    return false;
  }
}

/* Latest event per booking, keyed by booking_session_id. Used by
   handleBookings to enrich each booking row with last_event for the
   admin UI's "Last Touched" column + calendar chip tooltip + customer
   detail footer line.

   Approach: one query fetching the most recent N events globally (ORDER BY
   created_at DESC, limit 2000), grouped in JS by booking_session_id with
   first-occurrence wins. Single round-trip. The 2000 cap guards future
   scale; if TFC ever exceeds that many lifetime events, the oldest-bucket
   bookings will have null last_event and the UI renders an em-dash.

   PostgREST doesn't support lateral joins or DISTINCT ON via query params,
   which is why we do the grouping in JS instead of pushing it to SQL. */
async function getLatestEventByBookingId() {
  let events;
  try {
    events = await request(
      'GET',
      '/booking_events?select=booking_session_id,event_type,event_data,created_by,created_at&order=created_at.desc&limit=2000'
    );
  } catch (err) {
    console.error('[booking-events] getLatestEventByBookingId failed (returning empty):', err.message);
    return {};
  }
  const latest = {};
  for (const e of events || []) {
    const k = e.booking_session_id;
    if (!k) continue;
    if (!latest[k]) latest[k] = e;
  }
  return latest;
}

/* All events for a single booking, newest first. Powers the Edit modal's
   "Activity (N events)" section. */
async function getEventsByBookingId(sessionId) {
  if (!sessionId) return [];
  try {
    return await request(
      'GET',
      '/booking_events?booking_session_id=eq.' + encodeURIComponent(sessionId) + '&order=created_at.desc'
    ) || [];
  } catch (err) {
    console.error('[booking-events] getEventsByBookingId failed:', err.message);
    return [];
  }
}

/* All events for any booking belonging to the given customer, with the
   parent booking row embedded for UI context ("DJ updated booking on
   Jordan's yacht charter, May 24"). PostgREST inner-join syntax filters
   at the embedded resource. */
async function getEventsByCustomerId(customerId) {
  if (customerId == null || customerId === '') return [];
  try {
    const url = '/booking_events' +
      '?select=*,bookings!inner(session_id,charter_name,date,full_name,vessel,customer_id)' +
      '&bookings.customer_id=eq.' + encodeURIComponent(customerId) +
      '&order=created_at.desc';
    return await request('GET', url) || [];
  } catch (err) {
    console.error('[booking-events] getEventsByCustomerId failed:', err.message);
    return [];
  }
}

/* Canonical event-type strings for callers. Runtime accepts any string
   (logBookingEvent does no validation) — this object exists for caller
   hygiene so handlers reference EVENT_TYPES.BOOKING_CREATED instead of
   sprinkling magic strings across the codebase. Values are snake_case
   and match what the Phase 2 migration's backfill wrote for
   'booking_created'. Frozen so callers can't accidentally mutate the
   shared constants table. */
const EVENT_TYPES = Object.freeze({
  BOOKING_CREATED:      'booking_created',
  BOOKING_UPDATED:      'booking_updated',
  BOOKING_CANCELLED:    'booking_cancelled',
  DEPOSIT_PAID:         'deposit_paid',
  BALANCE_PAID:         'balance_paid',
  MARKED_PAID:          'marked_paid',
  REFUND_PROCESSED:     'refund_processed',
  CHARGEBACK_FILED:     'chargeback_filed',
  PORTAL_TOKEN_ROTATED: 'portal_token_rotated',
  DAMAGE_HOLD_RELEASED: 'damage_hold_released',
  DAMAGE_HOLD_CAPTURED: 'damage_hold_captured',
  CONCLUDED:            'concluded',
  REMINDER_T3_SENT:     'reminder_t3_sent',
  REMINDER_T1_SENT:     'reminder_t1_sent',
});

module.exports = {
  logBookingEvent,
  getLatestEventByBookingId,
  getEventsByBookingId,
  getEventsByCustomerId,
  EVENT_TYPES,
};
