const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { findBookingByPortalToken } = require('../lib/storage');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

/* Today as YYYY-MM-DD in America/Chicago. Mirrors api/portal.js +
   api/cron-reminders.js so past-charter detection is consistent
   across the codebase. */
function todayCentral() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const y = parts.find(p => p.type === 'year').value;
  const m = parts.find(p => p.type === 'month').value;
  const d = parts.find(p => p.type === 'day').value;
  return y + '-' + m + '-' + d;
}

function vesselLabel(v) {
  if (v === 'yacht')   return '40ft Carver Aft Cabin Yacht';
  if (v === 'pontoon') return '24ft Bentley Navigator 243 Pontoon';
  return v || 'Charter';
}

/* Format a YYYY-MM-DD date as "Saturday, June 6, 2026" for the Stripe line
   item description. T12:00:00 avoids UTC-midnight timezone drift. */
function formatDateForDescription(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T12:00:00');
  if (isNaN(d)) return dateStr;
  const months = ['January','February','March','April','May','June',
                  'July','August','September','October','November','December'];
  return months[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
}

module.exports = async function handler(req, res) {
  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};
  const token = (body.portal_token || '').toString().trim().toLowerCase();

  /* Token shape validation. 404 (not 400) so a malformed token is
     indistinguishable from an unmatched one — matches api/portal.js
     pattern, denies attackers the ability to probe the token namespace. */
  if (!/^[a-f0-9]{32}$/.test(token)) {
    return res.status(404).json({ error: 'Booking not found' });
  }

  let booking;
  try {
    booking = await findBookingByPortalToken(token);
  } catch (err) {
    console.error('[portal-checkout] lookup failed:', err.message);
    return res.status(500).json({ error: 'Could not load booking' });
  }
  if (!booking) {
    return res.status(404).json({ error: 'Booking not found' });
  }

  /* Pre-flight: refuse to create a checkout session for ineligible
     bookings. Server-side gates (UI also hides the button in these
     cases, but we don't trust the client). */
  if (booking.paid_in_full === true) {
    return res.status(400).json({ error: 'This booking is already paid in full.' });
  }
  if (booking.status === 'cancelled') {
    return res.status(400).json({ error: 'This booking has been cancelled.' });
  }
  const isPast = (booking.date || '') < todayCentral();
  if (isPast) {
    return res.status(400).json({ error: 'This charter date has passed. Call (737) 368-1669 if you have questions.' });
  }
  const remaining = parseFloat(booking.remaining_balance || 0);
  if (!isFinite(remaining) || remaining <= 0) {
    return res.status(400).json({ error: 'No remaining balance to pay.' });
  }

  /* Server-side amount calculation. Convert dollars to cents using Math.round
     to avoid floating-point dust. NEVER trusts a client-provided amount —
     the token + booking row are the only inputs that determine the charge. */
  const amountCents = Math.round(remaining * 100);
  if (amountCents <= 0 || amountCents > 99999999) {
    /* Stripe rejects amounts <= 0 or > $999,999.99. Defensive. */
    return res.status(400).json({ error: 'Invalid balance amount.' });
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(500).json({ error: 'Payment processor not configured' });
  }

  const vesselName = vesselLabel(booking.vessel);
  const dateLabel  = formatDateForDescription(booking.date);
  const productName = 'Texas Forever Charters - Balance Payment';
  const productDesc = vesselName + (dateLabel ? ' on ' + dateLabel : '');

  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host  = req.headers['x-forwarded-host']  || req.headers['host'];
  const baseUrl = proto + '://' + host;
  const portalPath = '/booking/' + token;

  /* Stripe-level idempotency: scope the key to session_id + 'balance' so
     repeated clicks within Stripe's 24h dedupe window return the same
     Checkout Session URL instead of creating a fresh one. Application-
     level idempotency (paid_in_full check) is enforced separately in the
     webhook handler that processes the completed event. */
  const idempotencyKey = 'portal_balance_' + booking.session_id;

  let session;
  try {
    session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: productName, description: productDesc },
          unit_amount: amountCents,
        },
        quantity: 1,
      }],
      /* Pre-fill the customer's email at Stripe checkout when we have it.
         The customer can edit; we don't trust this field for booking
         state — the webhook patches the booking row keyed by metadata,
         not by customer_email. */
      customer_email: booking.customer_email || undefined,
      metadata: {
        /* These three fields are how the webhook routes the
           checkout.session.completed event to the new balance handler.
           See the dispatch order comment at the top of
           api/stripe-webhook.js for why payment_type is checked first. */
        payment_type:       'balance',
        booking_session_id: booking.session_id,
        portal_token:       token,
      },
      success_url: baseUrl + portalPath + '?payment=success',
      cancel_url:  baseUrl + portalPath + '?payment=cancelled',
    }, { idempotencyKey });
  } catch (err) {
    console.error('[portal-checkout] Stripe create error:', err.message,
      '| session:', booking.session_id);
    return res.status(500).json({ error: 'Could not create checkout session.' });
  }

  console.log('[portal-checkout] balance checkout created',
    'booking:', booking.session_id,
    '| stripe_session:', session.id,
    '| amount_cents:', amountCents);

  return res.status(200).json({ url: session.url });
};
