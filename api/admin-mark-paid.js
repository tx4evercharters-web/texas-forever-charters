const { requireAuth } = require('../lib/auth');
const { markBookingPaid } = require('../lib/storage');

module.exports = async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method !== 'POST') return res.status(405).end();

  const { session_id } = req.body || {};
  if (!session_id) return res.status(400).json({ error: 'session_id required' });

  const booking = await markBookingPaid(session_id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  return res.status(200).json({ ok: true, booking });
};
