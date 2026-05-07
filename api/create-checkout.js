const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const https = require('https');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

/* Direct Supabase REST query — kept inline rather than imported from
   lib/storage to avoid pulling in unused helpers on this hot checkout path.
   Returns null on any failure so a Supabase outage never blocks a sale. */
function findRecentDuplicateBooking({ email, date, time_slot, withinMinutes }) {
  return new Promise((resolve) => {
    const base = process.env.SUPABASE_URL;
    const key  = process.env.SUPABASE_SECRET_KEY;
    if (!base || !key || !email || !date || !time_slot) return resolve(null);

    const since = new Date(Date.now() - withinMinutes * 60 * 1000).toISOString();
    const path = '/rest/v1/bookings?select=session_id,booked_at,customer_email,date,time_slot,status' +
      '&customer_email=eq.' + encodeURIComponent(email.toLowerCase()) +
      '&date=eq.'           + encodeURIComponent(date) +
      '&time_slot=eq.'      + encodeURIComponent(time_slot) +
      '&booked_at=gte.'     + encodeURIComponent(since) +
      '&order=booked_at.desc&limit=1';

    let url;
    try { url = new URL(base.replace(/\/+$/, '') + path); }
    catch { return resolve(null); }

    const req = https.request(
      { hostname: url.hostname, path: url.pathname + url.search, method: 'GET',
        headers: { apikey: key, Authorization: 'Bearer ' + key, Accept: 'application/json' } },
      (res) => {
        let raw = '';
        res.on('data', c => { raw += c; });
        res.on('end', () => {
          if (res.statusCode >= 400) {
            console.error('[create-checkout] dup-check supabase error', res.statusCode, raw);
            return resolve(null);
          }
          try {
            const rows = JSON.parse(raw);
            const row = Array.isArray(rows) && rows[0] ? rows[0] : null;
            // Cancelled bookings shouldn't block a re-book — caller wanted the slot back.
            if (row && row.status === 'cancelled') return resolve(null);
            resolve(row);
          } catch { resolve(null); }
        });
      }
    );
    req.on('error', (err) => {
      console.error('[create-checkout] dup-check request failed', err.message);
      resolve(null);
    });
    req.end();
  });
}

module.exports = async function handler(req, res) {
  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { paymentType, amount, grandTotal, depositAmount, booking } = req.body || {};

  if (!paymentType || !amount || !booking) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(500).json({ error: 'Payment processor not configured' });
  }

  /* Duplicate-booking guard — protects against the "didn't get a confirmation
     email so I tried again" double-charge pattern. We block when the same
     email + date + time_slot was booked in the last 2 hours. Cancelled rows
     are intentionally ignored (the slot is open again). */
  if (booking.email && booking.date && booking.timeSlot) {
    const dup = await findRecentDuplicateBooking({
      email:         booking.email,
      date:          booking.date,
      time_slot:     booking.timeSlot,
      withinMinutes: 120,
    });
    if (dup) {
      console.log('[create-checkout] duplicate booking blocked',
        'email:', booking.email, '| date:', booking.date, '| slot:', booking.timeSlot,
        '| existing_session:', dup.session_id);
      return res.status(409).json({
        error:   'duplicate_booking',
        message: 'A booking for this date and time already exists for this email address.',
        existing_session_id: dup.session_id,
      });
    }
  }

  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers['host'];
  const baseUrl = `${proto}://${host}`;

  const vesselName = booking.vessel === 'yacht'
    ? '40ft Carver Aft Cabin'
    : '24ft Bentley Navigator 243';

  const paymentLabel = paymentType === 'deposit' ? 'Deposit (10%)' : 'Full Payment';

  const productName = `Texas Forever Charters — ${booking.experience}`;
  const productDesc = `${vesselName} · ${booking.duration} hrs · ${booking.date} at ${booking.timeSlot} · ${paymentLabel}`;

  // Stripe metadata values max 500 chars each
  const truncate = (str, max = 500) =>
    str ? String(str).slice(0, max) : '';

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      billing_address_collection: 'required',
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: productName,
              description: productDesc,
            },
            unit_amount: Math.round(amount * 100),
          },
          quantity: 1,
        },
      ],
      customer_email: booking.email || undefined,
      customer_creation: 'always',
      payment_intent_data: {
        setup_future_usage: 'off_session',
      },
      success_url: `${baseUrl}/booking-confirmation.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/booking.html`,
      metadata: {
        charter_name:    truncate(booking.charterName),
        vessel:          truncate(booking.vessel),
        experience:      truncate(booking.experience),
        date:            truncate(booking.date),
        time_slot:       truncate(booking.timeSlot),
        duration:        String(booking.duration || ''),
        full_name:       truncate(booking.fullName),
        party_size:      String(booking.partySize || ''),
        phone:           truncate(booking.phone),
        payment_type:    paymentType,
        grand_total:     String(grandTotal || amount),
        deposit_amount:  String(depositAmount || ''),
        add_ons:         truncate(JSON.stringify(booking.addOns || {})),
        special_requests: truncate(booking.specialRequests, 490),
        newsletter:      String(!!booking.newsletter),
        promo_applied:   String(!!booking.promoApplied),
        admin_fee:        String(booking.adminFee || ''),
        tax_amount:       String(booking.taxAmount || ''),
        processing_fee:   String(booking.processingFee || ''),
        charter_subtotal: String(booking.charterSubtotal || ''),
        promo_discount:   String(booking.promoDiscount || ''),
      },
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Stripe error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
