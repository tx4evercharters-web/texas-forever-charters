/* lib/observability.js — observability infrastructure for TFC.
 *
 * Phase 1: Better Stack heartbeat pings for Vercel cron monitoring.
 * Each Vercel-declared cron pings its heartbeat URL on successful
 * completion and the `/fail` variant on uncaught errors. Better Stack
 * pages DJ when an expected heartbeat doesn't arrive within the
 * dashboard-configured window — turning silent cron failures into
 * actionable alerts.
 *
 * Phase 2 (this commit): Sentry error tracking with PII-scrubbed
 * context capture. initSentryNode() is called once at module load in
 * each API handler that captures exceptions; captureException(err,
 * context) ships exceptions to Sentry with structured tags;
 * addBreadcrumb(category, message, data) drops state-transition
 * signals into Sentry's event timeline so when an exception fires
 * the breadcrumbs show what happened immediately before. The
 * beforeSend filter scrubs sensitive request bodies, strips
 * Authorization/Cookie headers, redacts URL query-string secrets,
 * and drops expected-401 noise. Stripe webhook URLs get their
 * request body dropped entirely — too PII-heavy, rely on explicit
 * context tags (booking_session_id, payment_intent_id) instead.
 *
 * Defensive contract: every observability call is fire-and-forget.
 * If the monitoring vendor is down, env vars are unset, or the SDK
 * itself throws during init or capture, the calling handler's work
 * runs to completion regardless. No throw from this module is
 * permitted to break production flows. */

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

/* ── Sentry node init + capture helpers ──────────────────────────── */

let sentryNodeModule = null;
let sentryNodeInitialized = false;

/* Lazy require + idempotent init. Each API handler that wants Sentry
   coverage calls this once at module load:

     const { initSentryNode, captureException } = require('../lib/observability');
     initSentryNode();

   Returns the Sentry module on success, null when SENTRY_DSN_API is
   unset (local dev, preview deploys without DSN configured) or when
   the SDK throws during init. Safe to call repeatedly — second-and-
   later calls return the cached module. */
function initSentryNode() {
  if (sentryNodeInitialized) return sentryNodeModule;
  sentryNodeInitialized = true; // mark even on the no-DSN path so callers don't retry

  const dsn = (process.env.SENTRY_DSN_API || '').trim();
  if (!dsn) return null;

  try {
    /* Lazy require so handlers that never call initSentryNode() pay
       no @sentry/node cold-start cost. ~10MB unpacked dep with native
       modules; loading it for an interactive endpoint that doesn't
       need it is wasteful. */
    const Sentry = require('@sentry/node');
    Sentry.init({
      dsn,
      environment:       (process.env.SENTRY_ENVIRONMENT || 'production').trim(),
      tracesSampleRate:  0,  // errors only — no perf traces, free-tier safe
      profilesSampleRate: 0,
      beforeSend:        beforeSendFilter,
    });
    sentryNodeModule = Sentry;
    return Sentry;
  } catch (err) {
    /* init itself should not throw, but if it does (bad DSN format,
       missing peer dep, etc.) we log and continue. Returning null
       means subsequent captureException calls are no-ops. */
    console.error('[observability] Sentry node init failed (non-fatal):', err.message);
    return null;
  }
}

/* Request-body fields that must NEVER ship to Sentry. Anything matching
   one of these keys (at any nesting depth) gets replaced with the
   string "[REDACTED]" by scrubBody. Add new sensitive fields here as
   new write endpoints land — the audit done before this commit found
   many alternate field-name shapes across api/feedback, api/waiver,
   api/capture-lead, etc. that aren't reflected in the original
   customer_email/full_name/phone shape. The denylist below covers
   every PII-bearing field name I could find in current request-body
   parsing across the api/ directory, plus a defensive set of
   alternate-naming conventions (first_name, last_name, customer_phone)
   that aren't currently used but are standard. */
