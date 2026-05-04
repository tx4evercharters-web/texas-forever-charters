const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

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
      },
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Stripe error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
