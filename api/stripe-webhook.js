const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const {
  sendConfirmationEmails,
  sendDamageHoldFailedAlert,
  sendDamageHoldFailedCustomerNotice,
  sendStripeRefundReconciledAlert,
  sendChargebackAlert,
  sendHighValueLeadAlert,
  sendBalancePaidEmail,
  sendAdminActionEmailFailureAlert,
} = require('../lib/send-emails');
const {
  saveBooking,
  patchBooking,
  findBookingBySessionId,
  findBookingByPaymentIntent,
  findActiveLeadByEmail,
  findLeadByStripeSession,
  findLeadByPaymentIntent,
  patchLead,
} = require('../lib/storage');
const { logBookingEvent } = require('../lib/booking-events');

const LEAD_HIGH_VALUE_THRESHOLD = 500;

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

/* ── Portal-initiated balance payment ─────────────────────────────────
   Fires when a customer pays their remaining balance via the customer
   portal's Pay Balance Now button (Phase 4 Commit 8). The portal flow
   creates a Stripe Checkout Session with metadata.payment_type='balance'
   and metadata.booking_session_id set; this handler matches on those.

   IMPORTANT — dispatch order (see the dispatcher below):

     1. metadata.payment_type === 'balance'    → THIS handler (portal)
     2. metadata.original_session_id           → existing admin Payment Link branch
     3. fallthrough                            → new-booking wizard flow

   Order matters. Both balance flows mutate booking state but use
   different idempotency keys and notification patterns: this handler
   gates on `paid_in_full` (strongest signal) and does NOT send a TFC
   email (Stripe's auto-receipt covers confirmation). The admin Payment
   Link branch gates on `confirmation_email_sent` and sends the full
   "Booking Confirmed" email. Reordering would route balance payments
   through the wrong handler.

   Idempotency: a Stripe webhook retry (or a second event for the same
   session) hits the `paid_in_full === true` check at the top and
   returns 200 without re-mutating. Audit-log row in booking_events is
   written best-effort AFTER the state mutation. */
