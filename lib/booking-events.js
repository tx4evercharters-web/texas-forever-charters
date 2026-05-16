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

module.exports = { logBookingEvent };