const SENSITIVE_BODY_FIELDS = new Set([
  // Customer identifying — primary shapes
  'full_name', 'customer_email', 'phone',
  // Customer identifying — alternate shapes (feedback.js, capture-lead.js fallback)
  'name', 'email', 'customer_phone', 'first_name', 'last_name',
  // Free-text customer-written content (special_requests already covered)
  'special_requests', 'internal_notes', 'notes', 'comment',
  // Auth / secrets
  'password', 'id_token',
  // Card data (Stripe handles directly; backend never sees raw — defensive)
  'card', 'card_number', 'cc_number', 'credit_card', 'cvv', 'payment_method',
  // Stripe session identifiers (informational but worth scrubbing)
  'stripe_session_id',
  // Location PII (admin handleUpdateBooking allowedFields)
  'city', 'state', 'zip', 'postal_code', 'address', 'street',
  // Waiver-specific (api/waiver.js — every guest fills this in)
  'signer_first_name', 'signer_last_name', 'signer_email', 'signer_phone',
  'date_of_birth', 'digital_signature',
  'organizer_name',
  'guardian_name', 'guardian_relationship',
  'emergency_contact_name', 'emergency_contact_phone', 'emergency_contact_relationship',
]);

function scrubBody(body) {
  if (body == null || typeof body !== 'object') return body;
  if (Array.isArray(body)) return body.map(scrubBody);
  const out = {};
  for (const key of Object.keys(body)) {
    if (SENSITIVE_BODY_FIELDS.has(key)) {
      out[key] = '[REDACTED]';
    } else if (typeof body[key] === 'object' && body[key] !== null) {
      out[key] = scrubBody(body[key]);
    } else {
      out[key] = body[key];
    }
  }
  return out;
}

/* URL query-string secret redaction. Replaces values for ?token=,
   ?password=, ?id_token=, ?secret= (case-insensitive) with [REDACTED]
   while preserving the rest of the URL. */
