const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const {
  sendConfirmationEmails,
  sendDamageHoldFailedAlert,
  sendStripeRefundReconciledAlert,
  sendChargebackAlert,
} = require('../lib/send-emails');
const { saveBooking, patchBooking, findBookingByPaymentIntent } = require('../lib/storage');

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

/* lib/storage.js formats Supabase REST errors as
   "Supabase POST /path → STATUS: body". A 5xx status (or any error that
   doesn't have a status — i.e. network/DNS/timeout) is treated as transient
   and retried. A 4xx status is permanent (bad data) — fail immediately so
   we don't waste retries on something that will never succeed. */
function isTransientSupabaseError(err) {
  if (!err) return false;
  const msg = err.message || String(err);
  const match = msg.match(/→ (\d{3}):/);
  if (!match) return true;
  return parseInt(match[1], 10) >= 500;
}

const SAVE_RETRY_DELAYS_MS = [500, 1500, 4500];

async function saveBookingWithRetry(bookingRow, sessionId) {
  let lastErr;
  for (let attempt = 1; attempt <= SAVE_RETRY_DELAYS_MS.length; attempt++) {
    try {
      await saveBooking(bookingRow);
      if (attempt > 1) {
        console.log('[stripe-webhook] saveBooking succeeded for', sessionId, 'on attempt', attempt);
      }
      return;
    } catch (err) {
      lastErr = err;
      const transient = isTransientSupabaseError(err);
      console.error('[stripe-webhook] saveBooking attempt', attempt, 'of',
        SAVE_RETRY_DELAYS_MS.length, 'failed for', sessionId,
        '| transient:', transient, '| err:', err.message);
      if (!transient) throw err;
      if (attempt < SAVE_RETRY_DELAYS_MS.length) {
        await new Promise(r => setTimeout(r, SAVE_RETRY_DELAYS_MS[attempt - 1]));
      }
    }
  }
  throw lastErr;
}

/* ── Additive event handlers (added 2026-05) ─────────────────────────────────
   These sit alongside the existing checkout.session.completed flow below.
   Each returns its own res.status — the dispatcher in handler() routes here
   before the existing flow ever sees the event. The legacy flow is untouched. */

async function handleChargeRefunded(event, res) {
  const charge = event.data.object;
  const piId = charge.payment_intent;
  const amountRefundedCents = charge.amount_refunded || 0;
  const amountTotalCents    = charge.amount || 0;
  const isFull = amountRefundedCents >= amountTotalCents && amountTotalCents > 0;

  console.log('[stripe-webhook] charge.refunded',
    'charge:', charge.id,
    '| payment_intent:', piId,
    '| amount_refunded:', amountRefundedCents,
    '| amount:', amountTotalCents,
    '| isFull:', isFull);

  if (!piId) {
    console.warn('[stripe-webhook] charge.refunded with no payment_intent — ignoring', charge.id);
    return res.status(200).json({ received: true, ignored: 'no_payment_intent' });
  }

  let booking;
  try {
    booking = await findBookingByPaymentIntent(piId);
  } catch (err) {
    console.error('[stripe-webhook] booking lookup failed for refund reconciliation:', err.message);
    return res.status(500).json({ error: 'booking_lookup_failed' });
  }

  if (!booking) {
    console.warn('[stripe-webhook] charge.refunded — no booking found for payment_intent', piId, '(possibly old/test charge)');
    return res.status(200).json({ received: true, ignored: 'no_booking' });
  }

  const newRefundDollars       = amountRefundedCents / 100;
  const existingRefundDollars  = parseFloat(booking.refund_amount || 0);
  const bookingTotalDollars    = (booking.amount_total || 0) / 100;

  /* Idempotency: the admin refund flow patches Supabase directly, so by
     the time charge.refunded arrives the row may already match. Skip the
     re-write AND the alert when the existing record already reflects this
     refund (or more), so admin-side refunds don't double-fire. */
  if (Math.abs(existingRefundDollars - newRefundDollars) < 0.01 ||
      existingRefundDollars >= newRefundDollars) {
    console.log('[stripe-webhook] refund already reconciled in Supabase — skipping', booking.session_id,
      '| existing:', existingRefundDollars, '| incoming:', newRefundDollars);
    return res.status(200).json({ received: true, idempotent: true });
  }

  const updates = {
    refund_amount: newRefundDollars,
    refunded_at:   new Date().toISOString(),
  };
  if (isFull) updates.status = 'cancelled';

  try {
    await patchBooking(booking.session_id, updates);
    console.log('[stripe-webhook] booking', booking.session_id, 'updated for Stripe-side refund: $', newRefundDollars,
      '| isFull:', isFull, '| total:', bookingTotalDollars);
  } catch (err) {
    console.error('[stripe-webhook] failed to patch booking for refund:', booking.session_id, err.message);
    return res.status(500).json({ error: 'patch_failed' });
  }

  /* Best-effort alert — booking is already updated, an alert send failure
     must not unwind the patch. */
  try {
    await sendStripeRefundReconciledAlert({ ...booking, ...updates }, newRefundDollars, isFull);
    console.log('[stripe-webhook] Stripe-refund reconciled alert sent for', booking.session_id);
  } catch (err) {
    console.error('[stripe-webhook] refund-reconciled alert send FAILED (booking still updated):',
      booking.session_id, '|', err.message);
  }

  return res.status(200).json({ received: true, refunded: newRefundDollars });
}

