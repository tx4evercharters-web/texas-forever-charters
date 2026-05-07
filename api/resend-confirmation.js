const { sendConfirmationEmails } = require('../lib/send-emails');
const { findBookingBySessionId, patchBooking } = require('../lib/storage');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

module.exports = async function handler(req, res) {
  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};
  const session_id    = (body.session_id || '').toString().trim();
  const emailOverride = body.email ? body.email.toString().trim().toLowerCase() : null;

  if (!session_id) return res.status(400).json({ error: 'session_id required' });

  if (emailOverride && !EMAIL_RE.test(emailOverride)) {
    return res.status(400).json({ error: 'Invalid email address' });
  }

  console.log('[resend-confirmation] request', 'session:', session_id,
    '| override:', emailOverride || '(none)');

  // Look up the booking
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

  // Apply email override before sending so the new address is in lib/storage
  // and reflected in any future admin views.
  if (emailOverride && emailOverride !== (booking.customer_email || '').toLowerCase()) {
    try {
      await patchBooking(session_id, { customer_email: emailOverride });
      booking.customer_email = emailOverride;
      console.log('[resend-confirmation] customer_email updated for', session_id, '→', emailOverride);
    } catch (err) {
      console.error('[resend-confirmation] failed to update customer_email:', err.message);
      return res.status(500).json({ error: 'Could not update email on booking' });
    }
  }

  if (!booking.customer_email) {
    return res.status(400).json({ error: 'No email on file for this booking. Please provide one.' });
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
