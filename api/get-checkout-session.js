const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { findBookingBySessionId } = require('../lib/storage');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

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

    return res.status(200).json({
      id:             session.id,
      payment_status: session.payment_status,
      amount_total:   session.amount_total,
      currency:       session.currency,
      customer_email: session.customer_email,
      metadata:       session.metadata,
      booking: booking ? {
        confirmation_email_sent: booking.confirmation_email_sent === true,
        customer_email:          booking.customer_email || null,
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
