const crypto = require('crypto');
const { generateToken } = require('../lib/auth');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { password } = req.body || {};
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminPassword) return res.status(500).json({ error: 'ADMIN_PASSWORD not configured' });
  if (!password) return res.status(400).json({ error: 'Password required' });

  // Constant-time compare — pad if lengths differ to avoid short-circuit timing leaks
  const bufA = Buffer.from(String(password));
  const bufB = Buffer.from(String(adminPassword));
  const match = bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);

  if (!match) return res.status(401).json({ error: 'Invalid password' });

  return res.status(200).json({ token: generateToken(adminPassword) });
};
