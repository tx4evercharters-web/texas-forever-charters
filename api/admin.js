const crypto = require('crypto');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const { requireAuth, generateToken } = require('../lib/auth');
const {
  getBookings,
  markBookingPaid,
  getBlackouts,
  addBlackout,
  removeBlackout,
  removeBlackoutById,
  findBookingConflictsForBlackout,
  searchCustomers,
  addManualBooking,
  updateBookingPayment,
  listCustomers,
  updateCustomer,
  createCustomer,
  deleteCustomer,
  importHistoricalBookings,
  patchBooking,
  findBookingBySessionId,
  deleteBookingRow,
  listWaivers,
  getAllWaivers,
  listAllWaiversEnriched,
  listLeads,
  patchLead,
  findBookingsForLead,
  findBookingDatesBySessionIds,
} = require('../lib/storage');
const { postToResend, sendConfirmationEmails, sendCancellationEmail, sendRefundEmail, sendDamageChargeEmail, sendWaiverLinkEmail, sendAdminActionEmailFailureAlert, sendBlackoutConflictAlert, formatMoneyDollars } = require('../lib/send-emails');

/* The previous inline supabasePatch helper has been removed — booking edits
   now route through lib/storage.js patchBooking so they use the same
   env-aware request() helper as the rest of the app. The old local copy
   read process.env.SUPABASE_SECRET_KEY directly with no preflight, producing
   the cryptic "Invalid value 'undefined' for header 'apikey'" Node error
   whenever the env var was missing on a function instance. */

/* ── Action handlers ── */

async function handleLogin(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { password } = req.body || {};
  const adminPassword = (process.env.ADMIN_PASSWORD || '').trim();

  if (!adminPassword) return res.status(500).json({ error: 'ADMIN_PASSWORD not configured' });
  if (!password) return res.status(400).json({ error: 'Password required' });

  const bufA = Buffer.from(String(password).trim());
  const bufB = Buffer.from(adminPassword);
  const match = bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);

  if (!match) return res.status(401).json({ error: 'Invalid password' });

  return res.status(200).json({ token: generateToken(adminPassword) });
}

async function handleBookings(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  const [bookings, waivers] = await Promise.all([getBookings(), getAllWaivers()]);

  // Group waivers by session_id (and by booking_id as fallback) so the admin
  // table can render per-booking waiver counts without a second round trip.
  const waiversBySession = {};
  const waiversByBookingId = {};
  for (const w of waivers || []) {
    if (w.session_id) (waiversBySession[w.session_id] || (waiversBySession[w.session_id] = [])).push(w);
    if (w.booking_id) (waiversByBookingId[w.booking_id] || (waiversByBookingId[w.booking_id] = [])).push(w);
  }
  const enrich = (b) => {
    const list = waiversBySession[b.session_id] || waiversByBookingId[b.id] || [];
    return { ...b, waivers: list, waiver_count: list.length };
  };

  const today = new Date().toISOString().split('T')[0];
  const upcoming = bookings
    .filter(b => (b.date || '') >= today)
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''))
    .map(enrich);
  const past = bookings
    .filter(b => (b.date || '') < today)
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
    .map(enrich);

  return res.status(200).json({ upcoming, past, all: bookings.map(enrich) });
}

async function handleListBlackouts(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  return res.status(200).json(await getBlackouts());
}

/* G16 toast-friendly one-liner summary of conflict matches. Truncates to
   3 names with a "+N more" suffix; the email has the full list. */
function buildConflictSummaryString(conflicts) {
  const n = conflicts.length;
  const head = conflicts.slice(0, 3).map(c => (c.full_name || 'unknown') + ' (' + (c.time_slot || '?') + ')');
  const more = n > 3 ? ', +' + (n - 3) + ' more' : '';
  return n + ' booking' + (n === 1 ? '' : 's') + ' affected: ' + head.join(', ') + more;
}