function scrubUrl(url) {
  if (!url || typeof url !== 'string') return url;
  return url.replace(
    /([?&])(token|password|id_token|secret)=[^&#]*/gi,
    '$1$2=[REDACTED]'
  );
}

/* Scrub Sentry breadcrumbs before they ship.
 *
 * Sentry's default httpIntegration captures outbound HTTP calls (Stripe,
 * Supabase REST, Resend, Mailchimp, Google OAuth verify) as breadcrumbs
 * with data: { url, method, status_code }. Bodies are NOT captured by
 * default in v8 — but URLs may contain query-string secrets, and a
 * future tracing-config change or integration opt-in could start
 * capturing bodies without us noticing.
 *
 * Defense in depth: scrub data.url via scrubUrl, redact any
 * body/payload/requestBody-shaped fields, scrub any Authorization /
 * Cookie / Set-Cookie headers that might sneak through. ui.input
 * breadcrumbs (auto-captured by Sentry browser SDK) are handled
 * separately by the browser-side filter in admin.html. */
function scrubBreadcrumb(crumb) {
  if (!crumb || typeof crumb !== 'object') return crumb;
  if (!crumb.data || typeof crumb.data !== 'object') return crumb;
  const data = { ...crumb.data };
  if (typeof data.url === 'string') data.url = scrubUrl(data.url);
  if ('body'        in data) data.body        = '[REDACTED]';
  if ('payload'     in data) data.payload     = '[REDACTED]';
  if ('requestBody' in data) data.requestBody = '[REDACTED]';
  if (data.headers && typeof data.headers === 'object') {
    const h = { ...data.headers };
    delete h.Authorization; delete h.authorization;
    delete h.Cookie;        delete h.cookie;
    delete h['Set-Cookie']; delete h['set-cookie'];
    data.headers = h;
  }
  return { ...crumb, data };
}

/* Sentry beforeSend filter — runs synchronously on every event before
   it ships. Three responsibilities: drop expected noise, scrub PII
   from request data, strip sensitive headers. Returning null drops
   the event entirely (and is the safe default if anything in this
   function throws — better to drop a Sentry event than leak PII). */
function beforeSendFilter(event, hint) {
  try {
    // Strip sensitive request headers
    if (event && event.request && event.request.headers) {
      const h = event.request.headers;
      delete h.Authorization; delete h.authorization;
      delete h.Cookie;        delete h.cookie;
    }

    // Stripe webhook bodies are PII-heavy by design (full charge breakdowns,
    // customer email, billing details, etc.). Drop entirely; rely on the
    // explicit context tags (booking_session_id, payment_intent_id) that
    // captureException attaches at the call site.
    if (event && event.request && event.request.url &&
        event.request.url.indexOf('/api/stripe-webhook') !== -1) {
      event.request.data = undefined;
    } else if (event && event.request && event.request.data) {
      event.request.data = scrubBody(event.request.data);
    }

    // Scrub URL query string secrets (handler endpoints sometimes pass
    // tokens via query rather than body — admin's portal-link send takes
    // `?token=...` shape, etc.)
    if (event && event.request && event.request.url) {
      event.request.url = scrubUrl(event.request.url);
    }

    // Walk breadcrumbs and scrub each. Sentry's default httpIntegration
    // captures outbound HTTP calls (Stripe, Supabase, Resend, etc.) as
    // breadcrumbs; v8 doesn't capture bodies by default but URLs may
    // contain query-string secrets, and a future tracing-config change
    // could start capturing bodies without us noticing. Defense in depth.
    if (event && Array.isArray(event.breadcrumbs)) {
      event.breadcrumbs = event.breadcrumbs.map(scrubBreadcrumb);
    }

    // Drop expected 401-Unauthorized noise — admin auth failures are
    // normal background traffic (bots, expired sessions, stale tabs).
    // Shipping these would burn free-tier event budget for nothing.
    const err = hint && hint.originalException;
    if (err && err.message && /^Unauthorized$/i.test(String(err.message))) {
      return null;
    }

    return event;
  } catch (filterErr) {
    /* beforeSend itself MUST NOT throw — would prevent the event from
       ever shipping. On filter failure, drop the event entirely
       rather than ship potentially-unscubbed-PII data. */
    console.error('[observability] beforeSend filter threw (dropping event):',
      filterErr.message);
    return null;
  }
}

/* Capture an exception to Sentry with structured TFC context.

   err     — the Error object to capture.
   context — { tagName: value, ... } object. Each key becomes a Sentry
             tag (searchable + filterable in the Sentry UI). The special
             key `user_email` populates Sentry's user object instead of
             a tag. Falsy values are skipped (so passing
             { user_email: undefined } doesn't set an empty user). All
             values are String()'d for SDK compatibility.

   Defensive: NEVER throws. If Sentry is uninitialized (no DSN, init
   failed, etc.) or captureException itself throws, the call is a
   no-op and the caller's flow continues uninterrupted. */
function captureException(err, context) {
  const Sentry = sentryNodeModule;
  if (!Sentry || !err) return;
  try {
    Sentry.withScope(scope => {
      if (context && typeof context === 'object') {
        for (const key of Object.keys(context)) {
          const value = context[key];
          if (value == null || value === '') continue;
          if (key === 'user_email') {
            scope.setUser({ email: String(value) });
          } else {
            scope.setTag(key, String(value));
          }
        }
      }
      Sentry.captureException(err);
    });
  } catch (sentryErr) {
    console.error('[observability] Sentry capture failed (non-fatal):',
      sentryErr.message);
  }
}

/* Breadcrumb logging — drops state-transition signals into Sentry's
   event timeline so when an exception fires, the breadcrumbs show
   what happened immediately before. category groups related crumbs;
   message is the human-readable signal; data is a free-form object
   stored alongside.

   Breadcrumbs are CHEAP — they only ship when an exception fires
   (attached to that event). Use liberally for "X happened" markers
   at key state transitions inside handlers. */
function addBreadcrumb(category, message, data) {
  const Sentry = sentryNodeModule;
  if (!Sentry) return;
  try {
    Sentry.addBreadcrumb({
      category: String(category || 'tfc'),
      message:  String(message || ''),
      level:    'info',
      data:     data || {},
    });
  } catch (sentryErr) {
    console.error('[observability] Sentry breadcrumb failed (non-fatal):',
      sentryErr.message);
  }
}

module.exports = {
  pingHeartbeat,
  initSentryNode,
  captureException,
  addBreadcrumb,
};
