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
} = require('../lib/storage');
const { postToResend, sendConfirmationEmails } = require('../lib/send-emails');

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

  const allowedFields = ['date', 'time_slot', 'duration', 'party_size', 'vessel', 'experience', 'special_requests', 'add_ons'];
  const sanitized = {};
  for (const key of allowedFields) {
    if (updates[key] !== undefined) sanitized[key] = updates[key];
  }
  if (sanitized.duration) sanitized.duration = parseInt(sanitized.duration);
  if (sanitized.party_size) sanitized.party_size = parseInt(sanitized.party_size);

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
};

module.exports = async function handler(req, res) {
  const action = req.query.action;
  const route = ROUTES[action];

  if (!route) return res.status(400).json({ error: `Unknown action: ${action}` });

  if (!PUBLIC_ACTIONS.has(action) && !requireAuth(req, res)) return;

  return route(req, res);
};
