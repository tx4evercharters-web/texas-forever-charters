/* ⚠️ ONE-TIME DIAGNOSTIC — DELETE AFTER USE ⚠️
 *
 * Created: 2026-05-11 during the Stripe sandbox-vs-live incident.
 * Purpose: confirm which STRIPE_SECRET_KEY value Vercel is actually loading
 *          in production by exposing ONLY the first 18 characters — enough
 *          to identify mode (sk_live_ vs sk_test_) and the Stripe account
 *          prefix, NOT enough to use the key.
 *
 * Deletion checklist after verifying:
 *   1. Delete this file (api/diag-key-prefix.js)
 *   2. git commit + push the deletion
 *   3. Hit the endpoint URL again — must return 404
 *
 * Security notes:
 *   - Exposes at most 18 chars + integer length. Cannot reconstruct the key.
 *   - Token query param is a speed-bump against bots/curious crawlers; it is
 *     NOT a real secret (it ships in the URL/access logs).
 *   - Read-only. Never mutates anything.
 *   - GET/HEAD only — all other methods return 405.
 */

const DIAG_TOKEN = 'tfc-diag-2025';
const PREFIX_LEN = 18;

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  /* Token comes from the URL query string. Vercel's Node runtime usually
     populates req.query, but parse manually as a fallback so this works
     regardless of the platform's query-parsing convention. */
  let token = (req.query && req.query.token) || null;
  if (!token && req.url) {
    try {
      const u = new URL(req.url, 'http://localhost');
      token = u.searchParams.get('token');
    } catch { /* ignore — fall through to 403 */ }
  }

  if (token !== DIAG_TOKEN) {
    console.warn('[diag-key-prefix] 403 — token missing or wrong');
    return res.status(403).json({ error: 'Forbidden' });
  }

  const key    = process.env.STRIPE_SECRET_KEY || '';
  const prefix = key ? key.slice(0, PREFIX_LEN) : null;
  const length = key.length;

  /* Log only the length and a coarse mode signal — never log the prefix
     itself so it doesn't end up in Vercel log retention. */
  const mode = key.startsWith('sk_live_') ? 'LIVE'
             : key.startsWith('sk_test_') ? 'TEST'
             : (key ? 'UNKNOWN' : 'MISSING');
  console.log('[diag-key-prefix] OK — length:', length, 'mode:', mode);

  return res.status(200).json({
    prefix,
    length,
    note: 'ONE-TIME DIAGNOSTIC — delete api/diag-key-prefix.js after verifying.',
  });
};
