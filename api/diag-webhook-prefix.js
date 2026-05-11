/* ⚠️ ONE-TIME DIAGNOSTIC — DELETE AFTER USE ⚠️
 *
 * Created: 2026-05-11 during the Stripe sandbox-vs-live incident.
 * Purpose: confirm which STRIPE_WEBHOOK_SECRET value Vercel is actually
 *          loading in production by exposing ONLY the first 12 characters
 *          and the total length. Enough to compare against the signing
 *          secrets shown for your Live vs Test webhook endpoints in the
 *          Stripe dashboard — not enough to forge a webhook signature.
 *
 * Companion to api/diag-key-prefix.js (already deleted in commit 6f1c846).
 * That one verified STRIPE_SECRET_KEY's mode via the sk_live_/sk_test_
 * prefix. Webhook signing secrets DO NOT carry mode in their prefix —
 * both Live and Test signing secrets start with "whsec_". You verify by
 * comparing the returned prefix to what Stripe shows for each endpoint.
 *
 * To check in Stripe dashboard:
 *   1. https://dashboard.stripe.com/webhooks  (toggle to LIVE mode)
 *   2. Click your live webhook endpoint
 *   3. Click "Signing secret" → "Reveal"
 *   4. First 12 chars should match this endpoint's response
 *   Repeat in Test mode to see the OTHER endpoint's signing secret.
 *
 * If neither matches, the value in Vercel is from yet a third source
 * (deleted endpoint, manual paste error, etc.) — rotate it.
 *
 * Deletion checklist after verifying:
 *   1. Delete this file (api/diag-webhook-prefix.js)
 *   2. git commit + push the deletion
 *   3. Hit the endpoint URL again — must return 404
 *
 * Security notes:
 *   - Exposes at most 12 chars + integer length. Cannot forge signatures.
 *   - Token query param is a speed-bump against bots/crawlers; NOT a real
 *     secret (it ships in the URL/access logs).
 *   - Read-only. GET/HEAD only.
 */

const DIAG_TOKEN = 'tfc-diag-2025';
const PREFIX_LEN = 12;

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
    console.warn('[diag-webhook-prefix] 403 — token missing or wrong');
    return res.status(403).json({ error: 'Forbidden' });
  }

  const secret = process.env.STRIPE_WEBHOOK_SECRET || '';
  const prefix = secret ? secret.slice(0, PREFIX_LEN) : null;
  const length = secret.length;

  /* Log only length + shape signal — never log the prefix itself, so the
     value doesn't end up in Vercel log retention. */
  const shape = secret.startsWith('whsec_') ? 'WHSEC_PREFIXED'
              : (secret ? 'UNEXPECTED_PREFIX' : 'MISSING');
  console.log('[diag-webhook-prefix] OK — length:', length, 'shape:', shape);

  return res.status(200).json({
    prefix,
    length,
    note: 'ONE-TIME DIAGNOSTIC — delete api/diag-webhook-prefix.js after verifying.',
  });
};
