/* Stripe ↔ Supabase reconciliation.
   Pulls all paid Stripe Checkout Sessions from the last N hours and verifies
   each has a matching booking row in Supabase. Flags any "lost" bookings
   (Stripe charged but Supabase missing) for manual recovery.

   Companion to verify-bookings.js: where verify checks data integrity ON
   each row, this checks that every paid Stripe session HAS a row at all.

   Usage:
     # One-time: install Vercel CLI and link the repo
     npm i -g vercel
     vercel login
     vercel link

     # Pull production secrets (refresh whenever they rotate)
     vercel env pull .env.production --environment=production

     # Default: last 72 hours (covers Stripe's 3-day webhook retry window + buffer)
     node --env-file=.env.production reconcile-bookings.js

     # Custom window (e.g., last 7 days)
     HOURS=168 node --env-file=.env.production reconcile-bookings.js

   Findings:
     CRITICAL — Stripe session paid, no Supabase booking row. Recover manually.
     WARNING  — Supabase row exists, but confirmation_email_sent=false. Email
                never delivered (customer is in the dark).

   Exit codes:
     0 — clean
     1 — only WARNINGs found
     2 — environment / API error (script couldn't run)
     3 — at least one CRITICAL finding

   Read-only — never writes to Supabase or Stripe. Safe to run any time. */

const https = require('https');

const HOURS = parseInt(process.env.HOURS, 10) || 72;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;
const STRIPE_KEY   = process.env.STRIPE_SECRET_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY || !STRIPE_KEY) {
  console.error('Missing env vars. Need STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_SECRET_KEY.');
  console.error('To pull from Vercel: `vercel env pull .env.production --environment=production`');
  console.error('Then: `node --env-file=.env.production reconcile-bookings.js`  (Node 20.6+)');
  process.exit(2);
}

const stripe = require('stripe')(STRIPE_KEY);