async function handleAddBlackout(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { date, vessel, time_slot } = req.body || {};
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date required in YYYY-MM-DD format' });
  }
  const v = vessel || 'both';
  if (!['yacht', 'pontoon', 'both'].includes(v)) {
    return res.status(400).json({ error: 'vessel must be yacht, pontoon, or both' });
  }
  const ts = time_slot || 'all';

  try {
    /* G16 conflict pre-scan. Failure here is non-fatal: the admin's
       intent (block this date) is primary, so we surface a
       conflict_query_warning in the response and proceed with the
       insert. The frontend renders that warning as its own toast. */
    let conflicts = [];
    let conflict_query_warning = null;
    try {
      conflicts = await findBookingConflictsForBlackout({ date, vessel: v, time_slot: ts });
    } catch (qErr) {
      console.error('[add-blackout] conflict query failed, proceeding without scan:', qErr.message);
      conflict_query_warning = qErr.message;
    }

    const blackouts = await addBlackout({ date, vessel: v, time_slot: ts });

    /* Defensive alert to the business inbox so a missed UI toast does
       not leave conflicts undetected. Send failure folds into
       email_warning, mirroring the G15 admin-action pattern. */
    let email_warning = null;
    if (conflicts.length > 0) {
      try {
        await sendBlackoutConflictAlert({ blackout: { date, vessel: v, time_slot: ts }, conflicts });
      } catch (eErr) {
        console.error('[add-blackout] conflict alert email failed:', eErr.message);
        email_warning = eErr.message;
      }
    }

    return res.status(200).json({
      blackouts,
      conflicts: conflicts.length,
      conflict_summary: conflicts.length > 0 ? buildConflictSummaryString(conflicts) : null,
      ...(email_warning          ? { email_warning }          : {}),
      ...(conflict_query_warning ? { conflict_query_warning } : {}),
    });
  } catch (err) {
    console.error('Add blackout error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

async function handleRemoveBlackout(req, res) {
  if (req.method !== 'DELETE') return res.status(405).end();
  // Prefer id (lets us remove a single per-vessel/per-slot row); fall back to
  // date-only for legacy callers (removes every blackout on that date).
  const id   = req.query.id;
  const date = req.query.date;
  try {
    if (id)        return res.status(200).json(await removeBlackoutById(id));
    if (date)      return res.status(200).json(await removeBlackout(date));
    return res.status(400).json({ error: 'id or date required' });
  } catch (err) {
    console.error('Remove blackout error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

async function handleMarkPaid(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { session_id } = req.body || {};
  if (!session_id) return res.status(400).json({ error: 'session_id required' });

  const booking = await markBookingPaid(session_id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  return res.status(200).json({ ok: true, booking });
}

async function handleUpdateBooking(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  // Env preflight — same shape as handleImportBookings. If this function
  // instance is missing Supabase config, fail fast with a structured 500
  // that surfaces exactly which var is missing instead of a cryptic
  // "Invalid value 'undefined' for header 'apikey'" from inside Node's
  // https.request internals.
  const envSummary = {
    has_supabase_url:        !!process.env.SUPABASE_URL,
    has_supabase_secret_key: !!process.env.SUPABASE_SECRET_KEY,
    supabase_url_host:       process.env.SUPABASE_URL ? (() => { try { return new URL(process.env.SUPABASE_URL).host; } catch { return 'INVALID'; } })() : null,
    vercel_env:              process.env.VERCEL_ENV || null,
  };
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) {
    console.error('[update-booking] Supabase env vars missing on this function:', envSummary);
    return res.status(500).json({
      error: 'Supabase env vars missing on this function — check Vercel project settings.',
      env: envSummary,
    });
  }

  const { session_id, updates } = req.body || {};
  if (!session_id || !updates) return res.status(400).json({ error: 'Missing session_id or updates' });

  const allowedFields = [
    // Charter details
    'date', 'time_slot', 'duration', 'party_size', 'vessel', 'experience',
    'charter_name', 'special_requests', 'add_ons',
    // Source / admin metadata
    'source', 'source_notes', 'internal_notes',
    // Customer fields
    'full_name', 'customer_email', 'phone', 'city', 'state',
    // Pricing
    'grand_total', 'charter_subtotal', 'admin_fee', 'tax_amount',
    'processing_fee', 'promo_discount', 'add_on_total', 'deposit_amount',
    // Payment
    'amount_total', 'paid_in_full', 'remaining_balance',
    'payment_type', 'payment_method_external',
    // Lifecycle
    'status', 'cancelled_at', 'refund_amount', 'refunded_at',
    // Damage hold
    'damage_hold_status', 'damage_charge_amount',
  ];
  const sanitized = {};
  for (const key of allowedFields) {
    if (updates[key] !== undefined) sanitized[key] = updates[key];
  }
  if (sanitized.duration   !== undefined) sanitized.duration   = parseInt(sanitized.duration);
  if (sanitized.party_size !== undefined) sanitized.party_size = parseInt(sanitized.party_size);
  if (sanitized.add_ons && typeof sanitized.add_ons === 'object') {
    sanitized.add_ons = JSON.stringify(sanitized.add_ons);
  }

  try {
    // Route through lib/storage.js patchBooking so this handler shares the
    // env-aware request() helper used everywhere else.
    const updated = await patchBooking(session_id, sanitized);
    if (!updated) return res.status(404).json({ error: 'Booking not found' });
    return res.status(200).json({ ok: true, booking: updated });
  } catch (err) {
    console.error('[update-booking] failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

async function handleChargeRemaining(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { session_id } = req.body || {};
  if (!session_id) return res.status(400).json({ error: 'Missing session_id' });

  const bookings = await getBookings();
  const booking = bookings.find(b => b.session_id === session_id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (booking.paid_in_full) return res.status(400).json({ error: 'Booking already paid in full' });

  const remaining = parseFloat(booking.remaining_balance || 0);
  if (remaining <= 0) return res.status(400).json({ error: 'No remaining balance' });

  if (!booking.payment_method_id || !booking.stripe_customer_id) {
    return res.status(400).json({ error: 'No saved payment method for this customer' });
  }

  try {
    /* G21 idempotency — defense-in-depth against rapid admin double-clicks
       that would otherwise both reach paymentIntents.create before the
       first call's markBookingPaid lands (the existing paid_in_full
       precondition at line 215 is the primary guard, this is the
       narrow-window backup). Key = session_id + cents amount; the cents
       suffix lets a legitimate retry after an admin edits the remaining
       balance succeed with a fresh key, while identical amounts within
       Stripe's 24h dedupe window resolve to the same PI.
       Ref: docs/queue/g21-admin-paymentintent-idempotency.md */
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(remaining * 100),
      currency: 'usd',
      customer: booking.stripe_customer_id,
      payment_method: booking.payment_method_id,
      off_session: true,
      confirm: true,
      description: `Remaining balance — ${booking.charter_name || booking.experience} on ${booking.date}`,
      receipt_email: booking.customer_email || undefined,
    }, { idempotencyKey: 'admin_charge_' + session_id + '_' + Math.round(remaining * 100) });

    if (paymentIntent.status === 'succeeded') {
      await markBookingPaid(session_id);

      /* G3 fix — send the customer-facing confirmation email after a
         successful off-session charge. Previously the card was charged
         and the booking was marked paid_in_full but the customer
         received NOTHING from us, eroding trust. The card has already
         moved + DB has already been patched at this point, so an email
         failure must NOT undo either: wrap in try/catch, capture as
         email_warning in the 200 response. cron-reminders pass 2
         picks up rows with confirmation_email_sent: false and retries
         up to 5×. Uses paymentIntent.amount (the cents we just
         charged) for amount_total to mirror the webhook's
         original_session_id branch. payment_type: 'full' matches
         markBookingPaid's write. */
      const emailData = {
        customer_email:   booking.customer_email,
        amount_total:     paymentIntent.amount,
        session_id:       booking.session_id,
        charter_name:     booking.charter_name,
        vessel:           booking.vessel,
        experience:       booking.experience,
        date:             booking.date,
        time_slot:        booking.time_slot,
        duration:         booking.duration,
        full_name:        booking.full_name,
        party_size:       booking.party_size,
        phone:            booking.phone,
        payment_type:     'full',
        grand_total:      booking.grand_total,
        deposit_amount:   booking.deposit_amount,
        add_ons:          booking.add_ons,
        special_requests: booking.special_requests,
        promo_applied:    booking.promo_applied,
        newsletter:       booking.newsletter,
      };

      let customerEmailOk = false;
      let email_warning = null;
      try {
        const result = await sendConfirmationEmails(emailData);
        customerEmailOk = !result.customerError;
        if (result.customerError) email_warning = result.customerError.message;
      } catch (err) {
        console.error('[charge-remaining] confirmation email failed (charge succeeded):',
          session_id, '|', err.message);
        email_warning = err.message;
      }

      try {
        await patchBooking(session_id, { confirmation_email_sent: customerEmailOk });
      } catch (err) {
        console.error('[charge-remaining] failed to set confirmation_email_sent for',
          session_id, '|', err.message);
      }

      /* G15 defensive alert — if the customer email failed, fire a business
         alert so the admin sees a paper-trail email even if they miss the
         UI warning toast. Best-effort: a failure here must NOT throw, must
         NOT remove email_warning from the response, must NOT change status. */
      if (email_warning) {
        try {
          await sendAdminActionEmailFailureAlert('charge-remaining', booking, booking.customer_email, email_warning);
        } catch (alertErr) {
          console.error('[charge-remaining] defensive alert send FAILED (response still 200):',
            session_id, '|', alertErr.message);
        }
      }

      return res.status(200).json({
        ok: true,
        message: 'Payment successful',
        ...(email_warning ? { email_warning } : {}),
      });
    }
    return res.status(400).json({ error: 'Payment did not succeed', status: paymentIntent.status });
  } catch (err) {
    console.error('Charge error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

async function handleSendPaymentLink(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { session_id } = req.body || {};
  if (!session_id) return res.status(400).json({ error: 'Missing session_id' });

  const bookings = await getBookings();
  const booking = bookings.find(b => b.session_id === session_id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (booking.paid_in_full) return res.status(400).json({ error: 'Booking already paid in full' });

  const remaining = parseFloat(booking.remaining_balance || 0);
  if (remaining <= 0) return res.status(400).json({ error: 'No remaining balance' });

  // Stripe rejects non-string metadata values; coerce + truncate to 500
  // chars (490 for free-text special_requests). Mirrors api/create-checkout.js
  // truncate() so the webhook sees identically-shaped values.
  const s = (v, max = 500) => (v == null ? '' : String(v).slice(0, max));

  /* G23 / G8-closing restructure — separate the Stripe-create failure
     path from the email-send failure path so the email-only failure
     doesn't bury the side effect that the Stripe payment link DOES
     exist. Stripe-create failure → 500 (no link, retry-safe). Email-send
     failure → 200 with email_warning so G15's UI toast + defensive alert
     plumbing both fire while the response carries the link URL admin can
     copy / resend. */
  let paymentLink;
  try {
    paymentLink = await stripe.paymentLinks.create({
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `Remaining Balance — ${booking.charter_name || booking.experience}`,
            description: `${booking.date} at ${booking.time_slot} · ${booking.vessel === 'yacht' ? '40ft Carver Aft Cabin' : '24ft Bentley Navigator 243'}`,
          },
          unit_amount: Math.round(remaining * 100),
        },
        quantity: 1,
      }],
      after_completion: {
        type: 'redirect',
        redirect: { url: 'https://www.texasforevercharters.com/booking-confirmation.html?session_id={CHECKOUT_SESSION_ID}' },
      },
      // Top-level metadata is copied by Stripe onto every checkout session
      // that this payment link generates. The webhook reads session.metadata
      // to build the booking row and dispatch the confirmation email —
      // without these keys it has nothing to work with.
      // original_session_id back-links to the admin-created booking row so
      // the webhook can patch THAT row to paid_in_full instead of inserting
      // a new orphan row.
      metadata: {
        charter_name:        s(booking.charter_name),
        vessel:              s(booking.vessel),
        experience:          s(booking.experience),
        date:                s(booking.date),
        time_slot:           s(booking.time_slot),
        duration:            s(booking.duration),
        full_name:           s(booking.full_name),
        party_size:          s(booking.party_size),
        phone:               s(booking.phone),
        payment_type:        'remaining_balance',
        grand_total:         s(booking.grand_total),
        deposit_amount:      s(booking.deposit_amount),
        add_ons:             s(typeof booking.add_ons === 'string'
                                ? booking.add_ons
                                : JSON.stringify(booking.add_ons || {})),
        special_requests:    s(booking.special_requests, 490),
        promo_applied:       s(booking.promo_applied),
        newsletter:          s(booking.newsletter),
        terms_agreed:        s(booking.terms_agreed),
        terms_agreed_at:     s(booking.terms_agreed_at),
        admin_fee:           s(booking.admin_fee),
        tax_amount:          s(booking.tax_amount),
        processing_fee:      s(booking.processing_fee),
        charter_subtotal:    s(booking.charter_subtotal),
        promo_discount:      s(booking.promo_discount),
        customer_email:      s(booking.customer_email),
        original_session_id: s(booking.session_id),
      },
    });
  } catch (err) {
    console.error('Payment link create error:', err.message);
    return res.status(500).json({ error: err.message });
  }

  /* At this point the Stripe link exists. From here, any failure must
     keep the link URL in the response so admin can still recover. */
  let email_warning = null;
  try {
    await postToResend({
      from: 'Texas Forever Charters <bookings@texasforevercharters.com>',
      to: booking.customer_email,
      subject: 'Your Remaining Balance — Texas Forever Charters',
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
          <div style="background:#1B2A6B;padding:24px;text-align:center;">
            <h1 style="color:#fff;margin:0;font-size:22px;letter-spacing:3px;">TEXAS FOREVER CHARTERS</h1>
          </div>
          <div style="padding:32px 24px;">
            <p>Hi ${booking.full_name || 'there'},</p>
            <p>Your charter is coming up on <strong>${booking.date}</strong> and you have a remaining balance of <strong>${formatMoneyDollars(remaining)}</strong>.</p>
            <p>Click below to pay securely:</p>
            <div style="text-align:center;margin:32px 0;">
              <a href="${paymentLink.url}" style="background:#C8102E;color:#fff;padding:14px 32px;border-radius:6px;text-decoration:none;font-weight:700;font-size:16px;">Pay ${formatMoneyDollars(remaining)}</a>
            </div>
            <p style="font-size:13px;color:#666;">Questions? Call or text us at (737) 368-1669</p>
          </div>
        </div>
      `,
    });
  } catch (err) {
    console.error('Payment link email failed (link still exists in Stripe):',
      'session:', session_id, '| link:', paymentLink.id, '|', err.message);
    email_warning = err.message;
  }

  /* G15 defensive alert — see handleChargeRemaining for the pattern. */
  if (email_warning) {
    try {
      await sendAdminActionEmailFailureAlert('send-payment-link', booking, booking.customer_email, email_warning);
    } catch (alertErr) {
      console.error('[send-payment-link] defensive alert send FAILED (link still exists):',
        session_id, '|', alertErr.message);
    }
  }

  return res.status(200).json({
    ok: true,
    url: paymentLink.url,
    ...(email_warning ? { email_warning } : {}),
  });
}

async function handleMarkConcluded(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { session_id } = req.body || {};
  if (!session_id) return res.status(400).json({ error: 'Missing session_id' });
  try {
    const updated = await patchBooking(session_id, { status: 'concluded' });
    if (!updated) return res.status(404).json({ error: 'Booking not found' });
    return res.status(200).json({ ok: true, booking: updated });
  } catch (err) {
    console.error('Mark concluded error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

async function handleCancelBooking(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { session_id } = req.body || {};
  if (!session_id) return res.status(400).json({ error: 'Missing session_id' });
  try {
    const updated = await patchBooking(session_id, {
      status:       'cancelled',
      cancelled_at: new Date().toISOString(),
    });
    if (!updated) return res.status(404).json({ error: 'Booking not found' });

    // Send the customer cancellation email AFTER the DB write succeeds.
    // Email failures must not undo the cancel — the booking is genuinely cancelled.
    let email_warning = null;
    try {
      await sendCancellationEmail(updated);
    } catch (err) {
      console.error('Cancellation email failed (booking still cancelled):', err.message);
      email_warning = err.message;
    }

    /* G15 defensive alert — see handleChargeRemaining for the pattern. */
    if (email_warning) {
      try {
        await sendAdminActionEmailFailureAlert('cancel-booking', updated, updated.customer_email, email_warning);
      } catch (alertErr) {
        console.error('[cancel-booking] defensive alert send FAILED (cancel still applied):',
          session_id, '|', alertErr.message);
      }
    }

    return res.status(200).json({ ok: true, booking: updated, ...(email_warning ? { email_warning } : {}) });
  } catch (err) {
    console.error('Cancel booking error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

async function handleRefundBooking(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { session_id, refund_amount } = req.body || {};
  if (!session_id) return res.status(400).json({ error: 'Missing session_id' });

  const amount = parseFloat(refund_amount);
  if (!isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: 'refund_amount must be a positive number' });
  }

  try {
    const booking = await findBookingBySessionId(session_id);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });

    const paymentIntentId = booking.payment_intent_id;
    if (!paymentIntentId) {
      return res.status(400).json({ error: 'No Stripe payment_intent_id on this booking — use Cancel Booking instead.' });
    }

    const amountPaid = (booking.amount_total || 0) / 100;
    const alreadyRefunded = parseFloat(booking.refund_amount || 0);
    const refundable = Math.max(0, amountPaid - alreadyRefunded);
    if (amount > refundable + 0.001) {
      return res.status(400).json({ error: `Refund ${formatMoneyDollars(amount)} exceeds refundable balance ${formatMoneyDollars(refundable)}` });
    }

    const refund = await stripe.refunds.create({
      payment_intent: paymentIntentId,
      amount:         Math.round(amount * 100),
    });

    if (refund.status !== 'succeeded' && refund.status !== 'pending') {
      return res.status(502).json({ error: `Stripe refund returned status ${refund.status}` });
    }

    const totalRefundedNow = parseFloat((alreadyRefunded + amount).toFixed(2));

    // Determine "full" vs "partial" by what's left unrefunded after this event.
    // Treat cents-rounding error tolerantly (1¢ slack). Computed BEFORE the
    // patch so it can gate status/cancelled_at — partial refunds must NOT
    // cancel the booking (mirrors api/stripe-webhook.js:129 isFull pattern).
    const remainingAfter = Math.max(0, amountPaid - totalRefundedNow);
    const isFullRefund = remainingAfter < 0.01;

    const refundUpdates = {
      refund_amount: totalRefundedNow,
      refunded_at:   new Date().toISOString(),
    };
    if (isFullRefund) {
      refundUpdates.status       = 'cancelled';
      refundUpdates.cancelled_at = booking.cancelled_at || new Date().toISOString();
    }
    const updated = await patchBooking(session_id, refundUpdates);

    // Stripe refund succeeded + DB updated. Email failure must NOT undo either —
    // we already moved the customer's money, the email is best-effort.
    let email_warning = null;
    try {
      await sendRefundEmail(updated || booking, amount, isFullRefund, remainingAfter);
    } catch (err) {
      console.error('Refund email failed (refund still processed):', err.message);
      email_warning = err.message;
    }

    /* G15 defensive alert — see handleChargeRemaining for the pattern. */
    if (email_warning) {
      try {
        await sendAdminActionEmailFailureAlert('refund-booking', updated || booking, (updated || booking).customer_email, email_warning);
      } catch (alertErr) {
        console.error('[refund-booking] defensive alert send FAILED (refund still processed):',
          session_id, '|', alertErr.message);
      }
    }

    return res.status(200).json({
      ok: true,
      booking: updated,
      refund_id: refund.id,
      refunded_now: amount,
      total_refunded: totalRefundedNow,
      remaining_after: remainingAfter,
      refund_kind: isFullRefund ? 'full' : 'partial',
      ...(email_warning ? { email_warning } : {}),
    });
  } catch (err) {
    console.error('Refund booking error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

async function handleReleaseDamageHold(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { session_id } = req.body || {};
  if (!session_id) return res.status(400).json({ error: 'Missing session_id' });

  try {
    const booking = await findBookingBySessionId(session_id);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (!booking.damage_hold_intent_id) return res.status(400).json({ error: 'No damage hold on this booking.' });
    if (booking.damage_hold_status === 'released') return res.status(400).json({ error: 'Damage hold is already released.' });
    if (booking.damage_hold_status === 'captured') return res.status(400).json({ error: 'Damage hold has already been captured — cannot release.' });

    // Cancel the manual-capture PaymentIntent so the customer's card is freed up
    await stripe.paymentIntents.cancel(booking.damage_hold_intent_id);

    const updated = await patchBooking(session_id, {
      damage_hold_status:      'released',
      damage_hold_released_at: new Date().toISOString(),
    });
    return res.status(200).json({ ok: true, booking: updated });
  } catch (err) {
    console.error('Release damage hold error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

async function handleCaptureDamageCharge(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { session_id, amount } = req.body || {};
  if (!session_id) return res.status(400).json({ error: 'Missing session_id' });
  const dollars = parseFloat(amount);
  if (!isFinite(dollars) || dollars <= 0) return res.status(400).json({ error: 'amount must be a positive number' });

  try {
    const booking = await findBookingBySessionId(session_id);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (!booking.damage_hold_intent_id) return res.status(400).json({ error: 'No damage hold on this booking.' });
    if (booking.damage_hold_status === 'released') return res.status(400).json({ error: 'Damage hold has already been released — cannot capture.' });
    if (booking.damage_hold_status === 'captured') return res.status(400).json({ error: 'Damage hold has already been captured.' });

    const HOLD_CENTS  = 25000;       // $250 — the full hold amount
    const totalCents  = Math.round(dollars * 100);
    const captureCents = Math.min(totalCents, HOLD_CENTS);
    const overflowCents = Math.max(0, totalCents - HOLD_CENTS);

    // Step 1: capture the hold (up to $250).
    await stripe.paymentIntents.capture(booking.damage_hold_intent_id, { amount_to_capture: captureCents });

    // Step 2: if the damage exceeded $250, charge the difference on the saved card.
    let overflowChargeId = null;
    if (overflowCents > 0) {
      if (!booking.payment_method_id || !booking.stripe_customer_id) {
        return res.status(400).json({ error: `Captured the $250 hold but no saved payment method for the overflow charge of ${formatMoneyDollars(overflowCents / 100)}. Charge manually.` });
      }
      /* G21 idempotency — same defense-in-depth pattern as
         handleChargeRemaining. The damage_hold_status='captured'
         precondition at line 567 is the primary guard; this key
         protects the narrow race where two simultaneous clicks both
         pass the precondition before either patchBooking lands.
         Stripe's idempotency cache (24h) returns the same overflow PI
         on a retry with the same key.
         Ref: docs/queue/g21-admin-paymentintent-idempotency.md */
      const overflowPI = await stripe.paymentIntents.create({
        amount:         overflowCents,
        currency:       'usd',
        customer:       booking.stripe_customer_id,
        payment_method: booking.payment_method_id,
        confirm:        true,
        off_session:    true,
        description:    `Damage charge overflow — ${booking.charter_name || 'charter'} on ${booking.date || ''}`,
        metadata: {
          purpose:            'damage_overflow',
          booking_session_id: session_id,
        },
      }, { idempotencyKey: 'damage_overflow_' + session_id + '_' + overflowCents });
      overflowChargeId = overflowPI.id;
    }

    const updated = await patchBooking(session_id, {
      damage_hold_status:      'captured',
      damage_charge_amount:    Number(dollars.toFixed(2)),
      damage_captured_at:      new Date().toISOString(),
    });

    // Customer email — failure must not undo the captured charge
    let email_warning = null;
    try {
      await sendDamageChargeEmail(updated || booking, dollars);
    } catch (err) {
      console.error('Damage charge email failed (charge still processed):', err.message);
      email_warning = err.message;
    }

    /* G15 defensive alert — see handleChargeRemaining for the pattern. */
    if (email_warning) {
      try {
        await sendAdminActionEmailFailureAlert('capture-damage-charge', updated || booking, (updated || booking).customer_email, email_warning);
      } catch (alertErr) {
        console.error('[capture-damage-charge] defensive alert send FAILED (capture still applied):',
          session_id, '|', alertErr.message);
      }
    }

    return res.status(200).json({
      ok: true,
      booking: updated,
      captured_dollars: Math.min(dollars, 250),
      overflow_dollars: Math.max(0, dollars - 250),
      overflow_charge_id: overflowChargeId,
      ...(email_warning ? { email_warning } : {}),
    });
  } catch (err) {
    console.error('Capture damage charge error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

async function handleListWaivers(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const filter = {
    session_id:   req.query.session_id   || undefined,
    booking_id:   req.query.booking_id   || undefined,
    charter_date: req.query.charter_date || undefined,
    signer_email: req.query.signer_email || undefined,
  };
  if (!filter.session_id && !filter.booking_id && !filter.charter_date && !filter.signer_email) {
    return res.status(400).json({ error: 'Provide one of: session_id, booking_id, charter_date, signer_email' });
  }
  try {
    const waivers = await listWaivers(filter);
    return res.status(200).json({ ok: true, waivers });
  } catch (err) {
    console.error('list-waivers error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

async function handleSendWaiverLink(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { session_id } = req.body || {};
  if (!session_id) return res.status(400).json({ error: 'session_id required' });

  try {
    const booking = await findBookingBySessionId(session_id);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (!booking.customer_email) return res.status(400).json({ error: 'No customer email on this booking — cannot send.' });

    await sendWaiverLinkEmail(booking);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('send-waiver-link error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

async function handleDeleteBooking(req, res) {
  if (req.method !== 'POST' && req.method !== 'DELETE') return res.status(405).end();
  const session_id = (req.body && req.body.session_id) || req.query.session_id;
  if (!session_id) return res.status(400).json({ error: 'Missing session_id' });
  try {
    await deleteBookingRow(session_id);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Delete booking error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

async function handleCustomerSearch(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).end();
  const q = req.query.q || (req.body && req.body.q) || '';
  try {
    const customers = await searchCustomers(q);
    return res.status(200).json({ customers });
  } catch (err) {
    console.error('Customer search error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

async function handleAddBooking(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { booking, send_confirmation } = req.body || {};
  if (!booking) return res.status(400).json({ error: 'Missing booking' });
  if (!booking.customer_email) return res.status(400).json({ error: 'customer_email is required' });

  try {
    const result = await addManualBooking(booking);

    if (send_confirmation) {
      try {
        await sendConfirmationEmails({
          customer_email:   booking.customer_email,
          amount_total:     Math.round(parseFloat(booking.grand_total || 0) * 100),
          session_id:       result.session_id,
          charter_name:     booking.charter_name,
          vessel:           booking.vessel,
          experience:       booking.experience,
          date:             booking.date,
          time_slot:        booking.time_slot,
          duration:         booking.duration,
          full_name:        booking.full_name,
          party_size:       booking.party_size,
          phone:            booking.phone,
          payment_type:     booking.payment_type,
          grand_total:      booking.grand_total,
          deposit_amount:   booking.deposit_amount,
          add_ons:          booking.add_ons,
          special_requests: booking.special_requests,
          promo_applied:    booking.promo_applied,
          newsletter:       false,
        });
      } catch (emailErr) {
        console.error('[add-booking] confirmation email failed:', emailErr.message);
        // Don't fail the request — booking is saved

        /* G15 defensive alert — see handleChargeRemaining for the pattern.
           Build the booking shape from the request body + the new session_id
           since we don't load the persisted row back here. */
        try {
          await sendAdminActionEmailFailureAlert('add-booking', { ...booking, session_id: result.session_id }, booking.customer_email, emailErr.message);
        } catch (alertErr) {
          console.error('[add-booking] defensive alert send FAILED (booking still saved):',
            result.session_id, '|', alertErr.message);
        }

        return res.status(200).json({
          ok: true,
          session_id:  result.session_id,
          customer_id: result.customer_id,
          email_warning: emailErr.message,
        });
      }
    }

    return res.status(200).json({
      ok: true,
      session_id:  result.session_id,
      customer_id: result.customer_id,
    });
  } catch (err) {
    console.error('Add booking error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

async function handleListCustomers(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  try {
    /* Now also pulls waivers so each booking in the customer detail can
       show its signed-waivers section (A1). Same per-booking enrichment
       shape as handleBookings — primary match by session_id, fallback by
       booking_id to catch waivers that were fuzzy-linked. */
    const [customers, bookings, waivers] = await Promise.all([
      listCustomers(),
      getBookings(),
      getAllWaivers(),
    ]);

    const waiversBySession = {};
    const waiversByBookingId = {};
    for (const w of waivers || []) {
      if (w.session_id) (waiversBySession[w.session_id] || (waiversBySession[w.session_id] = [])).push(w);
      if (w.booking_id) (waiversByBookingId[w.booking_id] || (waiversByBookingId[w.booking_id] = [])).push(w);
    }
    const enrichBookingWithWaivers = (b) => {
      const list = waiversBySession[b.session_id] || waiversByBookingId[b.id] || [];
      return { ...b, waivers: list, waiver_count: list.length };
    };

    // Index bookings by lowercase email
    const byEmail = {};
    for (const b of bookings) {
      const e = (b.customer_email || '').toLowerCase();
      if (!e) continue;
      (byEmail[e] || (byEmail[e] = [])).push(b);
    }

    // Enrich each customer with derived stats from booking history
    const enriched = customers.map(c => {
      let bk = byEmail[(c.email || '').toLowerCase()] || [];
      // Sort ascending for first/last
      bk.sort((a, b) => (a.date || a.booked_at || '').localeCompare(b.date || b.booked_at || ''));
      // Attach per-booking waivers so renderCustDetail can flatten them.
      bk = bk.map(enrichBookingWithWaivers);
      const firstBooking = bk[0] || null;
      const lastBooking  = bk[bk.length - 1] || null;
      // Derive source from earliest booking
      const source = firstBooking ? (firstBooking.source || 'website') : null;
      // Sum of grand_total across bookings as a fallback / canonical lifetime
      const computedLifetime = bk.reduce((s, b) => {
        const v = b.amount_total ? b.amount_total / 100 : parseFloat(b.grand_total || 0);
        return s + (isFinite(v) ? v : 0);
      }, 0);
      // Fallback newsletter flag from bookings until newsletter_subscribed column is populated everywhere
      const derivedNewsletter = bk.some(b => b.newsletter === true || b.newsletter === 'true' || b.newsletter === 1);
      return {
        ...c,
        derived_source:        source,
        derived_total_bookings: bk.length,
        derived_first_date:    firstBooking ? (firstBooking.date || firstBooking.booked_at) : c.first_booking_date,
        derived_last_date:     lastBooking  ? (lastBooking.date  || lastBooking.booked_at)  : c.last_booking_date,
        derived_lifetime:      computedLifetime || parseFloat(c.lifetime_value || c.total_spent || 0),
        derived_newsletter:    !!c.newsletter_subscribed || derivedNewsletter,
        bookings:              bk,
      };
    });

    return res.status(200).json({ customers: enriched });
  } catch (err) {
    console.error('List customers error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

async function handleUpdateCustomer(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { id, ...fields } = req.body || {};
  if (!id) return res.status(400).json({ error: 'Missing customer id' });
  try {
    const updated = await updateCustomer(id, fields);
    if (!updated) return res.status(404).json({ error: 'Customer not found or no allowed fields' });
    return res.status(200).json({ ok: true, customer: updated });
  } catch (err) {
    console.error('Update customer error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

async function handleCreateCustomer(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { customer } = req.body || {};
  if (!customer || !(customer.full_name || '').trim()) {
    return res.status(400).json({ error: 'full_name is required' });
  }
  try {
    const result = await createCustomer(customer);
    if (result.duplicate) {
      return res.status(200).json({ ok: false, duplicate: true, existing: result.existing });
    }
    return res.status(200).json({ ok: true, customer: result.customer });
  } catch (err) {
    console.error('Create customer error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

async function handleDeleteCustomer(req, res) {
  if (req.method !== 'POST' && req.method !== 'DELETE') return res.status(405).end();
  const id = (req.body && req.body.id) || req.query.id;
  if (!id) return res.status(400).json({ error: 'Missing customer id' });
  try {
    await deleteCustomer(id);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Delete customer error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

async function handleImportBookings(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { rows } = req.body || {};
  if (!Array.isArray(rows)) return res.status(400).json({ error: 'rows array required' });
  if (rows.length === 0)    return res.status(400).json({ error: 'rows is empty' });
  if (rows.length > 1000)   return res.status(400).json({ error: 'Max 1000 rows per import' });

  // Surface env-var state up front so a missing SUPABASE_URL is obvious in logs and response
  const envSummary = {
    has_supabase_url:        !!process.env.SUPABASE_URL,
    has_supabase_secret_key: !!process.env.SUPABASE_SECRET_KEY,
    supabase_url_host:       process.env.SUPABASE_URL ? (() => { try { return new URL(process.env.SUPABASE_URL).host; } catch { return 'INVALID'; } })() : null,
    node_env:                process.env.NODE_ENV || null,
    vercel_env:              process.env.VERCEL_ENV || null,
  };
  console.log('[import-bookings] starting:', { row_count: rows.length, ...envSummary });

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) {
    return res.status(500).json({
      error: 'Supabase env vars missing on this function — check Vercel project settings.',
      env: envSummary,
    });
  }

  try {
    const result = await importHistoricalBookings(rows);
    console.log('[import-bookings] complete:', { imported: result.imported, customers_created: result.customers_created, customers_matched: result.customers_matched, error_count: (result.errors || []).length });
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error('[import-bookings] failed:', err.message, '\n', err.stack);
    return res.status(500).json({ error: err.message, env: envSummary });
  }
}

async function handleUpdatePayment(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { session_id, ...fields } = req.body || {};
  if (!session_id) return res.status(400).json({ error: 'Missing session_id' });

  try {
    const updated = await updateBookingPayment(session_id, fields);
    if (!updated) return res.status(404).json({ error: 'Booking not found' });
    return res.status(200).json({ ok: true, booking: updated });
  } catch (err) {
    console.error('Update payment error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

/* ── Waivers (admin tab — all rows enriched with booking metadata) ─── */

async function handleListAllWaivers(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  try {
    const waivers = await listAllWaiversEnriched();
    return res.status(200).json({ waivers });
  } catch (err) {
    console.error('[admin] waivers list failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

/* ── Leads ─────────────────────────────────────────────────────────── */

/* Outcome → status mapping (single source of truth — modal/save handler
   reads this; the leads-list editability check uses LEAD_AGE_LOCK_DAYS).
   Outcome values that don't appear here are rejected at save time. */
const OUTCOME_TO_STATUS = {
  booked:      'converted',
  hard_no:     'declined',
  maybe:       'following_up',
  no_response: 'unreachable',
  quoted:      'quoted',
  other:       'contacted',
};
const ALLOWED_OUTCOMES = new Set(Object.keys(OUTCOME_TO_STATUS));
const LEAD_AGE_LOCK_DAYS = 90;

/* Compute whether the outcome/booking-link/bounce-reason fields on a
   lead are still editable. Mirrors STEP 8 of the spec. The lead's
   notes are ALWAYS editable — that's enforced separately in the save
   handler. `bookingDatesMap[session_id] = { date, status }` is passed
   in so we can decide booked-with-linkage cases without per-row
   round-trips. */
function computeOutcomeEditable(lead, bookingDatesMap) {
  if (!lead) return false;
  const outcome = lead.contact_outcome || null;
  if (outcome === 'booked') {
    // Edge case: booked but no linked session_id yet → editable until linked.
    if (!lead.linked_booking_session_id) return true;
    const b = bookingDatesMap && bookingDatesMap[lead.linked_booking_session_id];
    if (!b || !b.date) return true; // booking row missing or no date → treat as still pending
    const charterDay = new Date(b.date + 'T23:59:59Z'); // end of charter day, UTC
    return Date.now() < charterDay.getTime();
  }
  // Non-booked outcomes (or no outcome logged yet) → editable until 90d after captured_at.
  const capturedAt = lead.captured_at ? new Date(lead.captured_at).getTime() : 0;
  if (!capturedAt) return true;
  const lockAt = capturedAt + LEAD_AGE_LOCK_DAYS * 24 * 60 * 60 * 1000;
  return Date.now() < lockAt;
}

async function handleListLeads(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const status = req.query.status; // optional filter — 'captured' | 'abandoned_stripe' | ...
  try {
    const leads = await listLeads({ status: status || undefined, limit: 500 });
    /* Enrich with outcome_editable so the client can disable fields in
       the modal without making a per-lead round-trip. One batched
       lookup grabs every linked booking's date in a single query. */
    const linkedIds = leads
      .map(l => l.linked_booking_session_id)
      .filter(Boolean);
    const bookingDates = linkedIds.length
      ? await findBookingDatesBySessionIds(linkedIds)
      : {};
    for (const l of leads) {
      l.outcome_editable = computeOutcomeEditable(l, bookingDates);
    }
    return res.status(200).json({ leads });
  } catch (err) {
    console.error('[admin] list-leads failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

async function handleFindBookingsForLead(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const lead_id = req.query.lead_id;
  if (!lead_id) return res.status(400).json({ error: 'lead_id required' });
  try {
    // Fetch the lead first so we can match by email/phone/name. listLeads
    // returns the whole table; for one-shot fetch the PostgREST API is
    // fastest via patchLead semantics, but there's no findLeadById helper.
    // Reuse listLeads with limit 500 + filter is overkill — call /leads?id=eq.X
    // through the request helper. Simpler: fetch all and pick.
    const leads = await listLeads({ limit: 500 });
    const lead = leads.find(l => l.id === lead_id);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    const bookings = await findBookingsForLead(lead, { days: 30, limit: 20 });
    return res.status(200).json({ bookings });
  } catch (err) {
    console.error('[admin] find-bookings-for-lead failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

// Allowed bounce_reason values — must match the dropdown options in
// admin.html. Anything else is rejected (or silently nulled if blank).
const ALLOWED_BOUNCE_REASONS = new Set([
  'price', 'dates', 'group', 'distracted', 'comparing', 'info', 'other',
]);

async function handleMarkLeadContacted(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { id, notes, bounce_reason, outcome, linked_booking_session_id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id required' });

  /* Validate outcome — required for any new logged contact, but the
     client can also send a notes-only update (locked leads). Detect
     by checking whether outcome was supplied. */
  const outcomeSupplied = outcome != null && outcome !== '';
  if (outcomeSupplied && !ALLOWED_OUTCOMES.has(outcome)) {
    return res.status(400).json({ error: 'invalid outcome' });
  }

  /* Validate optional bounce_reason. */
  let reason = null;
  if (bounce_reason != null && bounce_reason !== '') {
    if (!ALLOWED_BOUNCE_REASONS.has(bounce_reason)) {
      return res.status(400).json({ error: 'invalid bounce_reason' });
    }
    reason = bounce_reason;
  }

  /* Booked outcome requires a linked booking. Verify the booking exists. */
  let linkedSid = null;
  if (outcome === 'booked') {
    if (!linked_booking_session_id) {
      return res.status(400).json({ error: 'must link a booking when outcome is \'booked\'' });
    }
    const booking = await findBookingBySessionId(linked_booking_session_id);
    if (!booking) {
      return res.status(400).json({ error: 'linked booking session_id not found' });
    }
    linkedSid = linked_booking_session_id;
  }

  try {
    /* Server-side editability enforcement (STEP 8). Fetch current lead
       + linked booking date map to recompute, then reject changes to
       locked fields. Notes are always allowed through. */
    const allLeads = await listLeads({ limit: 500 });
    const current = allLeads.find(l => l.id === id);
    if (!current) return res.status(404).json({ error: 'Lead not found' });
    const linkedIds = [current.linked_booking_session_id, linkedSid].filter(Boolean);
    const bookingDates = linkedIds.length ? await findBookingDatesBySessionIds(linkedIds) : {};
    const editable = computeOutcomeEditable(current, bookingDates);

    /* If locked, only allow notes update; reject any change to outcome /
       bounce_reason / linked booking. */
    if (!editable) {
      const wantsOutcomeChange     = outcomeSupplied && outcome !== current.contact_outcome;
      const wantsBounceChange      = (reason || null) !== (current.bounce_reason || null);
      const wantsLinkedChange      = (linkedSid || null) !== (current.linked_booking_session_id || null);
      if (wantsOutcomeChange || wantsBounceChange || wantsLinkedChange) {
        return res.status(403).json({ error: 'This lead is locked. Only notes can be updated.' });
      }
      const updated = await patchLead(id, {
        contact_notes: notes != null ? String(notes).slice(0, 2000) : null,
      });
      return res.status(200).json({ ok: true, lead: updated });
    }

    /* Editable — build the full update set. Outcome maps to status; the
       'booked' outcome also bumps converted_at. If the admin is editing
       an existing log (outcome unchanged), still re-stamp contacted_at
       so timeline reflects the most recent admin touch. */
    const patch = {
      contact_notes:             notes != null ? String(notes).slice(0, 2000) : null,
      bounce_reason:             reason,
      linked_booking_session_id: linkedSid,
      contacted_at:              new Date().toISOString(),
    };
    if (outcomeSupplied) {
      patch.contact_outcome = outcome;
      patch.status          = OUTCOME_TO_STATUS[outcome];
      if (outcome === 'booked') patch.converted_at = new Date().toISOString();
    } else {
      // First-time save without outcome shouldn't reach here (UI requires
      // it), but if a client somehow omits it, fall back to 'contacted'.
      patch.status = 'contacted';
    }
    const updated = await patchLead(id, patch);
    if (!updated) return res.status(404).json({ error: 'Lead not found' });
    return res.status(200).json({ ok: true, lead: updated });
  } catch (err) {
    console.error('[admin] mark-lead-contacted failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

/* ── Router ── */

const PUBLIC_ACTIONS = new Set(['login']);

const ROUTES = {
  'login':             handleLogin,
  'bookings':          handleBookings,
  'blackouts':         handleListBlackouts,
  'add-blackout':      handleAddBlackout,
  'remove-blackout':   handleRemoveBlackout,
  'mark-paid':         handleMarkPaid,
  'update-booking':    handleUpdateBooking,
  'charge-remaining':  handleChargeRemaining,
  'send-payment-link': handleSendPaymentLink,
  'customer-search':   handleCustomerSearch,
  'add-booking':       handleAddBooking,
  'update-payment':    handleUpdatePayment,
  'customers':         handleListCustomers,
  'update-customer':   handleUpdateCustomer,
  'create-customer':   handleCreateCustomer,
  'delete-customer':   handleDeleteCustomer,
  'import-bookings':   handleImportBookings,
  'mark-concluded':       handleMarkConcluded,
  'cancel-booking':       handleCancelBooking,
  'refund-booking':       handleRefundBooking,
  'delete-booking':       handleDeleteBooking,
  'release-damage-hold':  handleReleaseDamageHold,
  'capture-damage-charge':handleCaptureDamageCharge,
  'list-waivers':         handleListWaivers,
  'send-waiver-link':     handleSendWaiverLink,
  'waivers':              handleListAllWaivers,
  'leads':                  handleListLeads,
  'mark-lead-contacted':    handleMarkLeadContacted,
  'find-bookings-for-lead': handleFindBookingsForLead,
};

module.exports = async function handler(req, res) {
  const action = req.query.action;
  const route = ROUTES[action];

  if (!route) return res.status(400).json({ error: `Unknown action: ${action}` });

  if (!PUBLIC_ACTIONS.has(action) && !requireAuth(req, res)) return;

  return route(req, res);
};