async function handleDisputeCreated(event, res) {
  const dispute = event.data.object;
  const piId = dispute.payment_intent;
  const amountCents = dispute.amount || 0;

  console.log('[stripe-webhook] charge.dispute.created',
    'dispute:', dispute.id,
    '| payment_intent:', piId,
    '| amount:', amountCents,
    '| reason:', dispute.reason,
    '| status:', dispute.status);

  let booking = null;
  if (piId) {
    try {
      booking = await findBookingByPaymentIntent(piId);
    } catch (err) {
      console.error('[stripe-webhook] booking lookup failed for chargeback:', err.message);
    }
  }

  if (!booking) {
    /* Unknown payment_intent — still send the alert with whatever Stripe
       gave us so the owner can manually research it. Build a stub. */
    console.warn('[stripe-webhook] charge.dispute.created — no booking found for payment_intent', piId);
    booking = {
      session_id:        null,
      payment_intent_id: piId,
      customer_email:    null,
      full_name:         null,
      date:              null,
      time_slot:         null,
      vessel:            null,
      phone:             null,
    };
  } else {
    /* Persist dispute metadata to the booking row. Status is intentionally
       NOT changed — chargebacks aren't cancellations, they're disputes. */
    const updates = {
      dispute_id:     dispute.id,
      dispute_status: dispute.status,
      dispute_amount: amountCents / 100,
      dispute_reason: dispute.reason,
      disputed_at:    new Date().toISOString(),
    };
    try {
      await patchBooking(booking.session_id, updates);
      console.log('[stripe-webhook] dispute persisted to booking', booking.session_id);
      Object.assign(booking, updates);
    } catch (err) {
      console.error('[stripe-webhook] failed to persist dispute on booking:', booking.session_id, err.message);
    }
  }

  try {
    await sendChargebackAlert(booking, dispute);
    console.log('[stripe-webhook] chargeback alert sent for dispute', dispute.id);
  } catch (err) {
    console.error('[stripe-webhook] chargeback alert send FAILED:', dispute.id, '|', err.message);
  }

  return res.status(200).json({ received: true });
}

