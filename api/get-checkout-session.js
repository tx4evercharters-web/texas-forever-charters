const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { findBookingBySessionId } = require('../lib/storage');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

/* Redaction helpers — public endpoint must not leak raw PII even to the
   legitimate customer holding their own session_id (a leaked URL would
   otherwise harvest full email + phone + name for targeted phishing).
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

module.exports = async function handler(req, res) {
  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { session_id } = req.query;

  if (!session_id || !session_id.startsWith('cs_')) {
    return res.status(400).json({ error: 'Invalid session_id' });
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(500).json({ error: 'Payment processor not configured' });
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);

    /* Pull the matching Supabase row (best-effort) so the confirmation page
       can detect whether the customer email actually went out. A Supabase
       outage shouldn't break the page — if the lookup fails, we just omit
       the booking fields and the UI degrades to its original behavior. */
    let booking = null;
    try {
      booking = await findBookingBySessionId(session_id);
    } catch (err) {
      console.error('[get-checkout-session] booking lookup failed:', err.message);
    }

    /* Whitelist metadata fields. Strips raw full_name and phone — those
       are returned as redacted top-level fields below. Drops fields the
       frontend never consumes (newsletter, promo_*, terms_agreed flag,
       fee breakdown) to minimize the public surface. The previous shape
       passed session.metadata through whole, leaking PII to anyone with
       a session_id. Ref: docs/audits/security-audit-2026-05-15.md §1.2 */
    const meta = session.metadata || {};
    const rawEmail = session.customer_email || (booking && booking.customer_email) || null;
    const safeMetadata = {
      charter_name:        meta.charter_name        || null,
      vessel:              meta.vessel              || null,
      experience:          meta.experience          || null,
      date:                meta.date                || null,
      time_slot:           meta.time_slot           || null,
      duration:            meta.duration            || null,
      party_size:          meta.party_size          || null,
      payment_type:        meta.payment_type        || null,
      grand_total:         meta.grand_total         || null,
      deposit_amount:      meta.deposit_amount      || null,
      add_ons:             meta.add_ons             || null,
      special_requests:    meta.special_requests    || null,
      original_session_id: meta.original_session_id || null,
      terms_agreed_at:     meta.terms_agreed_at     || null,
    };

    return res.status(200).json({
      id:             session.id,
      payment_status: session.payment_status,
      amount_total:   session.amount_total,
      customer_email_masked: maskEmail(rawEmail),
      customer_first_name:   firstName(meta.full_name),
      customer_phone_masked: maskPhone(meta.phone),
      metadata:              safeMetadata,
      booking: booking ? {
        confirmation_email_sent: booking.confirmation_email_sent === true,
      } : null,
    });
  } catch (err) {
    console.error('[get-checkout-session] Stripe error:', err.message);
    if (err.type === 'StripeInvalidRequestError') {
      return res.status(404).json({ error: 'Session not found' });
    }
    return res.status(500).json({ error: err.message });
  }
};
