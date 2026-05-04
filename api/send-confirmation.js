const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { sendConfirmationEmails } = require('../lib/send-emails');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Accepts { session_id } — looks up the Stripe session and re-sends both emails.
// Useful for manual resends if the webhook missed a delivery.
module.exports = async function handler(req, res) {
  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { session_id } = req.body || {};

  if (!session_id || !session_id.startsWith('cs_')) {
    return res.status(400).json({ error: 'Valid session_id required' });
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(500).json({ error: 'Stripe not configured' });
  }

  if (!process.env.RESEND_API_KEY) {
    return res.status(500).json({ error: 'Email service not configured' });
  }

  let session;
  try {
    session = await stripe.checkout.sessions.retrieve(session_id);
  } catch (err) {
    return res.status(404).json({ error: 'Session not found: ' + err.message });
  }

  if (session.payment_status !== 'paid') {
    return res.status(400).json({ error: 'Session payment not completed' });
  }

  const meta = session.metadata || {};

  const emailData = {
    customer_email:   session.customer_email,
    amount_total:     session.amount_total,
    session_id:       session.id,
    charter_name:     meta.charter_name,
    vessel:           meta.vessel,
    experience:       meta.experience,
    date:             meta.date,
    time_slot:        meta.time_slot,
    duration:         meta.duration,
    full_name:        meta.full_name,
    party_size:       meta.party_size,
    phone:            meta.phone,
    payment_type:     meta.payment_type,
    grand_total:      meta.grand_total,
    deposit_amount:   meta.deposit_amount,
    add_ons:          meta.add_ons,
    special_requests: meta.special_requests,
    promo_applied:    meta.promo_applied,
    newsletter:       meta.newsletter,
  };

  try {
    const result = await sendConfirmationEmails(emailData);
    return res.status(200).json({ success: true, result });
  } catch (err) {
    console.error('send-confirmation error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
