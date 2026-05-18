/* api/auth-google.js — Google OAuth login endpoint.
 *
 * The browser obtains a Google ID token via Google Identity Services (the
 * <script src="https://accounts.google.com/gsi/client"> button on
 * admin.html). It POSTs that id_token here. This handler:
 *
 *   1. Verifies the token via google-auth-library against GOOGLE_CLIENT_ID.
 *   2. Checks the verified email against ADMIN_WHITELIST.
 *   3. On match: signs a 30-day session cookie and sets it on the response.
 *   4. On failure: returns 403 with a generic "Access denied" message so
 *      probes can't distinguish "wrong token" from "not whitelisted".
 *
 * Logging policy: log the email on both granted-session and denied-attempt
 * paths so the deploy-log shows who tried to access the admin panel.
 */

const {
  verifyGoogleIdToken,
  getWhitelistedEmails,
  getDisplayName,
  signSessionCookie,
  setSessionCookieHeader,
} = require('../lib/auth');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};
  const idToken = (body.id_token || '').toString();
  if (!idToken) return res.status(400).json({ error: 'Missing id_token' });

  let verified;
  try {
    verified = await verifyGoogleIdToken(idToken);
  } catch (err) {
    /* Thrown only when GOOGLE_CLIENT_ID is missing — config error, not
       a token-validation failure. Surface as 500 so we don't silently
       reject all logins with a generic 403 when env is misconfigured. */
    console.error('[auth-google] config error:', err.message);
    return res.status(500).json({ error: 'Authentication misconfigured' });
  }

  if (!verified || !verified.email) {
    console.log('[auth-google] DENIED (token did not verify or email unverified)');
    return res.status(403).json({ error: 'Access denied' });
  }

  const whitelist = getWhitelistedEmails();
  if (whitelist.length === 0) {
    /* Empty whitelist means anyone with a valid Google account could log
       in. Refuse on principle — admin access requires an explicit allow
       list, never an open door. */
    console.error('[auth-google] ADMIN_WHITELIST is empty — refusing all logins');
    return res.status(500).json({ error: 'Authentication misconfigured' });
  }

  if (!whitelist.includes(verified.email)) {
    console.log('[auth-google] DENIED (not on whitelist):', verified.email);
    return res.status(403).json({ error: 'Access denied' });
  }

  const name = getDisplayName(verified.email);
  let cookieValue;
  try {
    cookieValue = signSessionCookie({ email: verified.email });
  } catch (err) {
    console.error('[auth-google] sign session failed:', err.message);
    return res.status(500).json({ error: 'Authentication misconfigured' });
  }

  setSessionCookieHeader(res, req, cookieValue);
  console.log('[auth-google] GRANTED session to', verified.email, '(' + name + ')');
  return res.status(200).json({ ok: true, user: { email: verified.email, name } });
};
