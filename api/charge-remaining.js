const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { getBookings, markBookingPaid } = require('../lib/storage');
const { requireAuth } = require('../lib/auth');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!requireAuth(req, res)) return;

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
    } else {
      return res.status(400).json({ error: 'Payment did not succeed', status: paymentIntent.status });
    }
  } catch (err) {
    console.error('Charge error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
