/* api/auth-me.js — current-session probe.
 *
 * Returns:
 *   200 { authenticated: true, user: { email, name }, google_client_id }
 *     — caller has a valid, whitelisted session cookie.
 *   401 { authenticated: false, google_client_id }
 *     — caller is not authenticated. The client uses google_client_id to
 *       initialize the Google Identity Services button on the login screen.
 *
 * Returning google_client_id on both success and 401 lets admin.html make
 * a single round-trip to determine its state AND obtain the OAuth client
 * ID it needs to render the Sign-In button. The client ID is public by
 * design (Google publishes it as the audience in every ID token issued
 * for this app), so exposing it via API is not a leak.
 *
 * Cache-Control: no-store. Session state must never be cached. */

const { getUserFromRequest } = require('../lib/auth');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader('Cache-Control', 'no-store');

  const googleClientId = (process.env.GOOGLE_CLIENT_ID || '').trim();
  const user = getUserFromRequest(req);

  if (!user) {
    return res.status(401).json({ authenticated: false, google_client_id: googleClientId });
  }
  return res.status(200).json({
    authenticated:    true,
    user:             { email: user.email, name: user.name },
    google_client_id: googleClientId,
  });
};
