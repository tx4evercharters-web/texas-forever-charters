/* Stripe sandbox-vs-live booking audit.
   Cross-checks every recent booking in Supabase against the Stripe LIVE
   API. Any booking whose session_id is NOT found in live mode was created
   against sandbox/test — the customer's card was never actually charged.

   IMPORTANT: this script does NOT use STRIPE_SECRET_KEY. Production env may
   currently hold a sandbox key (that's the bug we're diagnosing). Pass the
   real live key via STRIPE_LIVE_KEY so the comparison is meaningful.

   Get the live key from: https://dashboard.stripe.com/apikeys
   (toggle to LIVE mode in the left sidebar — key starts with "sk_live_")

   Usage (PowerShell on Windows):
     $env:STRIPE_LIVE_KEY="sk_live_xxx"
     $env:SUPABASE_URL="https://xxx.supabase.co"
     $env:SUPABASE_SECRET_KEY="xxx"
     node diagnose-sandbox-bookings.js

     # Custom window (default 30 days):
     $env:DAYS="60"
     node diagnose-sandbox-bookings.js

     # Show per-booking verdict line:
     node diagnose-sandbox-bookings.js --verbose

   Usage (Bash/macOS/Linux):
     STRIPE_LIVE_KEY=sk_live_xxx \
     SUPABASE_URL=https://xxx.supabase.co \
     SUPABASE_SECRET_KEY=xxx \
     node diagnose-sandbox-bookings.js [--verbose]

   If you already pulled Vercel env vars to .env.production for the
   reconcile script, you can reuse SUPABASE_* from there — just override
   STRIPE_LIVE_KEY since the env file's STRIPE_SECRET_KEY is the bad one:
     $env:STRIPE_LIVE_KEY="sk_live_xxx"
     node --env-file=.env.production diagnose-sandbox-bookings.js

   Exit codes:
     0 — no sandbox bookings found (clean)
     1 — at least one sandbox booking found (action needed)
     2 — environment / API error (script couldn't run)

   Read-only — never writes to Supabase or Stripe. Safe to run any time. */

const https = require('https');

const VERBOSE = process.argv.includes('--verbose') || process.argv.includes('-v');
const DAYS = parseInt(process.env.DAYS, 10) || 30;
const SUPABASE_URL    = process.env.SUPABASE_URL;
const SUPABASE_KEY    = process.env.SUPABASE_SECRET_KEY;
const STRIPE_LIVE_KEY = process.env.STRIPE_LIVE_KEY;

const RED = '\x1b[31m', GREEN = '\x1b[32m', YELLOW = '\x1b[33m',
      GRAY = '\x1b[90m', BOLD = '\x1b[1m', RESET = '\x1b[0m';

if (!STRIPE_LIVE_KEY) {
  console.error(`${RED}FATAL${RESET}: STRIPE_LIVE_KEY env var not set.`);
  console.error('');
  console.error('Get it from https://dashboard.stripe.com/apikeys (toggle to LIVE mode).');
  console.error('Key should start with "sk_live_". Do NOT use STRIPE_SECRET_KEY from');
  console.error('Vercel production env — that\'s the broken sandbox key we\'re diagnosing.');
  process.exit(2);
}
if (!STRIPE_LIVE_KEY.startsWith('sk_live_')) {
  console.error(`${RED}FATAL${RESET}: STRIPE_LIVE_KEY does not start with "sk_live_".`);
  console.error('Got prefix:', STRIPE_LIVE_KEY.slice(0, Math.min(10, STRIPE_LIVE_KEY.length)) + '...');
  console.error('This script requires a LIVE-mode key. Test keys would defeat the audit.');
  process.exit(2);
}
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error(`${RED}FATAL${RESET}: SUPABASE_URL and SUPABASE_SECRET_KEY env vars required.`);
  console.error('To pull from Vercel: `vercel env pull .env.production --environment=production`');
  process.exit(2);
}

const stripe = require('stripe')(STRIPE_LIVE_KEY);