function supabaseGet(path) {
  return new Promise((resolve, reject) => {
    const url = new URL(SUPABASE_URL.replace(/\/+$/, '') + '/rest/v1' + path);
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: 'Bearer ' + SUPABASE_KEY,
        Accept: 'application/json',
      },
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error('Supabase ' + res.statusCode + ': ' + raw));
        try { resolve(JSON.parse(raw)); } catch { resolve(null); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function fetchStripeSessions(sinceTs) {
  /* Stripe's list-checkout-sessions endpoint accepts a created.gte filter
     and paginates 100 per page. We hard-cap pagination at 20 pages (2,000
     sessions) — way past what TFC sees in a 72-hour window today, but
     prevents runaway loops if someone runs this with HOURS=99999. */
  const sessions = [];
  let startingAfter;
  for (let page = 0; page < 20; page++) {
    const params = { created: { gte: sinceTs }, limit: 100 };
    if (startingAfter) params.starting_after = startingAfter;
    const result = await stripe.checkout.sessions.list(params);
    sessions.push(...result.data);
    if (!result.has_more) return sessions;
    startingAfter = result.data[result.data.length - 1].id;
  }
  console.warn('[reconcile] hit pagination cap (20 pages × 100). Truncated.');
  return sessions;
}

async function fetchSupabaseBookingsBySessionId(sessionIds) {
  /* Batch via PostgREST in.() filter so we don't fire one HTTP request per
     session. Stripe session ids are alphanumeric + underscores, so no quoting
     needed inside the parens. */
  const map = new Map();
  if (sessionIds.length === 0) return map;
  const BATCH = 50;
  for (let i = 0; i < sessionIds.length; i += BATCH) {
    const batch = sessionIds.slice(i, i + BATCH);
    const inClause = '(' + batch.join(',') + ')';
    const path = '/bookings?session_id=in.' + encodeURIComponent(inClause) +
      '&select=session_id,customer_email,full_name,date,confirmation_email_sent,grand_total,damage_hold_status,booked_at';
    const rows = await supabaseGet(path);
    for (const r of (rows || [])) map.set(r.session_id, r);
  }
  return map;
}

(async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Stripe ↔ Supabase reconciliation — last ' + HOURS + ' hours');
  console.log('  Run at ' + new Date().toISOString());
  console.log('═══════════════════════════════════════════════════════════');

  const sinceTs = Math.floor((Date.now() - HOURS * 3600 * 1000) / 1000);
  console.log('\nFetching Stripe checkout sessions created on/after ' +
    new Date(sinceTs * 1000).toISOString() + '...');

  let stripeSessions;
  try {
    stripeSessions = await fetchStripeSessions(sinceTs);
  } catch (err) {
    console.error('Stripe API error:', err.message);
    process.exit(2);
  }

  /* Filter to the sessions we expect to have a Supabase booking row:
     mode=payment AND payment_status=paid. Skips abandoned checkouts,
     subscription/setup modes (we don't use those), and unpaid sessions. */
  const paidSessions = stripeSessions.filter(s =>
    s.mode === 'payment' && s.payment_status === 'paid'
  );

  console.log('Found ' + stripeSessions.length + ' Stripe session(s) total; ' +
    paidSessions.length + ' paid + mode=payment.');

  if (paidSessions.length === 0) {
    console.log('\nNo paid bookings in this window — nothing to reconcile.');
    process.exit(0);
  }

  console.log('Looking up matching Supabase rows...');
  let supabaseMap;
  try {
    supabaseMap = await fetchSupabaseBookingsBySessionId(paidSessions.map(s => s.id));
  } catch (err) {
    console.error('Supabase query failed:', err.message);
    process.exit(2);
  }
  console.log('Found ' + supabaseMap.size + ' matching Supabase row(s).');

  const criticals = [];
  const warnings = [];

  for (const session of paidSessions) {
    const row = supabaseMap.get(session.id);
    if (!row) {
      criticals.push(session);
    } else if (row.confirmation_email_sent === false) {
      warnings.push({ session, row });
    }
  }

  /* CRITICAL findings: paid in Stripe, no row in Supabase. Dump enough
     context that the operator can manually create the booking from admin
     or re-fire the webhook from the Stripe dashboard. */
  if (criticals.length > 0) {
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('  🔴 CRITICAL — ' + criticals.length + ' Stripe session(s) MISSING from Supabase');
    console.log('═══════════════════════════════════════════════════════════');
    criticals.forEach((s, i) => {
      const meta = s.metadata || {};
      console.log('');
      console.log('[CRITICAL ' + (i + 1) + '] ' + s.id);
      console.log('  Stripe created:    ' + new Date(s.created * 1000).toISOString());
      console.log('  Customer email:    ' + (s.customer_email || meta.email || '(none on session)'));
      console.log('  Customer name:     ' + (meta.full_name || '(no metadata)'));
      console.log('  Charter name:      ' + (meta.charter_name || '(no metadata)'));
      console.log('  Charter date:      ' + (meta.date || '?') +
        (meta.time_slot ? ' @ ' + meta.time_slot : ''));
      console.log('  Vessel / duration: ' + (meta.vessel || '?') + ' / ' + (meta.duration || '?') + ' hrs');
      console.log('  Experience:        ' + (meta.experience || '?'));
      console.log('  Phone:             ' + (meta.phone || '?'));
      console.log('  Party size:        ' + (meta.party_size || '?'));
      console.log('  Amount paid:       $' + ((s.amount_total || 0) / 100).toFixed(2) +
        ' ' + (s.currency || 'usd').toUpperCase() + '  (payment_type: ' + (meta.payment_type || '?') + ')');
      console.log('  Grand total meta:  $' + (meta.grand_total || '?'));
      console.log('  Deposit meta:      $' + (meta.deposit_amount || '?'));
      console.log('  Add-ons meta:      ' + (meta.add_ons || '{}'));
      console.log('  Promo applied:     ' + (meta.promo_applied || 'false') +
        (meta.promo_code ? ' (code: ' + meta.promo_code + ')' : ''));
      console.log('  Special requests:  ' + (meta.special_requests || '(none)'));
      console.log('  Payment intent:    ' + (s.payment_intent || '(none)'));
      console.log('  Stripe customer:   ' + (s.customer || '(none)'));
      console.log('  Recovery options:');
      console.log('    1. Stripe dashboard → Developers → Webhooks → click webhook → ');
      console.log('       find this checkout.session.completed event → "Resend"');
      console.log('    2. Or manually create via admin "Add Booking" with the data above');
    });
  }

  /* WARNINGs: row exists, customer never got the confirmation email. */
  if (warnings.length > 0) {
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('  ⚠️  WARNING — ' + warnings.length +
      ' booking(s) with confirmation_email_sent=false');
    console.log('═══════════════════════════════════════════════════════════');
    warnings.forEach((w, i) => {
      console.log('');
      console.log('[WARNING ' + (i + 1) + '] ' + w.session.id);
      console.log('  Customer:   ' + (w.row.full_name || '?') + ' <' + (w.row.customer_email || '?') + '>');
      console.log('  Charter:    ' + (w.row.date || '?'));
      console.log('  Action:     Use admin "Resend Confirmation" — or POST to /api/resend-confirmation');
      console.log('              with this session_id.');
    });
  }

  /* Summary footer */
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  Summary');
  console.log('───────────────────────────────────────────────────────────');
  console.log('  Window:                       last ' + HOURS + ' hours');
  console.log('  Stripe sessions in window:    ' + stripeSessions.length);
  console.log('  Paid + mode=payment:          ' + paidSessions.length);
  console.log('  ✅ Reconciled (in Supabase):   ' + supabaseMap.size);
  console.log('  🔴 CRITICAL (missing rows):    ' + criticals.length);
  console.log('  ⚠️  WARNING (email not sent):  ' + warnings.length);
  console.log('═══════════════════════════════════════════════════════════');

  if (criticals.length > 0) process.exit(3);
  if (warnings.length > 0)  process.exit(1);
  process.exit(0);
})().catch(err => {
  console.error('\nUnhandled error:', err.message);
  console.error(err.stack);
  process.exit(2);
});
