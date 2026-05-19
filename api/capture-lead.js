/* POST /api/capture-lead
 *
 * Consent-based exit-intent lead capture. The booking.html frontend
 * shows a one-time modal asking "can a rep follow up?" — if the customer
 * clicks YES, the current booking-form state is POSTed here. We insert
 * a row in the `leads` table with status='captured', and if the order
 * is high-value (>= $500 grand total) fire a real-time alert to the
 * business so the team can call right away.
 *
 * No consent = no call = no row. The frontend modal is the *only*
 * trigger for this endpoint.
 *
 * Read-only RLS lockdown on `leads` (service-role only), so this
 * endpoint is the single ingress path. Auth is by intent + same-origin
 * CORS — there's no admin token here because random visitors are the
 * legitimate caller. Basic validation prevents the obvious spam shapes.
 */

const { saveLead } = require('../lib/storage');
const { sendHighValueLeadAlert } = require('../lib/send-emails');
const { initSentryNode, captureException } = require('../lib/observability');
initSentryNode();

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HIGH_VALUE_THRESHOLD = 500;

const ALLOWED_SOURCES = new Set([
  'website_exit_intent',
  'website_exit_intent_mobile',
  'website_stripe_cancel_return',
]);

module.exports = async function handler(req, res) {
  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  /* Outer try/catch + Sentry capture for the public capture endpoint.
     Previously a throw in body parsing or validation logic would 500
     with no context beyond Vercel function logs. Now Sentry receives
     the exception with the source tag (so DJ can see which capture
     surface produced bad data — exit_intent vs stripe_cancel_return)
     plus user_agent for spam-pattern triage. Customer PII fields
     (name/email/phone) intentionally not attached as tags — they
     belong in the request body which beforeSend scrubs, not in
     searchable Sentry tags. */
  try {

  const body = req.body || {};

  /* ── Validate the required fields. Frontend already enforces these
     before showing the modal, but a POST can also come from anywhere
     (a malicious client, a stale cached page, a curl). ── */
  const fullName      = String(body.full_name      || body.fullName      || '').trim();
  const customerEmail = String(body.customer_email || body.email         || '').trim().toLowerCase();
  const phone         = String(body.phone || '').trim();

  if (fullName.length < 2 || fullName.length > 200) {
    return res.status(400).json({ error: 'invalid_full_name' });
  }
  if (!EMAIL_RE.test(customerEmail) || customerEmail.length > 200) {
    return res.status(400).json({ error: 'invalid_email' });
  }
  if (phone && phone.length > 50) {
    return res.status(400).json({ error: 'invalid_phone' });
  }

  /* Charter context (all optional — at exit-intent the customer may
     have only filled in Steps 1-2; we still want to capture them). */
  const date = body.date ? String(body.date).slice(0, 10) : null;
  // Sanity-check date: only accept YYYY-MM-DD shapes; ignore garbage.
  const dateClean = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;

  const partySize = body.party_size !== undefined && body.party_size !== null && body.party_size !== ''
    ? parseInt(body.party_size, 10) : null;

  function num(v) {
    if (v === undefined || v === null || v === '') return null;
    const n = parseFloat(v);
    return isFinite(n) ? n : null;
  }

  /* add_ons can arrive either as a plain object (modal POST) or a JSON
     string (mirroring create-checkout's Stripe metadata shape). Coerce
     to a plain object so PostgREST's JSONB column accepts it natively. */
  let addOns = body.add_ons;
  if (typeof addOns === 'string') {
    try { addOns = JSON.parse(addOns); } catch { addOns = null; }
  }
  if (addOns && typeof addOns !== 'object') addOns = null;

  const source = ALLOWED_SOURCES.has(body.source) ? body.source : 'website_exit_intent';

  /* Build the row. Status + captured_at default to 'captured' + NOW()
     in the DB. We never trust client-supplied status. */
  const row = {
    full_name:        fullName,
    customer_email:   customerEmail,
    phone:            phone || null,
    vessel:           body.vessel     || null,
    experience:       body.experience || null,
    date:             dateClean,
    time_slot:        body.time_slot  || body.timeSlot  || null,
    duration:         body.duration   != null ? String(body.duration) : null,
    party_size:       isFinite(partySize) ? partySize : null,
    add_ons:          addOns,
    special_requests: body.special_requests || body.specialRequests || null,
    grand_total:      num(body.grand_total      || body.grandTotal),
    deposit_amount:   num(body.deposit_amount   || body.depositAmount),
    payment_type:     body.payment_type || body.paymentType || null,
    stripe_session_id: body.stripe_session_id || body.stripeSessionId || null,
    payment_intent_id: body.payment_intent_id || body.paymentIntentId || null,
    source,
    user_agent:       (req.headers['user-agent'] || '').slice(0, 500) || null,
  };

  let saved;
  try {
    saved = await saveLead(row);
  } catch (err) {
    console.error('[capture-lead] saveLead failed:', err.message,
      '| email:', customerEmail, '| source:', source);
    return res.status(500).json({ error: 'database_save_failed' });
  }

  if (!saved) {
    console.error('[capture-lead] saveLead returned null — unexpected');
    return res.status(500).json({ error: 'database_save_failed' });
  }

  console.log('[capture-lead] OK',
    'id:', saved.id,
    '| email:', customerEmail,
    '| grand_total:', saved.grand_total,
    '| source:', source);

  /* High-value real-time alert — best-effort, an email failure must not
     undo the capture. The customer's success path is independent. */
  const gt = parseFloat(saved.grand_total || 0);
  if (gt >= HIGH_VALUE_THRESHOLD) {
    try {
      await sendHighValueLeadAlert(saved, 'captured');
      console.log('[capture-lead] high-value alert sent for', saved.id);
    } catch (alertErr) {
      console.error('[capture-lead] high-value alert send FAILED (lead still saved):',
        saved.id, '|', alertErr.message);
    }
  }

  return res.status(200).json({ ok: true, id: saved.id });

  } catch (err) {
    /* Anything uncaught during validation, body parsing, or downstream
       calls lands here. captureException ships to Sentry with source +
       truncated user_agent for spam-pattern triage; existing logging
       paths remain so Vercel function logs still tell the story. */
    const safeSource = (req.body && typeof req.body.source === 'string')
      ? String(req.body.source).slice(0, 80) : 'unknown';
    const safeUA = String(req.headers['user-agent'] || '').slice(0, 120) || 'unknown';
    console.error('[capture-lead] uncaught error:', err.message, err.stack);
    captureException(err, {
      handler:    'capture-lead',
      source:     safeSource,
      user_agent: safeUA,
    });
    if (!res.headersSent) {
      return res.status(500).json({ error: 'unexpected_error' });
    }
  }
};
