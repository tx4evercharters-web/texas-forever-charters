/* One-time backfill — link orphan waivers to bookings via fuzzy match.
 *
 * Background: lib/storage.js#createWaiver previously linked waivers to
 * bookings only by exact session_id match. Manual admin-created bookings
 * (synthetic manual_xxx session_id) and waivers signed via the generic
 * /waiver.html URL ended up with booking_id=NULL. After today's A4
 * deploy, new waivers attempt a (charter_date, charter_time, vessel)
 * fuzzy match when the session_id lookup misses. This script applies
 * the same fuzzy match retroactively to existing orphans.
 *
 * Behavior:
 *   - Reads waivers where booking_id IS NULL.
 *   - For each, queries bookings on the (date, time_slot, vessel) triple.
 *     * Exactly 1 match → PATCH waiver: booking_id, auto_linked=true.
 *     * 0 matches      → leave as orphan (logged NONE).
 *     * 2+ matches     → leave as orphan (logged AMBG, lists candidates).
 *   - Read-only against bookings. Only updates waivers. Never deletes.
 *   - Safe to run repeatedly; already-linked waivers are filtered out
 *     server-side by the booking_id=is.null query.
 *
 * Usage (Windows PowerShell, with .env.production from `vercel env pull`):
 *   node --env-file=.env.production scripts/backfill-waiver-links.js --dry-run
 *   node --env-file=.env.production scripts/backfill-waiver-links.js
 *
 * Or set env vars directly:
 *   $env:SUPABASE_URL="https://xxx.supabase.co"
 *   $env:SUPABASE_SECRET_KEY="..."
 *   node scripts/backfill-waiver-links.js
 *
 * Exit codes:
 *   0 — clean run (any number of links / no-matches / ambiguous OK)
 *   2 — environment / API error (script couldn't run)
 */

const https = require('https');

const DRY_RUN = process.argv.includes('--dry-run') || process.argv.includes('-n');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;

const RED = '\x1b[31m', GREEN = '\x1b[32m', YELLOW = '\x1b[33m',
      GRAY = '\x1b[90m', BOLD = '\x1b[1m', RESET = '\x1b[0m';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error(`${RED}FATAL${RESET}: SUPABASE_URL and SUPABASE_SECRET_KEY env vars required.`);
  console.error('Pull from Vercel:  vercel env pull .env.production --environment=production');
  console.error('Then:              node --env-file=.env.production scripts/backfill-waiver-links.js');
  process.exit(2);
}

/* Mirror of lib/timeslots.js#normalize — keeps this script standalone
   so it doesn't need to require anything from lib/. */
function normalizeTime(t) {
  if (!t) return '';
  return String(t).toLowerCase().replace(/\s+/g, '');
}

function supabaseRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(SUPABASE_URL.replace(/\/+$/, '') + '/rest/v1' + path);
    const bodyStr = body ? JSON.stringify(body) : null;
    const headers = {
      apikey:        SUPABASE_KEY,
      Authorization: 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json',
      Accept:        'application/json',
      Prefer:        'return=representation',
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

async function findBookingsByCharter(charter_date, charter_time, vessel) {
  if (!charter_date || !charter_time || !vessel) return [];
  const t = normalizeTime(charter_time);
  const v = String(vessel).toLowerCase().trim();
  if (!t || !v) return [];
  const path = '/bookings?select=id,session_id,date,time_slot,vessel,full_name,status' +
    '&date=eq.'      + encodeURIComponent(charter_date) +
    '&time_slot=eq.' + encodeURIComponent(t) +
    '&vessel=eq.'    + encodeURIComponent(v);
  const rows = await supabaseRequest('GET', path);
  return Array.isArray(rows) ? rows : [];
}

async function patchWaiver(id, updates) {
  return supabaseRequest('PATCH',
    '/waivers?id=eq.' + encodeURIComponent(id),
    updates
  );
}

function fmtSigner(w) {
  const first = (w.signer_first_name || '').trim();
  const last  = (w.signer_last_name  || '').trim();
  return (first + ' ' + last).trim() || '(no name)';
}

async function main() {
  console.log(`${BOLD}=== Waiver Backfill — Fuzzy Linker ===${RESET}`);
  if (DRY_RUN) console.log(`${YELLOW}DRY-RUN mode — no writes will occur.${RESET}`);
  console.log('');

  let orphans;
  try {
    orphans = await supabaseRequest('GET',
      '/waivers?booking_id=is.null&select=id,session_id,charter_date,charter_time,vessel,' +
      'signer_first_name,signer_last_name,signed_at&order=signed_at.desc&limit=1000'
    ) || [];
  } catch (err) {
    console.error(`${RED}FATAL${RESET}: failed to fetch orphan waivers: ${err.message}`);
    process.exit(2);
  }

  console.log(`Found ${BOLD}${orphans.length}${RESET} orphan waiver(s) (booking_id IS NULL).`);
  console.log('');

  if (orphans.length === 0) {
    console.log(`${GREEN}Nothing to do.${RESET} All waivers already have booking_id.`);
    return;
  }

  const summary = { linked: 0, ambiguous: 0, no_match: 0, missing_fields: 0, errors: 0 };

  for (const w of orphans) {
    const sname = fmtSigner(w).padEnd(28);
    const tag = w.id.slice(0, 8) + '  ' + sname;

    if (!w.charter_date || !w.charter_time || !w.vessel) {
      summary.missing_fields++;
      console.log(`  ${GRAY}SKIP${RESET}  ${tag} — missing charter_date/charter_time/vessel`);
      continue;
    }

    let candidates;
    try {
      candidates = await findBookingsByCharter(w.charter_date, w.charter_time, w.vessel);
    } catch (err) {
      summary.errors++;
      console.error(`  ${RED}ERR ${RESET}  ${tag} — booking lookup failed: ${err.message}`);
      continue;
    }

    const t = normalizeTime(w.charter_time);
    const v = String(w.vessel).toLowerCase().trim();

    if (candidates.length === 0) {
      summary.no_match++;
      console.log(`  ${YELLOW}NONE${RESET}  ${tag} — no booking matches ${w.charter_date} ${t} ${v}`);
      continue;
    }
    if (candidates.length > 1) {
      summary.ambiguous++;
      const ids = candidates.map(b => b.id.slice(0, 8)).join(', ');
      console.log(`  ${YELLOW}AMBG${RESET}  ${tag} — ${candidates.length} candidates: ${ids}`);
      continue;
    }

    const booking = candidates[0];
    const target = booking.id.slice(0, 8) + ' (' + (booking.full_name || '—') + ')';

    if (DRY_RUN) {
      summary.linked++;
      console.log(`  ${GREEN}LINK${RESET}  ${tag} → booking ${target} ${GRAY}[DRY-RUN]${RESET}`);
      continue;
    }

    try {
      await patchWaiver(w.id, { booking_id: booking.id, auto_linked: true });
      summary.linked++;
      console.log(`  ${GREEN}LINK${RESET}  ${tag} → booking ${target}`);
    } catch (err) {
      summary.errors++;
      console.error(`  ${RED}ERR ${RESET}  ${tag} — patch failed: ${err.message}`);
    }
  }

  console.log('');
  console.log(`${BOLD}=== Summary ===${RESET}`);
  console.log(`  ${GREEN}Linked:${RESET}             ${summary.linked}`);
  console.log(`  ${YELLOW}Ambiguous (>1):${RESET}     ${summary.ambiguous}`);
  console.log(`  ${YELLOW}No match:${RESET}           ${summary.no_match}`);
  console.log(`  ${GRAY}Missing fields:${RESET}     ${summary.missing_fields}`);
  console.log(`  ${RED}Errors:${RESET}             ${summary.errors}`);
  console.log('');
  if (DRY_RUN) {
    console.log(`${YELLOW}DRY-RUN — no rows were modified. Re-run without --dry-run to apply.${RESET}`);
  } else if (summary.linked > 0) {
    console.log(`${GREEN}✓ Done.${RESET} Patched ${summary.linked} waiver row(s) with booking_id + auto_linked=true.`);
  }
}

main().catch(err => {
  console.error(`${RED}FATAL${RESET}: unhandled error:`, err.message);
  console.error(err.stack);
  process.exit(2);
});
