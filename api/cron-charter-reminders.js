/* ── T-3 and T-1 charter reminder cron handler ──────────────────────────
   Sibling to api/cron-reminders.js. Lives at its own endpoint so the two
   crons can run on independent schedules — payment-tier reminders and
   post-charter passes at 9 AM Central, charter-prep reminders closer to
   noon Central. Keeps each handler single-purpose and avoids tangling
   their failure modes.

   Schedule (per vercel.json): 0 17 * * * (17:00 UTC daily)
     - CDT (March–November): 12:00 PM (noon) Central
     - CST (November–March): 11:00 AM Central
   Slips 1 hour at DST transitions; acceptable for non-urgent reminder
   timing. Matches the DST-drift pattern of the existing 14:00 UTC cron
   (9 AM CDT, 8 AM CST).

   Reminder idempotency uses two systems:
     - reminders_sent JSONB column on bookings (matches the pattern used by
       api/cron-reminders.js — atomic check against already-loaded data,
       no extra query)
     - booking_events table audit log (Phase 2.5 unified audit trail
       across all booking mutations and communications)
   The JSONB column powers the "should we skip this booking?" check.
   booking_events powers "show me everything that ever happened to this
   booking." Future reminder branches should follow the same dual pattern.

   Same-day skip: if a booking was made within 24h of charter day, skip
   the reminder. The confirmation email is recent enough that a reminder
   would feel spammy stacked on top. Uses a conservative midnight-Central
   interpretation (hard-coded -06:00 offset; 1-hour CDT/CST drift at the
   threshold edge is within tolerance per the locked decision). */

const https = require('https');
const {
  sendT3ReminderEmail,
  sendT1ReminderEmail,
} = require('../lib/send-emails');
const { countWaiversBySessionId } = require('../lib/storage');
const { logBookingEvent, EVENT_TYPES } = require('../lib/booking-events');

/* ── Supabase REST helper. Duplicated from api/cron-reminders.js per
   the existing duplicate-over-share pattern in this codebase. Extraction
   to lib/cron-helpers.js triggers when a third user appears. ── */
