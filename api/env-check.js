/* api/env-check.js
 *
 * Public env-presence probe. Reports which environment variables the runtime
 * function instance has access to. Used by post-deploy curl probes to verify
 * a deploy did not silently drop env vars.
 *
 * INTENTIONALLY UNAUTHENTICATED. The post-deploy probe is run without
 * credentials, so the endpoint must be reachable by anyone. The only thing
 * leaked is the list of env var NAMES this codebase expects, which is already
 * inferable from the public GitHub repo.
 *
 * NEVER EXPOSES VALUES. Each var is reported as a boolean (present / absent),
 * never the value itself. Exposing values would leak SUPABASE_SECRET_KEY,
 * STRIPE_SECRET_KEY, etc. Strict invariant.
 *
 * REQUIRED vs OPTIONAL:
 *   required  -> if any of these is false, the deploy is broken. The endpoint
 *                or its callers will throw at request time.
 *   optional  -> read via `process.env.X || fallback`. Missing means the
 *                hardcoded fallback is active. Informational, not an alarm.
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const REQUIRED_VARS = [
  'SUPABASE_URL',
  'SUPABASE_SECRET_KEY',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'RESEND_API_KEY',
  'ANTHROPIC_API_KEY',
  'ADMIN_PASSWORD',
  'CRON_SECRET',
  'MAILCHIMP_API_KEY',
  'MAILCHIMP_AUDIENCE_ID',
];

const OPTIONAL_VARS = [
  'SITE_BASE_URL',
  'GOOGLE_REVIEW_URL',
];

module.exports = async function handler(req, res) {
  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET')     return res.status(405).json({ error: 'Method not allowed' });

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    env:        process.env.VERCEL_ENV || 'unknown',
    checked_at: new Date().toISOString(),
    required:   Object.fromEntries(REQUIRED_VARS.map(k => [k, !!process.env[k]])),
    optional:   Object.fromEntries(OPTIONAL_VARS.map(k => [k, !!process.env[k]])),
  });
};
