const { getBookings, getBlackouts } = require('../lib/storage');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const VESSEL_VALUES = ['yacht', 'pontoon'];

module.exports = async function handler(req, res) {
  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const date   = req.query && req.query.date;
  const vessel = req.query && req.query.vessel;

  // Mode B: ?vessel=yacht (no date) — return every full-day blackout that
  // affects the vessel. Used by booking.html to disable calendar dates.
  if (!date && vessel && VESSEL_VALUES.includes(vessel)) {
    try {
      const { getBlackouts } = require('../lib/storage');
      const blackouts = await getBlackouts();
      const dates = blackouts
        .filter(b => (b.time_slot || 'all') === 'all')
        .filter(b => b.vessel === vessel || b.vessel === 'both')
        .map(b => b.date);
      return res.status(200).json({ vessel, blackout_dates: Array.from(new Set(dates)) });
    } catch (err) {
      console.error('[availability/list] error for vessel=' + vessel + ':', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date required in YYYY-MM-DD format' });
  }
  if (!vessel || !VESSEL_VALUES.includes(vessel)) {
    return res.status(400).json({ error: 'vessel required (yacht or pontoon)' });
  }

  try {
    const [bookings, blackouts] = await Promise.all([getBookings(), getBlackouts()]);

    // Booked slots: any booking on this date for this vessel that isn't cancelled.
    // Cancelled bookings free their slot up so the admin can rebook the time.
    const booked_slots = bookings
      .filter(b => b.date === date)
      .filter(b => (b.vessel || '') === vessel)
      .filter(b => String(b.status || '').toLowerCase() !== 'cancelled')
      .map(b => b.time_slot)
      .filter(Boolean);

    // Blackout rows that apply to this date AND this vessel (or both).
    const matchingBlackouts = blackouts.filter(b =>
      b.date === date && (b.vessel === vessel || b.vessel === 'both')
    );

    // is_fully_blacked_out: any matching row whose time_slot is 'all'
    // means the entire day is unavailable for this vessel.
    const is_fully_blacked_out = matchingBlackouts.some(b => (b.time_slot || 'all') === 'all');

    // blackout_slots: the specific time-slot blocks (excludes the 'all' rows
    // which are surfaced via is_fully_blacked_out instead).
    const blackout_slots = matchingBlackouts
      .filter(b => b.time_slot && b.time_slot !== 'all')
      .map(b => b.time_slot);

    return res.status(200).json({
      date,
      vessel,
      booked_slots:         Array.from(new Set(booked_slots)),
      blackout_slots:       Array.from(new Set(blackout_slots)),
      is_fully_blacked_out,
    });
  } catch (err) {
    console.error('[availability] error for date=' + date + ' vessel=' + vessel + ':', err.message);
    return res.status(500).json({ error: err.message });
  }
};
