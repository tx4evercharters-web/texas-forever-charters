const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { getBookings } = require('../lib/storage');
const { requireAuth } = require('../lib/auth');
const { postToResend } = require('../lib/send-emails');

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
};