function supabase(method, path, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const base = process.env.SUPABASE_URL;
    const key  = process.env.SUPABASE_SECRET_KEY;
    if (!base) return reject(new Error('SUPABASE_URL not set'));
    if (!key)  return reject(new Error('SUPABASE_SECRET_KEY not set'));
    const url = new URL(base.replace(/\/+$/, '') + '/rest/v1' + path);
    const bodyStr = body ? JSON.stringify(body) : null;
    const headers = {
      apikey:        key,
      Authorization: 'Bearer ' + key,
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

/* Today's date as YYYY-MM-DD in America/Chicago — matches how charter
   dates are stored. Duplicated from api/cron-reminders.js. */
function todayCentral() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const y = parts.find(p => p.type === 'year').value;
  const m = parts.find(p => p.type === 'month').value;
  const d = parts.find(p => p.type === 'day').value;
  return y + '-' + m + '-' + d;
}

/* Shift a YYYY-MM-DD date string by deltaDays. UTC-anchored noon avoids
   midnight-drift across the day boundary. */
function shiftYmd(ymd, deltaDays) {
  const d = new Date(ymd + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

/* Vercel Cron auth — same pattern as api/cron-reminders.js. */
function isAuthorized(req) {
  const expected = (process.env.CRON_SECRET || '').trim();
  if (!expected) return false;
  const auth = req.headers['authorization'] || '';
  if (auth === 'Bearer ' + expected) return true;
  const hdr = req.headers['x-cron-secret'] || '';
  if (hdr && hdr === expected) return true;
  return false;
}

/* Conservative same-day skip: treat charter as starting at midnight
   Central on b.date. If booked_at is within 24h of that midnight, skip.
   Hard-coded -06:00 = CST; during CDT (-05:00) the threshold drifts by
   1 hour at the edge, acceptable per the locked decision. Same-day
   bookings are rare and the over-skip is intentional — those customers
   got the confirmation email recently enough that a reminder stacked on
   top would feel spammy. */
function shouldSkipSameDayBooking(b) {
  if (!b.booked_at || !b.date) return false;
  const charterStartCentral = new Date(b.date + 'T00:00:00-06:00');
  const bookedAt = new Date(b.booked_at);
  if (isNaN(charterStartCentral) || isNaN(bookedAt)) return false;
  const hoursDiff = (charterStartCentral.getTime() - bookedAt.getTime()) / (1000 * 60 * 60);
  return hoursDiff < 24;
}

/* Compute waiver status for a booking. Throws on count-query failure so
   the caller can skip the email rather than send "0 of Y" when we
   couldn't actually count. Returns { signed_count, party_size, status }. */
async function getWaiverStatus(b) {
  const signed_count = await countWaiversBySessionId(b.session_id);
  const party_size = Number(b.party_size) || 0;
  let status;
  if (signed_count === 0) status = 'none';
  else if (party_size > 0 && signed_count >= party_size) status = 'all';
  else status = 'partial';
  return { signed_count, party_size, status };
}

/* Shared T-3 / T-1 processing. Strict date-equality query (no fuzzy
   window) — matches the existing cron-reminders one-shot pattern. A send
   failure today means no reminder for that day-out window; T-1 will still
   fire two days later via the separate pass. */
async function processReminder(opts) {
  const { today, daysOut, jsonbKey, eventType, sendFn, results, resultsPrefix } = opts;
  const targetDate = shiftYmd(today, daysOut);

  let bookings = [];
  try {
    bookings = await supabase(
      'GET',
      '/bookings?select=*' +
      '&date=eq.' + encodeURIComponent(targetDate) +
      '&or=(status.is.null,status.eq.upcoming)' +
      '&deleted_at=is.null' +
      '&customer_email=not.is.null'
    ) || [];
  } catch (err) {
    console.error('[cron-charter-reminders]', resultsPrefix, 'query failed:', err.message);
    results.errors.push({ pass: resultsPrefix, step: 'query', error: err.message });
    return;
  }

  console.log('[cron-charter-reminders]', resultsPrefix, 'candidates for', targetDate, ':', bookings.length);

  for (const b of bookings) {
    /* Defensive re-checks (SQL filters above should make these rare). */
    if (b.status === 'cancelled') { results[resultsPrefix + '_skipped']++; continue; }
    if (b.deleted_at)             { results[resultsPrefix + '_skipped']++; continue; }

    /* Idempotency skip via reminders_sent JSONB. */
    const sent = (b.reminders_sent && typeof b.reminders_sent === 'object') ? b.reminders_sent : {};
    if (sent[jsonbKey]) {
      results[resultsPrefix + '_skipped']++;
      continue;
    }

    /* Same-day booking skip. */
    if (shouldSkipSameDayBooking(b)) {
      results[resultsPrefix + '_skipped']++;
      console.log('[cron-charter-reminders]', resultsPrefix, 'same-day skip session:', b.session_id);
      continue;
    }

    /* Fetch waiver status. If this fails, skip rather than send a broken
       "0 of Y" email. Per-booking failure does not abort the cron run. */
    let waiverStatus;
    try {
      waiverStatus = await getWaiverStatus(b);
    } catch (err) {
      console.error('[cron-charter-reminders]', resultsPrefix, 'waiver count failed for', b.session_id, ':', err.message);
      results[resultsPrefix + '_failed']++;
      results.errors.push({ session_id: b.session_id, pass: resultsPrefix, step: 'waiver_count', error: err.message });
      continue;
    }

    /* Send. Failure here means: do NOT write JSONB or audit log, so the
       customer at least loses one cron-firing's worth of state rather
       than getting a misleading "we sent it" record. Note that with strict
       date-equality filtering, a missed T-3 send today means no T-3
       reminder for this charter (window has moved past tomorrow). T-1
       will still attempt two days later via the other pass. */
    try {
      await sendFn(b, waiverStatus);
    } catch (err) {
      console.error('[cron-charter-reminders]', resultsPrefix, 'send failed for', b.session_id, ':', err.message);
      results[resultsPrefix + '_failed']++;
      results.errors.push({ session_id: b.session_id, pass: resultsPrefix, step: 'send', error: err.message });
      continue;
    }

    /* Send succeeded. Idempotency markers in defensive order:
       1. PATCH reminders_sent (primary idempotency key — prevents resends)
       2. logBookingEvent (audit trail)
       If (1) fails: next cron sees no JSONB flag and would re-attempt,
       but with strict date filtering that "next run" is tomorrow at a
       different daysOut value, so the booking won't match. Net effect:
       audit log captures the send (via step 2), customer got the email,
       state is consistent. If (2) fails: audit log loses one entry but
       customer experience is correct. Both errors collected for visibility. */
    const merged = { ...sent, [jsonbKey]: true };
    try {
      await supabase(
        'PATCH',
        '/bookings?session_id=eq.' + encodeURIComponent(b.session_id),
        { reminders_sent: merged },
        { Prefer: 'return=minimal' }
      );
    } catch (err) {
      console.error('[cron-charter-reminders]', resultsPrefix, 'PATCH reminders_sent failed for', b.session_id, ':', err.message);
      results.errors.push({ session_id: b.session_id, pass: resultsPrefix, step: 'patch_reminders_sent', error: err.message });
    }

    /* logBookingEvent catches its own errors and returns boolean. Guard
       anyway in case the contract changes. */
    try {
      const ok = await logBookingEvent(b.session_id, eventType, {
        sent_to:      b.customer_email,
        waiver_status: waiverStatus.status,
        signed_count: waiverStatus.signed_count,
        party_size:   waiverStatus.party_size,
      }, 'cron');
      if (!ok) {
        results.errors.push({ session_id: b.session_id, pass: resultsPrefix, step: 'log_event', error: 'logBookingEvent returned false' });
      }
    } catch (err) {
      results.errors.push({ session_id: b.session_id, pass: resultsPrefix, step: 'log_event', error: err.message });
    }

    results[resultsPrefix + '_sent']++;
    console.log('[cron-charter-reminders]', resultsPrefix, 'SENT session:', b.session_id, 'to:', b.customer_email, 'waiver:', waiverStatus.status);
  }
}

module.exports = async function handler(req, res) {
  if (!isAuthorized(req)) {
    console.warn('[cron-charter-reminders] unauthorized request');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const today = todayCentral();
  console.log('[cron-charter-reminders] starting run for', today);

  const results = {
    today,
    t3_sent: 0, t3_skipped: 0, t3_failed: 0,
    t1_sent: 0, t1_skipped: 0, t1_failed: 0,
    errors: [],
  };

  await processReminder({
    today,
    daysOut:       3,
    jsonbKey:      't3_reminder',
    eventType:     EVENT_TYPES.REMINDER_T3_SENT,
    sendFn:        sendT3ReminderEmail,
    results,
    resultsPrefix: 't3',
  });

  await processReminder({
    today,
    daysOut:       1,
    jsonbKey:      't1_reminder',
    eventType:     EVENT_TYPES.REMINDER_T1_SENT,
    sendFn:        sendT1ReminderEmail,
    results,
    resultsPrefix: 't1',
  });

  console.log('[cron-charter-reminders] done. summary:', JSON.stringify(results));
  return res.status(200).json(results);
};
