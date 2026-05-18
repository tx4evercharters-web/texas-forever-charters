const { findBookingByPortalToken, countWaiversBySessionId } = require('../lib/storage');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

/* Redaction helpers — duplicated from api/get-checkout-session.js per the
   Phase 4 Commit 1 decision (Option A). The customer portal is the second
   public surface that surfaces booking PII to a token-bearing caller; when
   a third such surface appears (e.g. POST /api/portal/<token>/create-balance-
   session, GET /api/portal/<token>/waiver-status), extract these into
   lib/redact.js in a focused refactor commit.
   Ref: docs/audits/security-audit-2026-05-15.md §1.2 */

// "jane.doe@gmail.com" → "j*****@gmail.com"
function maskEmail(email) {
  if (!email || typeof email !== 'string') return null;
  const at = email.indexOf('@');
  if (at < 1) return null;
  return email[0] + '*****' + email.slice(at);
}

// "Jane Doe" → "Jane"
function firstName(fullName) {
  if (!fullName || typeof fullName !== 'string') return null;
  const trimmed = fullName.trim();
  if (!trimmed) return null;
  return trimmed.split(/\s+/)[0];
}

// "(737) 368-1669" → "***-***-1669"; strips non-digits first so any format works
function maskPhone(phone) {
  if (!phone || typeof phone !== 'string') return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 4) return null;
  return '***-***-' + digits.slice(-4);
}

/* Today as YYYY-MM-DD in America/Chicago, matching how charter dates are
   stored. Mirrors api/cron-reminders.js:54-65 so past-charter detection
   doesn't drift at UTC midnight. */
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

function vesselDisplay(vessel) {
  if (vessel === 'yacht')   return '40ft Carver Aft Cabin Yacht';
  if (vessel === 'pontoon') return '24ft Bentley Navigator 243 Pontoon';
  return vessel || null;
}

module.exports = async function handler(req, res) {
  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const token = (req.query.token || '').toString().trim().toLowerCase();

  /* Token shape validation. Returns 404 (not 400) so a malformed token is
     indistinguishable from an unmatched one — denies an attacker the
     ability to probe the token namespace for "is this a real prefix". */
  if (!/^[a-f0-9]{32}$/.test(token)) {
    return res.status(404).json({ error: 'Booking not found' });
  }

  let booking;
  try {
    booking = await findBookingByPortalToken(token);
  } catch (err) {
    console.error('[portal] lookup failed:', err.message);
    return res.status(500).json({ error: 'Could not load booking' });
  }

  /* findBookingByPortalToken already filters deleted_at IS NULL at the
     Supabase query layer, so soft-deleted bookings also fall through here
     as null. Both unmatched-token and soft-deleted return 404. */
  if (!booking) {
    return res.status(404).json({ error: 'Booking not found' });
  }

  const is_past = (booking.date || '') < todayCentral();

  /* Count waivers signed against this booking's session_id. Best-effort —
     on failure (Supabase outage, malformed range header, etc.) default to
     0 so the portal still renders with a "0 signed" waiver state rather
     than throwing. Known gap: fuzzy-linked waivers (booking_id set but
     session_id null) are not counted; see lib/storage.js note. */
  let waivers_signed_count = 0;
  try {
    waivers_signed_count = await countWaiversBySessionId(booking.session_id);
  } catch (err) {
    console.error('[portal] waiver count failed:', err.message);
  }

  return res.status(200).json({
    id:                    booking.session_id,
    vessel:                booking.vessel,
    vessel_display:        vesselDisplay(booking.vessel),
    date:                  booking.date,
    time_slot:             booking.time_slot,
    duration:              booking.duration,
    party_size:            booking.party_size,
    charter_name:          booking.charter_name,
    experience:            booking.experience,
    organizer_first_name:  firstName(booking.full_name),
    customer_email_masked: maskEmail(booking.customer_email),
    customer_phone_masked: maskPhone(booking.phone),
    payment_type:          booking.payment_type,
    deposit_amount:        booking.deposit_amount,
    grand_total:           booking.grand_total,
    remaining_balance:     booking.remaining_balance,
    paid_in_full:          booking.paid_in_full === true,
    status:                booking.status || 'upcoming',
    is_past,
    waivers_signed_count,
  });
};
