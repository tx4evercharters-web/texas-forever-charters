const { requireAuth } = require('../lib/auth');
const { getBookings } = require('../lib/storage');

module.exports = async function handler(req, res) {
  if (!requireAuth(req, res)) return;
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
};