async function handleBalancePayment(event, res) {
  const session = event.data.object;
  const meta = session.metadata || {};
  const sessionId = meta.booking_session_id;

  console.log('[stripe-webhook] balance payment',
    'stripe_session:', session.id,
    '| booking_session:', sessionId,
    '| amount_total:', session.amount_total,
    '| payment_intent:', session.payment_intent);

  if (!sessionId) {
    console.error('[stripe-webhook] balance payment with no booking_session_id in metadata — cannot reconcile',
      'stripe_session:', session.id);
    return res.status(200).json({ received: true, ignored: 'no_booking_session_id' });
  }

  /* Stripe only fires checkout.session.completed for sessions where
     payment_status === 'paid', but be defensive. */
  if (session.payment_status !== 'paid') {
    console.log('[stripe-webhook] balance session not paid yet, acknowledging without processing',
      session.id, '| status:', session.payment_status);
    return res.status(200).json({ received: true, payment_status: session.payment_status });
  }

  let booking;
  try {
    booking = await findBookingBySessionId(sessionId);
  } catch (err) {
    console.error('[stripe-webhook] balance payment booking lookup failed:',
      sessionId, '|', err.message);
    return res.status(500).json({ error: 'lookup_failed' });
  }

  if (!booking) {
    console.warn('[stripe-webhook] balance payment for unknown booking:', sessionId,
      '| stripe_session:', session.id);
    /* 200 because there's no point retrying a webhook for a booking that
       doesn't exist. Logged loud so admin can investigate. */
    return res.status(200).json({ received: true, ignored: 'booking_not_found' });
  }

  /* Application-level idempotency gate. If a webhook retry arrives after
     the first event already flipped paid_in_full, skip the patch + the
     event-log write. Returns 200 so Stripe stops retrying. */
  if (booking.paid_in_full === true) {
    console.log('[stripe-webhook] balance payment idempotent — booking already paid in full',
      sessionId, '| stripe_session:', session.id);
    return res.status(200).json({
      received: true,
      applied_to: sessionId,
      idempotent: 'already_paid_in_full',
    });
  }

  /* State mutation FIRST, audit-log write SECOND. A logging failure
     after a successful patch leaves the customer correctly marked paid
     in full with a missing audit row — annoying but recoverable. The
     reverse (audit row exists, but the patch silently failed) would
     leave a customer who paid still showing a balance — much worse. */

  /* IMPORTANT — admin.html bkPaymentStatus() reads amount_total (not
     paid_in_full) as its primary signal for the PAID IN FULL / UNPAID
     pill. If we patch paid_in_full=true but leave amount_total at its
     pre-payment value (often 0 for admin-created bookings), the admin
     UI will show UNPAID despite the booking being fully paid. This was
     the test3 bug surfaced post-Commit 8: portal correctly showed
     paid-in-full while admin showed UNPAID because of this missing
     write. The accumulation pattern (existing + new) is correct for
     hybrid wizard-deposit + portal-balance flows as well as admin-
     created flows. */
  const updates = {
    paid_in_full:              true,
    remaining_balance:         0,
    amount_total:              (Number(booking.amount_total) || 0) + session.amount_total,
    balance_payment_intent_id: session.payment_intent || null,
  };

  /* Backfill Stripe IDs when the booking was admin-created (no Stripe
     touchpoint at booking creation, so these are null). Conditional so
     we don't overwrite values written by the wizard-flow webhook. Mirrors
     the existing admin Payment Link branch pattern at lines ~415-424 of
     this file. payment_method_id is omitted — deriving it from a Checkout
     Session response requires a follow-up Stripe API call; not worth the
     round-trip for this fix. */
  if (!booking.payment_intent_id)  updates.payment_intent_id  = session.payment_intent || null;
  if (!booking.stripe_customer_id) updates.stripe_customer_id = session.customer || null;

  try {
    await patchBooking(sessionId, updates);
    console.log('[stripe-webhook] balance payment applied',
      sessionId, '| amount_total:', session.amount_total);
  } catch (err) {
    console.error('[stripe-webhook] balance patch failed:',
      sessionId, '|', err.message);
    /* Return 5xx so Stripe retries — the customer's money has moved and
       the booking row MUST eventually flip to paid_in_full. */
    return res.status(500).json({ error: 'patch_failed', detail: err.message });
  }

  /* Best-effort audit log. logBookingEvent catches its own errors so a
     write failure here does not bubble up to a non-2xx Stripe response. */
  await logBookingEvent(sessionId, 'balance_paid', {
    amount_cents:      session.amount_total,
    stripe_session_id: session.id,
    payment_intent_id: session.payment_intent || null,
    source:            'portal',
  }, 'webhook');

  /* Best-effort TFC-branded balance-paid email. Customer's money is
     already in our account at this point — a Resend failure must NOT
     escalate to a non-200 webhook response or Stripe will retry the
     event (which would re-fire this email and re-write the audit row).
     Stripe's auto-receipt continues to fire regardless; this email is
     the brand-consistent follow-up that restates the charter and
     provides the portal back-link.

     Pass the post-patch booking state (existing row + updates merged
     locally) so the email reflects paid_in_full=true, remaining_balance=0,
     accumulated amount_total — saves a Supabase round-trip vs re-fetching. */
  const bookingAfterPatch = Object.assign({}, booking, updates);
  try {
    await sendBalancePaidEmail(bookingAfterPatch);
  } catch (emailErr) {
    console.error('[stripe-webhook] balance-paid email failed (payment still applied):',
      sessionId, '|', emailErr.message);
    /* G15 defensive alert — surface the failure to the business inbox so
       admin has a paper trail when a customer-facing send fails. Wrapped
       in its own try/catch so a defensive-alert failure can't escalate. */
    try {
      await sendAdminActionEmailFailureAlert(
        'balance-paid-email',
        bookingAfterPatch,
        bookingAfterPatch.customer_email,
        emailErr.message
      );
    } catch (alertErr) {
      console.error('[stripe-webhook] balance-paid defensive alert ALSO failed (payment still applied):',
        sessionId, '|', alertErr.message);
    }
  }

  return res.status(200).json({
    received:   true,
    applied_to: sessionId,
    amount_paid_cents: session.amount_total,
  });
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
    /* If a lead exists for this checkout session, flip it to
       'abandoned_stripe' and fire a high-value alert above threshold.
       Best-effort — never let a lead lookup failure block the 200 response. */
    try {
      const lead = await findLeadByStripeSession(s.id);
      if (lead && lead.status !== 'converted' && lead.status !== 'abandoned_stripe') {
        const updated = await patchLead(lead.id, { status: 'abandoned_stripe' });
        console.log('[stripe-webhook] lead', lead.id, 'marked abandoned_stripe');
        if (updated && parseFloat(updated.grand_total || 0) >= LEAD_HIGH_VALUE_THRESHOLD) {
          try { await sendHighValueLeadAlert(updated, 'abandoned_stripe'); }
          catch (alertErr) { console.error('[stripe-webhook] high-value lead alert (abandoned) failed:', alertErr.message); }
        }
      }
    } catch (err) {
      console.error('[stripe-webhook] lead lifecycle (expired) lookup/patch failed:', err.message);
    }
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
    /* If a lead exists for this payment intent (or this email), flip it
       to 'payment_failed' and fire a high-value alert above threshold.
       Try intent first (more specific), fall back to email. */
    try {
      let lead = await findLeadByPaymentIntent(pi.id);
      if (!lead && email && email !== 'unknown') {
        lead = await findActiveLeadByEmail(email);
      }
      if (lead && lead.status !== 'converted' && lead.status !== 'payment_failed') {
        const updates = { status: 'payment_failed' };
        if (!lead.payment_intent_id && pi.id) updates.payment_intent_id = pi.id;
        const updated = await patchLead(lead.id, updates);
        console.log('[stripe-webhook] lead', lead.id, 'marked payment_failed');
        if (updated && parseFloat(updated.grand_total || 0) >= LEAD_HIGH_VALUE_THRESHOLD) {
          try { await sendHighValueLeadAlert(updated, 'payment_failed'); }
          catch (alertErr) { console.error('[stripe-webhook] high-value lead alert (payment_failed) failed:', alertErr.message); }
        }
      }
    } catch (err) {
      console.error('[stripe-webhook] lead lifecycle (payment_failed) lookup/patch failed:', err.message);
    }
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

  /* ── checkout.session.completed dispatch order ────────────────────────
     The three branches below mutate booking state in DIFFERENT ways and
     have DIFFERENT idempotency keys. Order matters:

       1. meta.payment_type === 'balance'    → handleBalancePayment (portal)
       2. meta.original_session_id            → admin Payment Link branch
       3. fallthrough                         → new-booking wizard flow

     The portal-initiated balance flow is MORE SPECIFIC than the admin
     Payment Link flow (which only checks original_session_id). Checking
     payment_type first ensures portal-balance events route to the right
     handler with the right idempotency check (paid_in_full vs the admin
     branch's confirmation_email_sent). Do not reorder without updating
     handleBalancePayment's dispatch-order comment too. */

  if (meta.payment_type === 'balance') {
    return await handleBalancePayment(event, res);
  }

  /* ── Remaining-balance branch (admin Payment Link) ─────────────────────
     When a customer pays via the admin "Send Payment Link" action, the link
     carries meta.original_session_id pointing at the existing admin-created
     booking row. We patch THAT row to paid_in_full instead of inserting a
     new orphan row. Damage hold + lead conversion are skipped because both
     were already handled at the original deposit. The confirmation email
     still fires so the customer knows their balance landed. */
  if (meta.original_session_id) {
    /* Read the existing row BEFORE patching so we can preserve any
       non-null payment data from a prior write (the deposit's PI,
       customer, payment method, amount_total) instead of overwriting
       it with the balance-payment's values. State flags below
       (paid_in_full / remaining_balance / payment_type) still flip
       unconditionally. Interim safety until G7 (Phase 2) adds a
       dedicated balance_payment_intent_id column to track multi-PI
       bookings properly. A lookup failure falls through to the
       legacy insert-new-row path (same as "row not found" below). */
    let existing = null;
    try {
      existing = await findBookingBySessionId(meta.original_session_id);
    } catch (err) {
      console.error('[stripe-webhook] existing-row lookup failed for remaining-balance',
        meta.original_session_id, '|', err.message);
      existing = null;
    }

    if (existing) {
      /* G10 idempotency — if a prior webhook delivery already sent the
         confirmation email for this booking, this is a Stripe retry of
         the same event. Skip everything + return 200 to break the retry
         loop. Local to this branch because it has an explicit 500
         return at the patch step below; the legacy checkout.session
         .completed branch has the same theoretical exposure but at much
         lower frequency (only saveBookingWithRetry permanent failure
         triggers a 5xx there) — flagged out-of-scope for a follow-up.
         The narrow residual race (first delivery succeeded at email but
         failed to patch the flag) is accepted; a future retry would
         also be skipped once the flag lands. */
      if (existing.confirmation_email_sent === true) {
        console.log('[stripe-webhook] remaining-balance webhook retry: email already sent for',
          meta.original_session_id, '— skipping');
        return res.status(200).json({
          received: true,
          applied_to: meta.original_session_id,
          idempotent: 'email_already_sent',
        });
      }

      /* Retrieve payment method from the new payment intent so the patched
         row carries it forward — needed for future refunds and Charge Card
         actions against this booking. Mirrors the legacy path below at
         line ~436; best-effort: a Stripe lookup failure must NOT abort the
         patch because the money has already moved. Falls back to null. */
      let paymentMethodId = null;
      if (paymentIntentId) {
        try {
          const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
          paymentMethodId = paymentIntent.payment_method || null;
        } catch (err) {
          console.error('[stripe-webhook] PI retrieve failed for remaining-balance',
            meta.original_session_id, '|', err.message);
        }
      }

      /* Conditional overwrites — write the new transaction data ONLY
         when the existing column is empty. Empty = 0 for amount_total,
         null/undefined for the three ID fields. This preserves deposit-
         flow data (where the deposit's webhook already populated these
         columns) while still healing the empty-row state caused by the
         original f10c429 bug. */
      const patchObj = {
        paid_in_full:      true,
        remaining_balance: 0,
        payment_type:      'full',
      };
      if (!existing.amount_total)       patchObj.amount_total       = session.amount_total;
      if (!existing.payment_intent_id)  patchObj.payment_intent_id  = paymentIntentId;
      if (!existing.stripe_customer_id) patchObj.stripe_customer_id = stripeCustomerId;
      if (!existing.payment_method_id)  patchObj.payment_method_id  = paymentMethodId;

      let updated;
      try {
        updated = await patchBooking(meta.original_session_id, patchObj);
      } catch (err) {
        /* Transient Supabase error — return 5xx so Stripe retries the webhook
           per its standard schedule. Do NOT fall through (would create an
           orphan row that complicates a future retry). */
        console.error('[stripe-webhook] patch original booking',
          meta.original_session_id, 'FAILED:', err.message);
        return res.status(500).json({ error: 'patch_failed', detail: err.message });
      }

      if (updated) {
        console.log('[stripe-webhook] remaining balance applied to original booking',
          meta.original_session_id,
          '| amount_paid_cents:', session.amount_total,
          '| new_payment_intent:', paymentIntentId,
          '| stripe_session:', session.id,
          '| fields_written:', Object.keys(patchObj).join(','));

        /* Build the confirmation email from the (now-patched) original row
           so the customer who originally booked is the one notified, not
           whoever happened to type an email at Stripe's hosted page.
           payment_type: 'full' makes the email render "Paid in Full". */
        const emailData = {
          customer_email:   updated.customer_email,
          amount_total:     session.amount_total,
          session_id:       meta.original_session_id,
          charter_name:     updated.charter_name,
          vessel:           updated.vessel,
          experience:       updated.experience,
          date:             updated.date,
          time_slot:        updated.time_slot,
          duration:         updated.duration,
          full_name:        updated.full_name,
          party_size:       updated.party_size,
          phone:            updated.phone,
          payment_type:     'full',
          grand_total:      updated.grand_total,
          deposit_amount:   updated.deposit_amount,
          add_ons:          updated.add_ons,
          special_requests: updated.special_requests,
          promo_applied:    updated.promo_applied,
          newsletter:       updated.newsletter,
        };

        let customerEmailOk = false;
        try {
          const result = await sendConfirmationEmails(emailData);
          customerEmailOk = !result.customerError;
          console.log('[stripe-webhook] remaining-balance email dispatch',
            meta.original_session_id,
            '| customer:', result.customerError ? 'FAILED (' + result.customerError.message + ')' : 'ok',
            '| business:', result.businessError ? 'FAILED (' + result.businessError.message + ')' : 'ok');
        } catch (err) {
          console.error('[stripe-webhook] both emails failed for remaining-balance',
            meta.original_session_id, '|', err.message);
        }

        try {
          await patchBooking(meta.original_session_id, { confirmation_email_sent: customerEmailOk });
        } catch (err) {
          console.error('[stripe-webhook] failed to set confirmation_email_sent for',
            meta.original_session_id, '|', err.message);
        }

        return res.status(200).json({ received: true, applied_to: meta.original_session_id });
      }
    }

    /* Original row not found (deleted, stale link with bad id, OR the
       existing-row pre-patch lookup failed). Don't
       return — fall through to the legacy insert-new-row flow so we still
       persist SOMETHING and the customer still gets a confirmation email.
       The defensive alert email will fire if metadata is genuinely missing
       elsewhere in the flow. */
    console.warn('[stripe-webhook] original_session_id', meta.original_session_id,
      'not found in bookings — falling back to insert-new-row path');
  }

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
      /* G20 idempotency — pass an idempotencyKey scoped to the booking
         session so a Stripe webhook retry (triggered by saveBookingWithRetry
         permanent failure below at line ~611) returns the SAME PaymentIntent
         from the first attempt instead of authorizing a second $250 hold
         on the customer's card. Stripe dedupes against the key for 24h,
         which covers the realistic retry window. session.id is unique per
         wizard checkout and "one hold per session" is the correct semantic.
         Ref: docs/queue/g20-damage-hold-idempotency.md */
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
      }, { idempotencyKey: 'damage_hold_' + session.id });
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

  /* Damage-hold alerts — fire AFTER the standard confirmation emails so
     the routine "New Booking" notification reaches the owner's inbox
     before the urgent "⚠️ Damage hold FAILED" alert. This ordering keeps
     Gmail from threading/filtering the two business emails together and
     also surfaces the right context first (booking exists, then hold
     needs attention). Each send is independent and best-effort — a
     failure here must not unwind the booking. */
  if (damageHoldError) {
    try {
      await sendDamageHoldFailedAlert(bookingRow, damageHoldError);
      console.log('[stripe-webhook] damage-hold owner alert sent for', session.id);
    } catch (alertErr) {
      console.error('[stripe-webhook] damage-hold owner alert FAILED (booking still saved):',
        session.id, '|', alertErr.message);
    }
    try {
      await sendDamageHoldFailedCustomerNotice(emailData);
      console.log('[stripe-webhook] damage-hold customer notice sent for', session.id);
    } catch (noticeErr) {
      console.error('[stripe-webhook] damage-hold customer notice FAILED (booking still saved):',
        session.id, '|', noticeErr.message);
    }
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

  /* Lead conversion — if this customer previously consented to exit-intent
     follow-up, flip their lead row from 'captured'/'abandoned_stripe'/
     'payment_failed' to 'converted' and stamp the booking session id +
     converted_at. Match by email first (works for leads captured pre-Stripe),
     fall back to stripe_session_id (works for leads captured at cancel-return).
     Best-effort — never let a lead-update failure block the 200 response. */
  try {
    let lead = session.customer_email ? await findActiveLeadByEmail(session.customer_email) : null;
    if (!lead) lead = await findLeadByStripeSession(session.id);
    if (lead && lead.status !== 'converted') {
      await patchLead(lead.id, {
        status:                       'converted',
        converted_booking_session_id: session.id,
        converted_at:                 new Date().toISOString(),
      });
      console.log('[stripe-webhook] lead', lead.id, 'marked converted for booking', session.id);
    }
  } catch (err) {
    console.error('[stripe-webhook] lead conversion lookup/patch failed for', session.id, ':', err.message);
  }

  return res.status(200).json({ received: true });
};
