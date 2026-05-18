/* api/auth-logout.js — clear the admin session cookie.
 *
 * Idempotent. Always returns 200, even if there was no session to clear,
 * so the frontend can fire-and-forget on logout without branching on
 * authentication state. */

const { clearSessionCookieHeader } = require('../lib/auth');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  clearSessionCookieHeader(res, req);
  return res.status(200).json({ ok: true });
};
