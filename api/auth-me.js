/* api/auth-me.js — current-session probe.
 *
 * Returns:
 *   200 { authenticated: true, user, google_client_id, sentry_dsn, sentry_environment }
 *     — caller has a valid, whitelisted session cookie.
 *   401 { authenticated: false, google_client_id, sentry_dsn, sentry_environment }
 *     — caller is not authenticated. The client uses google_client_id to
 *       initialize the Google Identity Services button on the login screen.
 *
 * google_client_id, sentry_dsn, and sentry_environment are returned on
 * BOTH the success and 401 responses. This lets admin.html make a single
 * round-trip to determine its state AND obtain the public config it needs
 * to initialize both the Google Sign-In button (on the login screen) and
 * the Sentry browser SDK (which we want capturing errors even on the
 * pre-auth login screen). All three values are public-by-design — Google
 * publishes client_id in every issued ID token; Sentry browser DSNs are
 * specifically architected to be safe to embed in JS bundles served
 * directly to anonymous clients.
 *
 * Cache-Control: no-store. Session state must never be cached. */

const { getUserFromRequest } = require('../lib/auth');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader('Cache-Control', 'no-store');

  const googleClientId   = (process.env.GOOGLE_CLIENT_ID || '').trim();
  const sentryDsn        = (process.env.SENTRY_DSN_BROWSER || '').trim();
  const sentryEnvironment = (process.env.SENTRY_ENVIRONMENT || 'production').trim();
  const user             = getUserFromRequest(req);

  const publicConfig = {
    google_client_id:   googleClientId,
    sentry_dsn:         sentryDsn,
    sentry_environment: sentryEnvironment,
  };

  if (!user) {
    return res.status(401).json({ authenticated: false, ...publicConfig });
  }
  return res.status(200).json({
    authenticated: true,
    user:          { email: user.email, name: user.name },
    ...publicConfig,
  });
};