function supabaseGet(path) {
  return new Promise((resolve, reject) => {
    const url = new URL(SUPABASE_URL.replace(/\/+$/, '') + '/rest/v1' + path);
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        apikey:        SUPABASE_KEY,
        Authorization: 'Bearer ' + SUPABASE_KEY,
        Accept:        'application/json',
      },
    }, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          return reject(new Error('Supabase ' + res.statusCode + ': ' + raw));
        }
        try { resolve(JSON.parse(raw)); } catch { resolve([]); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/* Returns one of:
   { verdict: 'live',    reason: null }
   { verdict: 'sandbox', reason: '...' }  ← session does not exist in live mode
   { verdict: 'error',   reason: '...' }  ← lookup failed (network, auth, etc.)
   { verdict: 'skipped', reason: '...' }  ← booking has no Stripe session_id */
async function checkBooking(b) {
  const sid = b.session_id;
  if (!sid) return { verdict: 'skipped', reason: 'no session_id on booking row' };
  if (!sid.startsWith('cs_')) return { verdict: 'skipped', reason: 'session_id does not look like a Stripe Checkout Session (cs_*)' };

  try {
    const session = await stripe.checkout.sessions.retrieve(sid);
    /* Stripe live API only returns sessions that were created in live mode.
       The livemode flag is a sanity check; in practice a test session_id
       passed to the live API yields a 404, not a session with livemode=false. */
    if (session.livemode === false) {
      return { verdict: 'sandbox', reason: 'session.livemode === false (unexpected — verify in Stripe dashboard)' };
    }
    return { verdict: 'live', reason: null };
  } catch (err) {
    const is404 = err.statusCode === 404 || /No such checkout\.session/i.test(err.message || '');
    if (is404) {
      return { verdict: 'sandbox', reason: 'session not found in live mode — created against sandbox/test' };
    }
    return { verdict: 'error', reason: (err.message || String(err)).slice(0, 200) };
  }
}

function fmt$(n) {
  const v = parseFloat(n) || 0;
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function amountOf(b) {
  return b.amount_total ? (b.amount_total / 100) : parseFloat(b.grand_total || 0);
}

async function main() {
  console.log(`${BOLD}=== Stripe Sandbox-vs-Live Booking Audit ===${RESET}`);
  console.log(`Window: last ${DAYS} day${DAYS !== 1 ? 's' : ''} of bookings`);
  console.log(`Stripe key: ${STRIPE_LIVE_KEY.slice(0, 12)}...${STRIPE_LIVE_KEY.slice(-4)}  (live mode)`);
  console.log('');

  /* Sanity check the Stripe key first — fail fast if it's revoked, wrong
     account, or restricted. Costs one cheap API call. */
  let account;
  try {
    account = await stripe.accounts.retrieve();
    console.log(`${GREEN}✓${RESET} Connected to Stripe LIVE: ${account.business_profile?.name || account.email || account.id}`);
  } catch (err) {
    console.error(`${RED}FATAL${RESET}: Stripe API call failed with the provided key.`);
    console.error('  Error:', err.message);
    if (err.statusCode === 401) {
      console.error('  401 means the key is invalid, revoked, or for a different account.');
    }
    process.exit(2);
  }
  console.log('');

  const sinceIso = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000).toISOString();
  const path = '/bookings'
    + '?select=session_id,customer_email,full_name,phone,date,booked_at,grand_total,amount_total,status,payment_intent_id,confirmation_email_sent'
    + '&session_id=not.is.null'
    + '&booked_at=gte.' + encodeURIComponent(sinceIso)
    + '&order=booked_at.desc'
    + '&limit=1000';

  let bookings;
  try {
    bookings = await supabaseGet(path);
  } catch (err) {
    console.error(`${RED}FATAL${RESET}: failed to fetch bookings:`, err.message);
    process.exit(2);
  }

  console.log(`Found ${BOLD}${bookings.length}${RESET} booking row(s) with a session_id since ${sinceIso.slice(0, 10)}.`);
  console.log('');

  if (bookings.length === 0) {
    console.log(`${GREEN}Nothing to audit.${RESET} No bookings with Stripe session IDs in this window.`);
    process.exit(0);
  }

  const results = { live: [], sandbox: [], error: [], skipped: [] };

  if (VERBOSE) {
    console.log(`${GRAY}Per-booking verdicts (--verbose):${RESET}`);
  }

  for (const b of bookings) {
    const { verdict, reason } = await checkBooking(b);
    results[verdict].push({ ...b, _reason: reason });

    if (VERBOSE) {
      const tag =
        verdict === 'live'    ? `${GREEN}LIVE   ${RESET}` :
        verdict === 'sandbox' ? `${RED}SANDBOX${RESET}` :
        verdict === 'error'   ? `${YELLOW}ERROR  ${RESET}` :
                                `${GRAY}SKIP   ${RESET}`;
      console.log(`  ${tag}  ${b.session_id}  ${b.customer_email || '(no email)'}  ${fmt$(amountOf(b))}  ${b.date || '—'}`);
    }
  }

  if (VERBOSE) console.log('');

  // ─── Summary ───
  console.log(`${BOLD}=== Summary ===${RESET}`);
  console.log(`  ${GREEN}LIVE bookings:${RESET}     ${results.live.length}`);
  console.log(`  ${RED}SANDBOX bookings:${RESET}  ${results.sandbox.length}${results.sandbox.length > 0 ? `  ${RED}⚠ THESE CUSTOMERS WERE NOT CHARGED REAL MONEY${RESET}` : ''}`);
  console.log(`  ${YELLOW}ERRORS:${RESET}            ${results.error.length}`);
  console.log(`  ${GRAY}SKIPPED:${RESET}           ${results.skipped.length}`);
  console.log('');

  if (results.sandbox.length > 0) {
    console.log(`${BOLD}${RED}═══ AFFECTED CUSTOMERS — payment was NOT actually charged ═══${RESET}`);
    console.log('');
    results.sandbox.forEach((b, i) => {
      const amt = amountOf(b);
      console.log(`  ${BOLD}${i + 1}. ${b.full_name || '(no name)'}${RESET}`);
      console.log(`       Email:    ${b.customer_email || '(none)'}`);
      console.log(`       Phone:    ${b.phone || '(none)'}`);
      console.log(`       Charter:  ${b.date || '(no date)'}`);
      console.log(`       Amount:   ${fmt$(amt)}`);
      console.log(`       Booked:   ${b.booked_at}`);
      console.log(`       Session:  ${b.session_id}`);
      console.log(`       Status:   ${b.status || '(none)'}`);
      console.log(`       Reason:   ${b._reason}`);
      console.log('');
    });

    const totalLost = results.sandbox.reduce((s, b) => s + amountOf(b), 0);
    console.log(`  ${BOLD}Total uncollected: ${RED}${fmt$(totalLost)}${RESET}`);
    console.log('');
    console.log(`${YELLOW}Suggested next steps:${RESET}`);
    console.log(`  1. Contact each customer personally (phone is fastest) — explain and re-collect payment.`);
    console.log(`  2. For each: decide whether to honor at the booked rate, re-charge via Stripe Payment Link, or cancel.`);
    console.log(`  3. After resolution, either patch the row (status/refund_amount) or delete it.`);
    console.log(`  4. DO NOT lift the offline banner until Vercel STRIPE_SECRET_KEY is swapped to sk_live_*`);
    console.log(`     AND a real card test charge completes end-to-end through the live webhook.`);
  } else {
    console.log(`${GREEN}✓ No sandbox bookings found in this window.${RESET}`);
    console.log(`  All ${results.live.length} session(s) verified live.`);
  }

  if (results.error.length > 0) {
    console.log('');
    console.log(`${YELLOW}Bookings with lookup errors (verify these manually in the Stripe dashboard):${RESET}`);
    results.error.forEach((b, i) => {
      console.log(`  ${i + 1}. ${b.session_id}  |  ${b.customer_email || '—'}`);
      console.log(`     err: ${b._reason}`);
    });
  }

  process.exit(results.sandbox.length > 0 ? 1 : 0);
}

main().catch(err => {
  console.error(`${RED}FATAL${RESET}: unhandled error:`, err.message);
  console.error(err.stack);
  process.exit(2);
});
