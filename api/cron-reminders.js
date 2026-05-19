const https = require('https');
const {
  sendFriendlyReminderEmail,
  sendDueTodayEmail,
  sendOwnerAlertEmail,
  sendFinalNoticeEmail,
  sendReviewRequestEmail,
  sendConfirmationEmails,
  sendConfirmationEmailPermanentFailureAlert,
  sendDailyLeadDigest,
} = require('../lib/send-emails');
const { listRecentLeads, deleteStaleLeads } = require('../lib/storage');
const { pingHeartbeat } = require('../lib/observability');

const LEAD_DIGEST_WINDOW_HOURS = 24;
const LEAD_RETENTION_DAYS = 90;

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

function shiftYmd(ymd, deltaDays) {
  const d = new Date(ymd + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
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

  /* Better Stack heartbeat URL for this cron endpoint. Optional env var;
     pingHeartbeat is a no-op when the var is unset (local dev, preview
     deploys) so the cron still runs everywhere. */
  const heartbeatUrl = process.env.BETTER_STACK_HEARTBEAT_REMINDERS;

  try {
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
    /* Convert the bookings-query failure to throw so the outer catch
       fires the /fail heartbeat. Previously this returned 500 inline,
       which would have silently succeeded the heartbeat check. */
    console.error('[cron-reminders] failed to query bookings:', err.message);
    throw new Error('Initial bookings query failed: ' + err.message);
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
      await r.fn(b);

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

  /* ── Confirmation-email retry pass: re-send customer confirmation emails
     that initially failed at booking time (Resend outage, recipient mailbox
     bounce, etc.). Picks up rows where the webhook recorded
     confirmation_email_sent=false. Window: booked between 7 days ago and
     1 hour ago — the 1hr floor avoids racing with brand-new bookings whose
     webhook may still be in flight; the 7-day ceiling caps indefinite
     retries on permanently broken addresses. Capped at 5 attempts per row,
     after which a one-time owner alert is fired. ── */
  const retry = {
    candidates: 0,
    retried: 0,
    succeeded: 0,
    failed: 0,
    skipped_perm_fail: 0,
    perm_fail_alerted: 0,
    errors: [],
    actions: [],
  };

  let retryBookings = [];
  try {
    const oneHourAgoIso   = new Date(Date.now() -      60 * 60 * 1000).toISOString();
    const sevenDaysAgoIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    retryBookings = await supabase(
      'GET',
      '/bookings?select=*' +
      '&confirmation_email_sent=eq.false' +
      '&customer_email=not.is.null' +
      '&booked_at=lt.' + encodeURIComponent(oneHourAgoIso) +
      '&booked_at=gt.' + encodeURIComponent(sevenDaysAgoIso) +
      '&order=booked_at.asc'
    ) || [];
  } catch (err) {
    console.error('[cron-reminders] confirmation-retry query failed:', err.message);
    summary.confirmation_retry = { error: err.message };
  }

  retry.candidates = retryBookings.length;
  console.log('[cron-reminders] confirmation-retry candidates:', retry.candidates);

  for (const b of retryBookings) {
    if (b.status === 'cancelled') continue;

    const attempts = Number(b.confirmation_email_retries) || 0;

    /* Past the 5-attempt cap. Send a one-time owner alert (tracked via
       reminders_sent.confirmation_perm_fail_alerted) and skip the row. */
    if (attempts >= 5) {
      retry.skipped_perm_fail++;
      const sent = (b.reminders_sent && typeof b.reminders_sent === 'object') ? b.reminders_sent : {};
      if (sent.confirmation_perm_fail_alerted) continue;
      try {
        await sendConfirmationEmailPermanentFailureAlert(b);
        const merged = { ...sent, confirmation_perm_fail_alerted: true };
        await supabase(
          'PATCH',
          '/bookings?session_id=eq.' + encodeURIComponent(b.session_id),
          { reminders_sent: merged },
          { Prefer: 'return=minimal' }
        );
        retry.perm_fail_alerted++;
        console.log('[cron-reminders] PERM-FAIL ALERT sent for session:', b.session_id, 'after', attempts, 'attempts');
      } catch (err) {
        console.error('[cron-reminders] perm-fail alert send failed for', b.session_id, ':', err.message);
        retry.errors.push({ session_id: b.session_id, step: 'perm_fail_alert', error: err.message });
      }
      continue;
    }

    const nextAttempt = attempts + 1;
    console.log('[cron-reminders] Retrying confirmation email for', b.session_id, '(attempt', nextAttempt, 'of 5)');

    /* sendConfirmationEmails throws only if BOTH customer + business sends
       fail. Customer-side success is the real signal that the confirmation
       was delivered, so we read result.customerError to decide. */
    let result, sendError = null;
    try {
      result = await sendConfirmationEmails(b);
    } catch (err) {
      sendError = err;
    }

    const customerOk = !sendError && result && !result.customerError;
    const updates = { confirmation_email_retries: nextAttempt };
    if (customerOk) updates.confirmation_email_sent = true;

    try {
      await supabase(
        'PATCH',
        '/bookings?session_id=eq.' + encodeURIComponent(b.session_id),
        updates,
        { Prefer: 'return=minimal' }
      );
    } catch (patchErr) {
      console.error('[cron-reminders] retry-counter PATCH failed for', b.session_id, ':', patchErr.message);
      retry.errors.push({ session_id: b.session_id, step: 'patch_counter', error: patchErr.message });
      continue;
    }

    retry.retried++;
    if (customerOk) {
      retry.succeeded++;
      retry.actions.push({ session_id: b.session_id, attempt: nextAttempt, to: b.customer_email, status: 'sent' });
      console.log('[cron-reminders] RETRY SUCCESS for session:', b.session_id, '→', b.customer_email, '(attempt', nextAttempt, 'of 5)');
    } else {
      retry.failed++;
      const errMsg = sendError ? sendError.message
        : (result && result.customerError ? result.customerError.message : 'unknown');
      retry.errors.push({ session_id: b.session_id, step: 'retry_send', attempt: nextAttempt, error: errMsg });
      console.error('[cron-reminders] RETRY FAILED for session:', b.session_id, '(attempt', nextAttempt, 'of 5):', errMsg);
    }
  }

  summary.confirmation_retry = retry;

  /* ── Post-charter pass: auto-conclude yesterday's upcoming charters and
     send a review-request email exactly once per booking. ── */
  const yesterday = shiftYmd(today, -1);
  const post = {
    yesterday,
    candidates: 0,
    concluded:  0,
    review_sent: 0,
    skipped_no_email: 0,
    skipped_already_requested: 0,
    skipped_cancelled: 0,
    errors: [],
    actions: [],
  };

  let postBookings = [];
  try {
    /* Pull yesterday's charters that are still upcoming/null OR already concluded.
       Cancelled bookings are excluded by the status filter. */
    postBookings = await supabase(
      'GET',
      '/bookings?select=*' +
      '&date=eq.' + encodeURIComponent(yesterday) +
      '&or=(status.is.null,status.eq.upcoming,status.eq.concluded)'
    ) || [];
  } catch (err) {
    /* Post-charter query failure bails out of subsequent passes (leads
       digest, retention cleanup are skipped). Preserving existing
       behavior — the cron RAN and the partial summary is logged, so
       the success heartbeat fires; downstream Sentry instrumentation
       (Commit 2) will surface this as an exception with context. */
    console.error('[cron-reminders] post-charter query failed:', err.message);
    summary.post_charter = { error: err.message };
    console.log('[cron-reminders] done. summary:', JSON.stringify(summary));
    await pingHeartbeat(heartbeatUrl);
    return res.status(200).json(summary);
  }

  post.candidates = postBookings.length;
  console.log('[cron-reminders] post-charter candidates for', yesterday, ':', postBookings.length);

  for (const b of postBookings) {
    if (b.status === 'cancelled') { post.skipped_cancelled++; continue; }

    /* 1. Auto-conclude if status is upcoming or null. */
    const needsConclude = !b.status || b.status === 'upcoming';
    if (needsConclude) {
      try {
        await supabase(
          'PATCH',
          '/bookings?session_id=eq.' + encodeURIComponent(b.session_id),
          { status: 'concluded' },
          { Prefer: 'return=minimal' }
        );
        post.concluded++;
        console.log('[cron-reminders] CONCLUDED session:', b.session_id);
      } catch (err) {
        console.error('[cron-reminders] conclude failed for', b.session_id, ':', err.message);
        post.errors.push({ session_id: b.session_id, step: 'conclude', error: err.message });
        continue;
      }
    }

    /* 2. Send review request if customer_email exists and we haven't sent one yet. */
    if (!b.customer_email) { post.skipped_no_email++; continue; }
    const sent = (b.reminders_sent && typeof b.reminders_sent === 'object') ? b.reminders_sent : {};
    if (sent.review_requested) { post.skipped_already_requested++; continue; }

    try {
      await sendReviewRequestEmail(b);
      const merged = { ...sent, review_requested: true };
      await supabase(
        'PATCH',
        '/bookings?session_id=eq.' + encodeURIComponent(b.session_id),
        { reminders_sent: merged },
        { Prefer: 'return=minimal' }
      );
      post.review_sent++;
      post.actions.push({ session_id: b.session_id, type: 'review_request', to: b.customer_email });
      console.log('[cron-reminders] SENT review_request session:', b.session_id, 'to:', b.customer_email);
    } catch (err) {
      console.error('[cron-reminders] review send failed for', b.session_id, ':', err.message);
      post.errors.push({ session_id: b.session_id, step: 'review', error: err.message });
    }
  }

  summary.post_charter = post;

  /* ── Leads digest pass: send one digest email summarising lead activity
     from the last 24 hours, grouped by status. Skip entirely if there
     was zero activity (no leads in window). ────────────────────────── */
  const leadsDigest = {
    window_hours: LEAD_DIGEST_WINDOW_HOURS,
    total:        0,
    by_status:    { captured: 0, abandoned_stripe: 0, payment_failed: 0, converted: 0, contacted: 0 },
    digest_sent:  false,
    digest_error: null,
  };
  try {
    const recent = await listRecentLeads(LEAD_DIGEST_WINDOW_HOURS);
    leadsDigest.total = recent.length;
    const grouped = { captured: [], abandoned_stripe: [], payment_failed: [], converted: [], contacted: [] };
    for (const l of recent) {
      const k = l.status && grouped[l.status] ? l.status : 'captured';
      grouped[k].push(l);
      leadsDigest.by_status[k] = (leadsDigest.by_status[k] || 0) + 1;
    }
    if (recent.length === 0) {
      console.log('[cron-reminders] leads digest: 0 leads in last', LEAD_DIGEST_WINDOW_HOURS, 'h — skipping email');
    } else {
      /* 7-day bounce-reason + outcome breakdowns — queried separately
         because the main digest window is 24h but these need a longer
         window to surface meaningful trends. Uses ONE 7-day query and
         buckets it two ways. Outcome counts include only leads that
         have a contact_outcome set within the last 7 days (i.e. admin
         actually logged a contact). */
      const bounceReasonCounts = {};
      const outcomeCounts = {};
      try {
        const weekRecent = await listRecentLeads(24 * 7);
        for (const l of weekRecent) {
          const bkey = l.bounce_reason || 'untagged';
          bounceReasonCounts[bkey] = (bounceReasonCounts[bkey] || 0) + 1;
          if (l.contact_outcome) {
            const okey = l.contact_outcome;
            outcomeCounts[okey] = (outcomeCounts[okey] || 0) + 1;
          }
        }
        leadsDigest.bounce_reasons_7d = bounceReasonCounts;
        leadsDigest.outcomes_7d       = outcomeCounts;
      } catch (err) {
        console.error('[cron-reminders] 7d breakdown query failed (non-fatal):', err.message);
      }
      try {
        await sendDailyLeadDigest(grouped, { dateLabel: today, bounceReasonCounts, outcomeCounts });
        leadsDigest.digest_sent = true;
        console.log('[cron-reminders] leads digest sent | total:', recent.length, '| by_status:', leadsDigest.by_status, '| bounce_7d:', bounceReasonCounts, '| outcomes_7d:', outcomeCounts);
      } catch (err) {
        leadsDigest.digest_error = err.message;
        console.error('[cron-reminders] leads digest send failed:', err.message);
      }
    }
  } catch (err) {
    leadsDigest.digest_error = err.message;
    console.error('[cron-reminders] leads digest query failed:', err.message);
  }
  summary.leads_digest = leadsDigest;

  /* ── 90-day retention cleanup: hard-delete unconverted leads older than
     LEAD_RETENTION_DAYS. Converted leads are retained because they represent
     real customer-booking relationships and may be useful for reporting.
     Committed in the privacy policy as a 90-day window. ───────────── */
  try {
    const purged = await deleteStaleLeads(LEAD_RETENTION_DAYS);
    summary.leads_retention = { days: LEAD_RETENTION_DAYS, purged };
    if (purged > 0) console.log('[cron-reminders] retention cleanup purged', purged, 'unconverted leads older than', LEAD_RETENTION_DAYS, 'days');
  } catch (err) {
    summary.leads_retention = { days: LEAD_RETENTION_DAYS, error: err.message };
    console.error('[cron-reminders] retention cleanup failed:', err.message);
  }

  console.log('[cron-reminders] done. summary:', JSON.stringify(summary));
  await pingHeartbeat(heartbeatUrl);
  return res.status(200).json(summary);
  } catch (err) {
    /* Outer catch — covers any uncaught throw from the cron body
       (the most likely sources are the converted-to-throw bookings
       query failure above, or any unexpected throw in one of the
       passes whose internal try/catch missed a path). Logs the stack
       (the value-add over today's one-line console.error), fires the
       /fail heartbeat so Better Stack pages DJ, returns 500 to
       Vercel. */
    console.error('[cron-reminders] uncaught error:', err.message, err.stack);
    await pingHeartbeat(heartbeatUrl, { fail: true });
    return res.status(500).json({ error: 'Cron run failed', detail: err.message });
  }
};
