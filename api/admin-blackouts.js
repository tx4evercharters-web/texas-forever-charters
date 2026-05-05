const { requireAuth } = require('../lib/auth');
const { getBlackouts, addBlackout, removeBlackout } = require('../lib/storage');

module.exports = async function handler(req, res) {
  if (!requireAuth(req, res)) return;

  if (req.method === 'GET') {
    return res.status(200).json(await getBlackouts());
  }

  if (req.method === 'POST') {
    const { date } = req.body || {};
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date))
      return res.status(400).json({ error: 'date required in YYYY-MM-DD format' });
    return res.status(200).json(await addBlackout(date));
  }

  if (req.method === 'DELETE') {
    const date = req.query.date;
    if (!date) return res.status(400).json({ error: 'date required as ?date=YYYY-MM-DD' });
    return res.status(200).json(await removeBlackout(date));
  }

  return res.status(405).end();
};
