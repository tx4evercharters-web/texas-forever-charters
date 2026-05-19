/* lib/observability.js — observability infrastructure for TFC.
 *
 * Phase 1 (this commit): Better Stack heartbeat pings for Vercel cron
 * monitoring. Each Vercel-declared cron pings its heartbeat URL on
 * successful completion and the `/fail` variant on uncaught errors.
 * Better Stack pages DJ when an expected heartbeat doesn't arrive
 * within the dashboard-configured window — turning silent cron
 * failures into actionable alerts.
 *
 * Phase 2 (next commit): Sentry error tracking with PII-scrubbed
 * context capture. Sentry init + beforeSend filter + captureException
 * wrapper will land in this same file.
 *
 * Defensive contract: every observability call is fire-and-forget.
 * If the monitoring vendor is down or env vars are unset, the cron's
 * actual work runs to completion regardless. No throw from this
 * module is permitted to break production flows. */

const HEARTBEAT_TIMEOUT_MS = 5000;

/* Ping a Better Stack heartbeat URL.
 *
 * url     — the heartbeat URL from the Better Stack dashboard, shaped
 *           https://uptime.betterstack.com/api/v1/heartbeat/<token>.
 *           Falsy values short-circuit to no-op so this is safe to call
 *           with a missing env var (e.g., local dev, preview deploys).
 * opts    — { fail: true } sends the explicit failure variant (appends
 *           /fail to the URL path). Omit for the success ping.
 *
 * Better Stack's two-state model: a successful GET marks the monitor
 * healthy; a GET to <url>/fail marks it failing. Missed heartbeats
 * (no ping within the expected window) alert separately. Unlike
 * Cronitor, Better Stack has no /run or /start variant — the
 * absence-of-ping IS the missed-run signal.
 *
 * Aborts after HEARTBEAT_TIMEOUT_MS so a slow Better Stack response
 * never holds up the cron. Any thrown error is caught and logged but
 * never re-thrown. */
async function pingHeartbeat(url, opts) {
  if (!url) return;
  opts = opts || {};
  const cleanUrl = String(url).trim();
  if (!cleanUrl) return;
  const finalUrl = opts.fail ? cleanUrl.replace(/\/$/, '') + '/fail' : cleanUrl;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEARTBEAT_TIMEOUT_MS);
  try {
    await fetch(finalUrl, { method: 'GET', signal: controller.signal });
  } catch (err) {
    console.error('[observability] heartbeat ping failed (non-fatal):',
      (err && err.message) || err, '| url:', finalUrl);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { pingHeartbeat };
