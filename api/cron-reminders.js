const https = require('https');
const {
  sendFriendlyReminderEmail,
  sendDueTodayEmail,
  sendOwnerAlertEmail,
  sendFinalNoticeEmail,
} = require('../lib/send-emails');

/* ── Supabase REST helper (same shape as lib/storage.js) ── */
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

/* Today's date as YYYY-MM-DD in America/Chicago — matches how charter dates
   are stored, so day-difference math doesn't drift across the UTC midnight. */
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

function daysBetweenYmd(fromYmd, toYmd) {
  const a = new Date(fromYmd + 'T12:00:00Z');
  const b = new Date(toYmd   + 'T12:00:00Z');
  return Math.round((b - a) / (24 * 60 * 60 * 1000));
}

/* Map days-out → reminder key + sender. Order matters only for logging
   clarity; each booking matches exactly one bucket per day by design. */
const REMINDERS = [
  { days: 21, key: '21day',             sender: 'friendly',    fn: sendFriendlyReminderEmail, toCustomer: true  },
  { days: 14, key: '14day',             sender: 'due_today',   fn: sendDueTodayEmail,         toCustomer: true  },
  { days: 13, key: 'owner_alert_13day', sender: 'owner_alert', fn: sendOwnerAlertEmail,       toCustomer: false },
  { days: 12, key: 'final_12day',       sender: 'final',       fn: sendFinalNoticeEmail,      toCustomer: true  },
];

function pickReminder(daysOut) {
  return REMINDERS.find(r => r.days === daysOut) || null;
}

/* Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`. We also accept an
   `x-cron-secret` header for manual curl testing. Returns true if authorized. */
function isAuthorized(req) {
  const expected = (process.env.CRON_SECRET || '').trim();
  if (!expected) return false;
  const auth = req.headers['authorization'] || '';
  if (auth === 'Bearer ' + expected) return true;
  const hdr = req.headers['x-cron-secret'] || '';
  if (hdr && hdr === expected) return true;
  return false;
}

module.exports = async function handler(req, res) {
  if (!isAuthorized(req)) {
    console.warn('[cron-reminders] unauthorized request');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const today = todayCentral();
  console.log('[cron-reminders] starting run for', today);

  let bookings;
  try {
    /* Query bookings with: status upcoming (or null — admin treats null as
       upcoming), paid_in_full=false, remaining_balance>0, customer_email not null.
       We filter by date window in JS to keep the URL simple. */
    bookings = await supabase(
      'GET',
      '/bookings?select=*' +
      '&or=(status.is.null,status.eq.upcoming)' +
      '&paid_in_full=eq.false' +
      '&remaining_balance=gt.0' +
      '&customer_email=not.is.null'
    ) || [];
  } catch (err) {
    console.error('[cron-reminders] failed to query bookings:', err.message);
    return res.status(500).json({ error: 'Query failed', detail: err.message });
  }

  console.log('[cron-reminders] candidates after filter:', bookings.length);

  const summary = {
    today,
    candidates: bookings.length,
    sent: 0,
    skipped_no_match: 0,
    skipped_already_sent: 0,
    skipped_cancelled: 0,
    skipped_paid: 0,
    errors: [],
    actions: [],
  };

  for (const b of bookings) {
    /* Defensive re-checks (filters above should make these rare). */
    if (b.status === 'cancelled') { summary.skipped_cancelled++; continue; }
    if (b.paid_in_full)           { summary.skipped_paid++;      continue; }
    if (!b.date)                  { continue; }

    const daysOut = daysBetweenYmd(today, b.date);
    const r = pickReminder(daysOut);
    if (!r) { summary.skipped_no_match++; continue; }

    const sent = (b.reminders_sent && typeof b.reminders_sent === 'object') ? b.reminders_sent : {};
    if (sent[r.key]) {
      summary.skipped_already_sent++;
      continue;
    }

    const recipient = r.toCustomer ? b.customer_email : 'tx4evercharters@gmail.com';
    if (r.toCustomer && !b.customer_email) {
      summary.errors.push({ session_id: b.session_id, error: 'no customer_email' });
      continue;
    }

    try {
      const paymentLink = b.payment_link || b.balance_payment_link || null;
      await r.fn(b, paymentLink);

      const merged = { ...sent, [r.key]: true };
      await supabase(
        'PATCH',
        '/bookings?session_id=eq.' + encodeURIComponent(b.session_id),
        { reminders_sent: merged },
        { Prefer: 'return=minimal' }
      );

      summary.sent++;
      summary.actions.push({
        session_id: b.session_id,
        days_out:   daysOut,
        type:       r.sender,
        to:         recipient,
      });
      console.log('[cron-reminders] SENT', r.sender, 'session:', b.session_id, 'to:', recipient, 'days_out:', daysOut);
    } catch (err) {
      console.error('[cron-reminders] ERROR sending', r.sender, 'session:', b.session_id, ':', err.message);
      summary.errors.push({ session_id: b.session_id, type: r.sender, error: err.message });
    }
  }

  console.log('[cron-reminders] done. summary:', JSON.stringify(summary));
  return res.status(200).json(summary);
};