module.exports = async function handler(req, res) {
  console.log('[stripe-webhook] hit',
    'method:', req.method,
    '| has_sig:', !!req.headers['stripe-signature'],
    '| RESEND_API_KEY set?', !!process.env.RESEND_API_KEY,
    '| SUPABASE_URL set?', !!process.env.SUPABASE_URL,
    '| STRIPE_WEBHOOK_SECRET set?', !!process.env.STRIPE_WEBHOOK_SECRET);

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const sig = req.headers['stripe-signature'];
  if (!sig) {
    console.error('[stripe-webhook] missing Stripe signature header');
    return res.status(400).json({ error: 'Missing Stripe signature' });
  }

  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    console.error('[stripe-webhook] STRIPE_WEBHOOK_SECRET not configured');
    return res.status(500).json({ error: 'Webhook not configured' });
  }

  let event;
  try {
    const rawBody = await getRawBody(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[stripe-webhook] signature verification failed:', err.message);
    return res.status(400).json({ error: 'Webhook signature verification failed' });
  }

  console.log('[stripe-webhook] event verified', 'id:', event.id, 'type:', event.type);

  /* ── Dispatch new event types BEFORE the legacy checkout.session.completed
     early-return. Each handler returns its own response. The original
     checkout.session.completed flow below is unchanged. ── */
  if (event.type === 'charge.refunded') {
    return await handleChargeRefunded(event, res);
  }
  if (event.type === 'charge.dispute.created') {
    return await handleDisputeCreated(event, res);
  }
  if (event.type === 'checkout.session.expired') {
    const s = event.data.object;
    const email = s.customer_email
      || (s.customer_details && s.customer_details.email)
      || 'unknown';
    console.log('[stripe-webhook] checkout.session.expired —',
      'customer:', email,
      '| amount: $' + ((s.amount_total || 0) / 100).toFixed(2),
      '| session:', s.id);
    return res.status(200).json({ received: true });
  }
  if (event.type === 'payment_intent.payment_failed') {
    const pi = event.data.object;
    const lastErr = pi.last_payment_error || {};
    const email = pi.receipt_email
      || (lastErr.payment_method && lastErr.payment_method.billing_details && lastErr.payment_method.billing_details.email)
      || 'unknown';
    console.log('[stripe-webhook] payment_intent.payment_failed —',
      'code:', lastErr.code || lastErr.decline_code || 'unknown',
      '| message:', lastErr.message || '(none)',
      '| amount: $' + ((pi.amount || 0) / 100).toFixed(2),
      '| customer:', email,
      '| intent:', pi.id);
    return res.status(200).json({ received: true });
  }

  if (event.type !== 'checkout.session.completed') {
    return res.status(200).json({ received: true });
  }

  const session = event.data.object;
  console.log('[stripe-webhook] checkout.session.completed',
    'session:',        session.id,
    '| payment_status:', session.payment_status,
    '| customer_email:', session.customer_email,
    '| amount_total:',   session.amount_total,
    '| has_metadata:',   !!session.metadata && Object.keys(session.metadata).length > 0);

  if (session.payment_status !== 'paid') {
    console.log('[stripe-webhook] session not paid yet, acknowledging without processing', session.id);
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
  let damageHoldError = null; // captured for the owner alert when the hold fails
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
      // Booking save must not fail because of a damage-hold authorization problem.
      // Mark the row 'failed' (not 'pending') so admin can distinguish, and
      // capture the error so we can email the owner after the booking row is
      // safely persisted.
      damageHoldStatus = 'failed';
      damageHoldError  = err.message || String(err);
      console.error('[damage-hold] failed to authorize $250 hold:', damageHoldError);
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

  /* Build the booking row once so we can pass it to retry, alert, and
     log it intact on permanent failure. */
  const bookingRow = {
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
    /* Terms-of-service acknowledgment captured at Step 8 (booking.html).
       Stripe metadata stores everything as strings, so coerce 'true' → true,
       and an empty string becomes null on the timestamp. */
    terms_agreed:     meta.terms_agreed === 'true',
    terms_agreed_at:  meta.terms_agreed_at || null,
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
  };

  /* Save with up-to-3 retries on transient errors. If the save permanently
     fails, return non-2xx so Stripe will retry the webhook per its standard
     schedule (3 attempts over 3 days). DO NOT send confirmation emails on
     permanent save failure — a confirmed customer with no booking row is
     worse than a delayed confirmation. */
  try {
    await saveBookingWithRetry(bookingRow, session.id);
    console.log('[stripe-webhook] booking saved to Supabase', session.id);
  } catch (err) {
    console.error('[stripe-webhook] CRITICAL: saveBooking FAILED PERMANENTLY for', session.id,
      '|', err.message,
      '\n  Stack:', err.stack,
      '\n  Booking context:', JSON.stringify(bookingRow));
    return res.status(500).json({
      error:      'database_save_failed',
      detail:     err.message,
      session_id: session.id,
    });
  }

  /* Damage-hold alert — fire after the booking is safely persisted so the
     owner has the full context. Best-effort; an alert send failure must
     not undo the booking. */
  if (damageHoldError) {
    try {
      await sendDamageHoldFailedAlert(bookingRow, damageHoldError);
      console.log('[stripe-webhook] damage-hold failure alert sent for', session.id);
    } catch (alertErr) {
      console.error('[stripe-webhook] damage-hold alert send FAILED (booking still saved):',
        session.id, '|', alertErr.message);
    }
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

  console.log('[stripe-webhook] dispatching confirmation emails', session.id);
  let customerEmailOk = false;
  try {
    const result = await sendConfirmationEmails(emailData);
    customerEmailOk = !result.customerError;
    console.log('[stripe-webhook] email dispatch complete', session.id,
      '| customer:', result.customerError ? 'FAILED (' + result.customerError.message + ')' : 'ok',
      '| business:', result.businessError ? 'FAILED (' + result.businessError.message + ')' : 'ok');
  } catch (err) {
    /* sendConfirmationEmails throws only if BOTH customer and business
       sends failed. Stripe has already charged — return 200 anyway so it
       doesn't enter the retry loop, but the error is loud in logs. */
    console.error('[stripe-webhook] BOTH confirmation emails failed', session.id, '|', err.message, '\n', err.stack);
  }

  /* Track delivery success so the confirmation page and admin can detect
     failures and offer a resend. PATCH failure isn't fatal — the next
     resend attempt will set it correctly. */
  try {
    await patchBooking(session.id, { confirmation_email_sent: customerEmailOk });
    console.log('[stripe-webhook] confirmation_email_sent =', customerEmailOk, 'for', session.id);
  } catch (err) {
    console.error('[stripe-webhook] failed to update confirmation_email_sent for', session.id, ':', err.message);
  }

  return res.status(200).json({ received: true });
};
