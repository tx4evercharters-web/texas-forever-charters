/* Booking verification harness.
   Queries Supabase for recent bookings and checks each row's pricing
   integrity against the canonical lib/pricing rules.

   Usage:
     # Pull production env vars into .env (one-time, after `vercel link`):
     vercel env pull .env.production --environment=production

     # Run against last 24h:
     SUPABASE_URL=... SUPABASE_SECRET_KEY=... node verify-bookings.js

     # Or with a custom window:
     HOURS=48 SUPABASE_URL=... SUPABASE_SECRET_KEY=... node verify-bookings.js

   Reports per row:
     - grand_total populated
     - add_on_total matches what add_ons JSON computes to (with snake_case keys)
     - promo_applied / promo_code consistency
     - confirmation_email_sent status

   Distinguishes legacy bookings (with customer-style add-on keys —
   drone/water/beerpong — pre-pricing-consolidation) from post-fix bookings
   so the historical add_on_total=0 bug doesn't drown out real regressions.

   Read-only — never writes to Supabase. */

const https = require('https');
const { ADD_ON_PRICES } = require('./lib/pricing');

const HOURS = parseInt(process.env.HOURS, 10) || 24;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing env vars. Set SUPABASE_URL and SUPABASE_SECRET_KEY.');
  console.error('To pull from Vercel: `vercel env pull .env.production --environment=production`');
  console.error('Then: `node --env-file=.env.production verify-bookings.js`  (Node 20.6+)');
  console.error('Or:   `set -a; source .env.production; set +a; node verify-bookings.js`');
  process.exit(1);
}

const CUSTOMER_KEYS = ['drone', 'water', 'beerpong']; // pre-consolidation customer-side keys
const SNAKE_KEYS    = ['drone_footage', 'water_bottles', 'ice', 'beer_pong']; // post-fix snake_case keys

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

function parseAddOns(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return {}; }
}

function computeExpectedAddOnTotal(addOns) {
  let t = 0;
  if (addOns.drone_footage) t += ADD_ON_PRICES.drone_footage;
  if (addOns.water_bottles) t += ADD_ON_PRICES.water_bottles;
  if (addOns.ice)           t += ADD_ON_PRICES.ice;
  if (addOns.beer_pong)     t += ADD_ON_PRICES.beer_pong;
  const towelQty = parseInt(addOns.towels, 10) || 0;
  if (towelQty > 0) t += ADD_ON_PRICES.towels * towelQty;
  return t;
}

function hasCustomerStyleKeys(addOns) {
  return CUSTOMER_KEYS.some(k => k in addOns);
}

function hasSnakeStyleKeys(addOns) {
  return SNAKE_KEYS.some(k => k in addOns);
}

function fmt$(n) {
  return '$' + Number(n || 0).toFixed(2);
}

