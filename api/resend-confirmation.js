const { sendConfirmationEmails } = require('../lib/send-emails');
const { findBookingBySessionId, patchBooking } = require('../lib/storage');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

module.exports = async function handler(req, res) {
  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  /* Security lockdown: this endpoint previously accepted a body.email
     override and patched booking.customer_email to the caller's value,
     enabling unauthenticated hijack of the recorded address. The override
     path is removed — any `email` field on the body is silently ignored
     (no 400, so a cached old frontend still resends successfully during
     the deploy window) and the resend always goes to the email on the
     booking row. Wrong-email recovery now flows through admin / phone
     support. Ref: docs/audits/security-audit-2026-05-15.md §1.3 */
  const body = req.body || {};
  const session_id = (body.session_id || '').toString().trim();

  if (!session_id) return res.status(400).json({ error: 'session_id required' });

  console.log('[resend-confirmation] request session:', session_id);

  let booking;
  try {
    booking = await findBookingBySessionId(session_id);
  } catch (err) {
    console.error('[resend-confirmation] booking lookup failed:', err.message);
    return res.status(500).json({ error: 'Could not look up booking' });
  }
  if (!booking) {
    return res.status(404).json({ error: 'Booking not found' });
  }

  if (!booking.customer_email) {
    return res.status(400).json({
      error: 'No email on file. Please contact us at (737) 368-1669.',
    });
  }

  // Build the email payload. Booking row field names line up with what
  // sendConfirmationEmails expects (same shape that's persisted from the
  // Stripe metadata in the webhook), so we can pass it through directly.
  const emailData = {
    session_id:        booking.session_id,
    customer_email:    booking.customer_email,
    amount_total:      booking.amount_total,
    charter_name:      booking.charter_name,
    vessel:            booking.vessel,
    experience:        booking.experience,
    date:              booking.date,
    time_slot:         booking.time_slot,
    duration:          booking.duration,
    full_name:         booking.full_name,
    party_size:        booking.party_size,
    phone:             booking.phone,
    payment_type:      booking.payment_type,
    grand_total:       booking.grand_total,
    deposit_amount:    booking.deposit_amount,
    add_ons:           booking.add_ons,
    special_requests:  booking.special_requests,
    promo_applied:     booking.promo_applied,
    newsletter:        booking.newsletter,
  };

  let result;
  try {
    result = await sendConfirmationEmails(emailData);
  } catch (err) {
    console.error('[resend-confirmation] send failed entirely', session_id, '|', err.message);
    return res.status(502).json({ error: 'Email send failed', detail: err.message });
  }

  const customerOk = !result.customerError;

  /* Mark the booking only when the customer-facing email actually went
     through. A successful business notification doesn't help the customer.
     PATCH failure is non-fatal — just log it. */
  try {
    await patchBooking(session_id, { confirmation_email_sent: customerOk });
  } catch (err) {
    console.error('[resend-confirmation] failed to update flag for', session_id, ':', err.message);
  }

  if (!customerOk) {
    return res.status(502).json({
      error: 'customer_email_failed',
      detail: result.customerError ? result.customerError.message : 'unknown',
    });
  }

  console.log('[resend-confirmation] OK', session_id, '→', booking.customer_email);
  return res.status(200).json({
    ok: true,
    email: booking.customer_email,
  });
};
