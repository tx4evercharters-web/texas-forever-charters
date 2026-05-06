const { requireAuth } = require('../lib/auth');
const { getBookings } = require('../lib/storage');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const https = require('https');

function supabasePatch(session_id, updates) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(updates);
    const path = `/rest/v1/bookings?session_id=eq.${encodeURIComponent(session_id)}`;
    const options = {
      hostname: new URL(SUPABASE_URL).hostname,
      path,
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_SECRET_KEY,
        'Authorization': `Bearer ${SUPABASE_SECRET_KEY}`,
        'Prefer': 'return=representation',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); } catch { resolve(raw); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAuth(req, res)) return;

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
};