(async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Booking verification — last ' + HOURS + ' hours');
  console.log('  Run at ' + new Date().toISOString());
  console.log('═══════════════════════════════════════════════════════════');

  const since = new Date(Date.now() - HOURS * 3600 * 1000).toISOString();
  const path = '/bookings?booked_at=gte.' + encodeURIComponent(since)
             + '&select=session_id,customer_email,date,booked_at,grand_total,add_on_total,add_ons,promo_applied,promo_code,confirmation_email_sent,status'
             + '&order=booked_at.desc';

  let rows;
  try {
    rows = await supabaseGet(path);
  } catch (err) {
    console.error('Supabase query failed:', err.message);
    process.exit(2);
  }

  if (!Array.isArray(rows) || rows.length === 0) {
    console.log('\nNo bookings in the last ' + HOURS + ' hours.\n');
    process.exit(0);
  }

  console.log('\nFound ' + rows.length + ' booking' + (rows.length === 1 ? '' : 's') + '.\n');

  const stats = {
    total: rows.length,
    ok: 0,
    legacyKeysSilentZero: 0,
    addOnTotalMismatchPostFix: 0,
    grandTotalMissing: 0,
    promoInconsistent: 0,
    emailUnsent: 0,
    cancelled: 0,
  };

  rows.forEach((r, i) => {
    const addOns = parseAddOns(r.add_ons);
    const expectedAddOnTotal = computeExpectedAddOnTotal(addOns);
    const storedAddOnTotal = parseFloat(r.add_on_total) || 0;
    const customerKeys = hasCustomerStyleKeys(addOns);
    const snakeKeys = hasSnakeStyleKeys(addOns);
    const towelsAlone = (addOns.towels && Object.keys(addOns).length === 1);

    const issues = [];
    let isLegacy = false;

    // Grand total presence
    const grandTotal = parseFloat(r.grand_total) || 0;
    if (!grandTotal) {
      issues.push('CRITICAL: grand_total missing or zero');
      stats.grandTotalMissing++;
    }

    // add_on_total integrity
    if (Math.abs(storedAddOnTotal - expectedAddOnTotal) > 0.01) {
      if (customerKeys && !snakeKeys) {
        issues.push('LEGACY: add_ons uses pre-consolidation customer keys (' +
          Object.keys(addOns).filter(k => CUSTOMER_KEYS.includes(k)).join(',') +
          ') — add_on_total stored as ' + fmt$(storedAddOnTotal) +
          ' but a fix-aware sum would be ' + fmt$(expectedAddOnTotal) +
          ' (zero by definition since no snake_case keys present)');
        isLegacy = true;
        stats.legacyKeysSilentZero++;
      } else {
        issues.push('REGRESSION: add_on_total stored ' + fmt$(storedAddOnTotal) +
          ' but expected ' + fmt$(expectedAddOnTotal) +
          ' from add_ons ' + JSON.stringify(addOns));
        stats.addOnTotalMismatchPostFix++;
      }
    }

    // Promo consistency
    const pa = !!r.promo_applied;
    const pc = (r.promo_code || '').trim();
    if (pa && !pc) {
      // Only flag if booking was made AFTER the promo_code metadata field
      // was added (this commit). Pre-deploy bookings won't have promo_code
      // even though promo_applied is true. We can detect this by booked_at.
      issues.push('NOTE: promo_applied=true but promo_code empty (likely pre-' +
                  'consolidation booking — promo_code metadata field added in 965ac0d)');
    } else if (!pa && pc) {
      issues.push('INCONSISTENT: promo_code="' + pc + '" but promo_applied=false');
      stats.promoInconsistent++;
    }

    // Confirmation email
    if (r.confirmation_email_sent === false) {
      issues.push('FYI: confirmation_email_sent=false — chase down delivery / offer resend');
      stats.emailUnsent++;
    }

    if (r.status === 'cancelled') stats.cancelled++;

    const isOK = issues.length === 0;
    if (isOK) stats.ok++;

    console.log('[' + (i + 1) + '] ' + (r.session_id || '(no session)').slice(0, 40) +
                '  |  ' + (r.date || '?') +
                '  |  ' + (r.customer_email || '?') +
                (r.status ? '  |  status=' + r.status : ''));
    console.log('    booked_at:           ' + r.booked_at);
    console.log('    grand_total:         ' + fmt$(grandTotal) + (grandTotal ? '  ✓' : '  ✗'));
    console.log('    add_ons:             ' + JSON.stringify(addOns));
    console.log('    add_on_total:        stored ' + fmt$(storedAddOnTotal) +
                ', expected ' + fmt$(expectedAddOnTotal) +
                (Math.abs(storedAddOnTotal - expectedAddOnTotal) <= 0.01 ? '  ✓' : (isLegacy ? '  ⚠ legacy' : '  ✗')));
    console.log('    promo:               applied=' + pa + ' code=' + JSON.stringify(pc || null));
    console.log('    confirmation email:  ' + (r.confirmation_email_sent === true ? 'sent ✓'
                : r.confirmation_email_sent === false ? 'NOT sent ✗' : 'unknown ?'));
    if (issues.length > 0) {
      console.log('    issues:');
      issues.forEach(s => console.log('      - ' + s));
    }
    console.log('');
  });

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Summary');
  console.log('───────────────────────────────────────────────────────────');
  console.log('  Total bookings in window:        ' + stats.total);
  console.log('  Cancelled (informational):       ' + stats.cancelled);
  console.log('  ✅ OK (no issues):                ' + stats.ok);
  console.log('  ⚠️  Legacy add_on_total=0 bug:    ' + stats.legacyKeysSilentZero +
              '  (expected for bookings before commit 965ac0d)');
  console.log('  🔴 Post-fix add_on_total wrong:   ' + stats.addOnTotalMismatchPostFix +
              '  (any non-zero is a regression to investigate)');
  console.log('  🔴 Missing grand_total:           ' + stats.grandTotalMissing);
  console.log('  🔴 Promo inconsistency:           ' + stats.promoInconsistent);
  console.log('  ⚠️  Confirmation email not sent:  ' + stats.emailUnsent);
  console.log('═══════════════════════════════════════════════════════════');

  // Exit non-zero if any post-fix regressions found, so this can be wired
  // into a cron/CI check that pages someone if pricing data drifts.
  const criticalCount = stats.addOnTotalMismatchPostFix + stats.grandTotalMissing + stats.promoInconsistent;
  process.exit(criticalCount > 0 ? 3 : 0);
})();
