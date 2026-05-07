const crypto = require('crypto');
const https = require('https');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const { requireAuth, generateToken } = require('../lib/auth');
const {
  getBookings,
  markBookingPaid,
  getBlackouts,
  addBlackout,
  removeBlackout,
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
} = require('../lib/storage');
const { postToResend, sendConfirmationEmails, sendCancellationEmail, sendRefundEmail } = require('../lib/send-emails');

/* ── Direct Supabase PATCH for booking edits ── */
function supabasePatch(session_id, updates) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(updates);
    const url = new URL(process.env.SUPABASE_URL);
    const options = {
      hostname: url.hostname,
      path: `/rest/v1/bookings?session_id=eq.${encodeURIComponent(session_id)}`,
      method: 'PATCH',
      headers: {
        'Content-Type':  'application/json',
        'apikey':        process.env.SUPABASE_SECRET_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
        'Prefer':        'return=representation',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`Supabase ${res.statusCode}: ${raw}`));
        try { resolve(JSON.parse(raw)); } catch { resolve(raw); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

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

  const bookings = await getBookings();
  const today = new Date().toISOString().split('T')[0];

  const upcoming = bookings
    .filter(b => (b.date || '') >= today)
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const past = bookings
    .filter(b => (b.date || '') < today)
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  return res.status(200).json({ upcoming, past, all: bookings });
}

async function handleListBlackouts(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  return res.status(200).json(await getBlackouts());
}

async function handleAddBlackout(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { date } = req.body || {};
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date required in YYYY-MM-DD format' });
  }
  return res.status(200).json(await addBlackout(date));
}

async function handleRemoveBlackout(req, res) {
  if (req.method !== 'DELETE') return res.status(405).end();
  const date = req.query.date;
  if (!date) return res.status(400).json({ error: 'date required as ?date=YYYY-MM-DD' });
  return res.status(200).json(await removeBlackout(date));
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
    await supabasePatch(session_id, sanitized);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Update booking error:', err.message);
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
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(remaining * 100),
      currency: 'usd',
      customer: booking.stripe_customer_id,
      payment_method: booking.payment_method_id,
      off_session: true,
      confirm: true,
      description: `Remaining balance — ${booking.charter_name || booking.experience} on ${booking.date}`,
      receipt_email: booking.customer_email || undefined,
    });

    if (paymentIntent.status === 'succeeded') {
      await markBookingPaid(session_id);
      return res.status(200).json({ ok: true, message: 'Payment successful' });
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

  try {
    const paymentLink = await stripe.paymentLinks.create({
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
        redirect: { url: 'https://www.texasforevercharters.com/booking-confirmation.html' },
      },
    });

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
            <p>Your charter is coming up on <strong>${booking.date}</strong> and you have a remaining balance of <strong>$${remaining.toFixed(2)}</strong>.</p>
            <p>Click below to pay securely:</p>
            <div style="text-align:center;margin:32px 0;">
              <a href="${paymentLink.url}" style="background:#C8102E;color:#fff;padding:14px 32px;border-radius:6px;text-decoration:none;font-weight:700;font-size:16px;">Pay $${remaining.toFixed(2)}</a>
            </div>
            <p style="font-size:13px;color:#666;">Questions? Call or text us at (737) 368-1669</p>
          </div>
        </div>
      `,
    });

    return res.status(200).json({ ok: true, url: paymentLink.url });
  } catch (err) {
    console.error('Payment link error:', err.message);
    return res.status(500).json({ error: err.message });
  }
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
      return res.status(400).json({ error: `Refund $${amount.toFixed(2)} exceeds refundable balance $${refundable.toFixed(2)}` });
    }

    const refund = await stripe.refunds.create({
      payment_intent: paymentIntentId,
      amount:         Math.round(amount * 100),
    });

    if (refund.status !== 'succeeded' && refund.status !== 'pending') {
      return res.status(502).json({ error: `Stripe refund returned status ${refund.status}` });
    }

    const totalRefundedNow = parseFloat((alreadyRefunded + amount).toFixed(2));
    const updated = await patchBooking(session_id, {
      refund_amount:  totalRefundedNow,
      refunded_at:    new Date().toISOString(),
      status:         'cancelled',
      cancelled_at:   booking.cancelled_at || new Date().toISOString(),
    });

    // Determine "full" vs "partial" by what's left unrefunded after this event.
    // Treat cents-rounding error tolerantly (1¢ slack).
    const remainingAfter = Math.max(0, amountPaid - totalRefundedNow);
    const isFullRefund = remainingAfter < 0.01;

    // Stripe refund succeeded + DB updated. Email failure must NOT undo either —
    // we already moved the customer's money, the email is best-effort.
    let email_warning = null;
    try {
      await sendRefundEmail(updated || booking, amount, isFullRefund, remainingAfter);
    } catch (err) {
      console.error('Refund email failed (refund still processed):', err.message);
      email_warning = err.message;
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
    const [customers, bookings] = await Promise.all([listCustomers(), getBookings()]);

    // Index bookings by lowercase email
    const byEmail = {};
    for (const b of bookings) {
      const e = (b.customer_email || '').toLowerCase();
      if (!e) continue;
      (byEmail[e] || (byEmail[e] = [])).push(b);
    }

    // Enrich each customer with derived stats from booking history
    const enriched = customers.map(c => {
      const bk = byEmail[(c.email || '').toLowerCase()] || [];
      // Sort ascending for first/last
      bk.sort((a, b) => (a.date || a.booked_at || '').localeCompare(b.date || b.booked_at || ''));
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
  'mark-concluded':    handleMarkConcluded,
  'cancel-booking':    handleCancelBooking,
  'refund-booking':    handleRefundBooking,
  'delete-booking':    handleDeleteBooking,
};

module.exports = async function handler(req, res) {
  const action = req.query.action;
  const route = ROUTES[action];

  if (!route) return res.status(400).json({ error: `Unknown action: ${action}` });

  if (!PUBLIC_ACTIONS.has(action) && !requireAuth(req, res)) return;

  return route(req, res);
};
