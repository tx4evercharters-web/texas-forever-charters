const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { sendConfirmationEmails } = require('../lib/send-emails');
const { saveBooking } = require('../lib/storage');

// Vercel must not parse the body — Stripe signature verification needs the raw bytes.
module.exports.config = { api: { bodyParser: false } };

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const sig = req.headers['stripe-signature'];
  if (!sig) {
    return res.status(400).json({ error: 'Missing Stripe signature' });
  }

  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    console.error('STRIPE_WEBHOOK_SECRET not configured');
    return res.status(500).json({ error: 'Webhook not configured' });
  }

  let event;
  try {
    const rawBody = await getRawBody(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: 'Webhook signature verification failed' });
  }

  if (event.type !== 'checkout.session.completed') {
    // Acknowledge unhandled event types without processing
    return res.status(200).json({ received: true });
  }

  const session = event.data.object;

  // Only send emails when payment is confirmed
  if (session.payment_status !== 'paid') {
    return res.status(200).json({ received: true });
  }

  const meta = session.metadata || {};

  // Persist booking to storage for the admin dashboard
  const grandTotal = parseFloat(meta.grand_total || 0);
  const amountPaidDollars = session.amount_total / 100;
  const remaining = meta.payment_type === 'deposit'
    ? Math.max(0, grandTotal - amountPaidDollars)
    : 0;

  try {
    await saveBooking({
      session_id:       session.id,
      customer_email:   session.customer_email,
      amount_total:     session.amount_total,
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
      paid_in_full:     meta.payment_type !== 'deposit',
      remaining_balance: remaining,
      booked_at:        new Date().toISOString(),
    });
    console.log('Booking saved to storage for session:', session.id);
  } catch (err) {
    console.error('Failed to save booking to storage:', err.message);
  }

  const emailData = {
    // From Stripe session
    customer_email: session.customer_email,
    amount_total:   session.amount_total,   // cents
    session_id:     session.id,

    // From booking metadata
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
    await sendConfirmationEmails(emailData);
    console.log('Confirmation emails sent for session:', session.id);
  } catch (err) {
    // Log but don't return 500 — Stripe would retry indefinitely on non-2xx
    console.error('Failed to send confirmation emails:', err.message);
  }

  return res.status(200).json({ received: true });
};
