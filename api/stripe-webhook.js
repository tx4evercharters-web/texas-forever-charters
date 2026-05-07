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
  const stripeCustomerId = session.customer || null;
  const paymentIntentId = session.payment_intent || null;

  // Retrieve payment method from payment intent
  let paymentMethodId = null;
  if (paymentIntentId) {
    try {
      const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
      paymentMethodId = paymentIntent.payment_method || null;
    } catch (err) {
      console.error('Failed to retrieve payment intent:', err.message);
    }
  }

  // Authorize the $250 damage deposit hold against the saved payment method.
  // This is the earliest moment we have the customer + payment_method, so it
  // happens here rather than in create-checkout where neither exists yet.
  let damageHoldIntentId = null;
  let damageHoldStatus = 'pending';
  if (paymentMethodId && stripeCustomerId) {
    try {
      const damageHold = await stripe.paymentIntents.create({
        amount:         25000, // $250.00
        currency:       'usd',
        customer:       stripeCustomerId,
        payment_method: paymentMethodId,
        capture_method: 'manual',
        confirm:        true,
        off_session:    true,
        description:    `Damage deposit hold — ${meta.charter_name || 'charter'} on ${meta.date || ''}`,
        metadata: {
          purpose:            'damage_hold',
          booking_session_id: session.id,
        },
      });
      damageHoldIntentId = damageHold.id;
      // Stripe returns "requires_capture" once the hold is authorized successfully.
      // If we get something else (requires_action, processing), surface that status
      // so the admin UI can flag it for follow-up rather than treat it as healthy.
      damageHoldStatus = damageHold.status === 'requires_capture' ? 'pending' : damageHold.status;
      console.log('[damage-hold] authorized:', damageHold.id, 'status:', damageHold.status);
    } catch (err) {
      console.error('[damage-hold] failed to authorize $250 hold:', err.message);
      // Booking save must not fail because of a damage-hold authorization problem.
      // Leave damage_hold_intent_id null; admin can chase it up manually.
    }
  } else {
    console.warn('[damage-hold] skipping — missing paymentMethodId or stripeCustomerId');
  }

  const billingAddress = session.customer_details?.address || {};
  const city = billingAddress.city || null;
  const state = billingAddress.state || null;

  // Persist booking to storage for the admin dashboard
  const grandTotal = parseFloat(meta.grand_total || 0);
  const amountPaidDollars = session.amount_total / 100;
  const remaining = meta.payment_type === 'deposit'
    ? Math.max(0, grandTotal - amountPaidDollars)
    : 0;

  // Fee breakdown from metadata
  const adminFee = parseFloat(meta.admin_fee || 0);
  const taxAmount = parseFloat(meta.tax_amount || 0);
  const processingFee = parseFloat(meta.processing_fee || 0);
  const charterSubtotal = parseFloat(meta.charter_subtotal || 0);
  const promoDiscount = parseFloat(meta.promo_discount || 0);

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
      city:  city,
      state: state,
      stripe_customer_id: stripeCustomerId,
      payment_method_id:  paymentMethodId,
      payment_intent_id:  paymentIntentId,
      damage_hold_intent_id: damageHoldIntentId,
      damage_hold_status:    damageHoldStatus,
      paid_in_full:     meta.payment_type !== 'deposit',
      remaining_balance: remaining,
      admin_fee:         adminFee,
      tax_amount:        taxAmount,
      processing_fee:    processingFee,
      charter_subtotal:  charterSubtotal,
      promo_discount:    promoDiscount,
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
