const crypto = require('crypto');
const { generateToken } = require('../lib/auth');

module.exports = async function handler(req, res) {
  console.log('[admin-login] method:', req.method);
  if (req.method !== 'POST') return res.status(405).end();

  const { password } = req.body || {};
  // Trim to guard against trailing newlines/spaces copied into the Vercel env var dashboard
  const adminPassword = (process.env.ADMIN_PASSWORD || '').trim();

  console.log('[admin-login] ADMIN_PASSWORD configured:', !!adminPassword, '| env length:', (process.env.ADMIN_PASSWORD || '').length, '| trimmed length:', adminPassword.length);
  console.log('[admin-login] submitted password present:', !!password, '| length:', String(password || '').length);

  if (!adminPassword) return res.status(500).json({ error: 'ADMIN_PASSWORD not configured' });
  if (!password) return res.status(400).json({ error: 'Password required' });

  const bufA = Buffer.from(String(password).trim());
  const bufB = Buffer.from(adminPassword);

  console.log('[admin-login] bufA length:', bufA.length, '| bufB length:', bufB.length, '| lengths match:', bufA.length === bufB.length);

  const match = bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);

  console.log('[admin-login] match result:', match);

  if (!match) return res.status(401).json({ error: 'Invalid password' });

  console.log('[admin-login] login successful, returning token');
  return res.status(200).json({ token: generateToken(adminPassword) });
};
