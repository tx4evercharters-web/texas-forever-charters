# Security audit — pre-portal hardening pass

**Date:** 2026-05-15
**Auditor:** Claude Opus 4.7 (read-only audit, no code changes)
**Scope:** Every `api/*.js` endpoint, `lib/*.js`, `vercel.json`, `package.json`, and supporting HTML/JS for client-side admin auth.
**Trigger:** Pre-customer-portal hardening. The upcoming `/booking/<token>` portal will introduce a new unauthenticated PII-exposing surface, so the existing infrastructure that will support it needs a clean baseline first.

## Severity legend

- **CRITICAL** — Active exploitation possible now with modest effort; PII/money at risk.
- **HIGH** — Exploitable with a leaked artifact (URL, session id, etc.) or under common misuse; PII exposure or unauthorized action.
- **MEDIUM** — Conditional or defense-in-depth gap; matters under specific conditions or near-future changes.
- **LOW** — Best-practice deviation; matters as the codebase grows.
- **INFORMATIONAL** — Observation, no fix required.

Each finding's **Pre-portal blocker** field marks whether it must be addressed before launching `/booking/<token>`.

---

## 1. API endpoint authorization

The `api/` directory contains 14 endpoint files. Auth model summary:

| Endpoint | Methods | Auth model | Recipient of side effects |
|---|---|---|---|
| `api/admin.js` | POST/GET/DELETE via `?action=` router | Bearer token (HMAC, see §10) — except `login` action which is the password handshake | DB writes (bookings, customers, blackouts, leads, waivers via storage), Stripe writes (refunds, charges, payment links, damage holds) |
| `api/stripe-webhook.js` | POST | Stripe signature verification (HMAC over raw body, see §3) | DB writes, customer + admin emails, Stripe damage hold creation |
| `api/cron-reminders.js` | (Implicit GET from Vercel cron) | `Authorization: Bearer <CRON_SECRET>` OR `x-cron-secret: <CRON_SECRET>` (constant-time string equality, not timing-safe) | DB writes, customer + admin emails, lead retention sweep |
| `api/create-checkout.js` | POST | Public (anyone) | Stripe checkout session creation; Supabase duplicate-check read |
| `api/availability.js` | GET | Public | None (read-only) |
| `api/waiver.js` | GET/POST | Public; POST is IP-rate-limited (20/hour) | DB write to `waivers` table; customer + admin emails |
| `api/feedback.js` | POST | Public | Admin email |
| `api/subscribe.js` | POST | Public | Mailchimp PUT; customer welcome email |
| `api/capture-lead.js` | POST | Public (intentional — only ingress for `leads` table) | DB write to `leads`; admin alert if high-value |
| `api/chat.js` | POST | Public | Anthropic API call (server-side prompt enforced) |
| `api/send-confirmation.js` | POST | Public | Stripe session read; customer + admin emails |
| `api/resend-confirmation.js` | POST | Public | DB write (`customer_email` override + `confirmation_email_sent` flag); customer + admin emails |
| `api/get-checkout-session.js` | GET | Public (relies on `session_id` opacity) | None (read-only Stripe + DB lookup) |
| `api/env-check.js` | GET | Public by design (post-deploy probe) | None (returns env-var presence booleans only) |

### 1.1 `api/admin.js` — admin router auth model
`api/admin.js:1287-1296` — the dispatcher correctly gates every action except `login` behind `requireAuth(req, res)`. The `PUBLIC_ACTIONS` set at line 1253 contains only `login`. Every other action (`bookings`, `add-blackout`, `mark-paid`, `update-booking`, `charge-remaining`, `send-payment-link`, `customer-search`, `add-booking`, `customers`, `update-customer`, `create-customer`, `delete-customer`, `import-bookings`, `cancel-booking`, `refund-booking`, `release-damage-hold`, `capture-damage-charge`, `list-waivers`, `send-waiver-link`, `waivers`, `leads`, `mark-lead-contacted`, `find-bookings-for-lead`) requires a valid Bearer token before the handler runs. No bypass observed.

### 1.2 `api/get-checkout-session.js` — PII exposure via leaked session_id

**Severity: HIGH**
**Location:** `api/get-checkout-session.js:1-59`
**Description:** This endpoint is unauthenticated and accepts any `session_id` starting with `cs_`. It returns the full Stripe checkout session including `customer_email` and the full `metadata` object (which contains `full_name`, `phone`, `party_size`, `date`, `time_slot`, `charter_name`, `special_requests`, `terms_agreed_at`, etc.). Anyone who learns a customer's Stripe checkout session id (from a leaked URL screenshot, browser history, a forwarded email, server log access, etc.) can retrieve that customer's PII and booking details.

For contrast, `api/waiver.js:35-74` (`handleGetInfo`) implements the same lookup pattern correctly: it explicitly whitelists return fields and the comment at line 34 says "Anything else (email, phone, payment, totals) is stripped from the response, so a leaked session_id can't expose PII or money data." That same principle is not applied here.

**Recommendation:** Restrict the response to the minimum set the confirmation page actually renders. Cross-reference `booking-confirmation.html:730` to enumerate which fields the page uses, and strip the rest. At minimum, `customer_email` and `phone` should never come back from this endpoint — the page already has the customer's email through the email itself.

**Pre-portal blocker: YES.** The customer portal will use a tokenized URL pattern; if this endpoint's "leaked id → full PII" pattern is left in place, the portal's hardening effort is undone by an adjacent endpoint with the same shape.

### 1.3 `api/resend-confirmation.js` — unauthenticated mutation of customer_email
**Severity: HIGH**
**Location:** `api/resend-confirmation.js:43-54`
**Description:** This endpoint is unauthenticated, accepts a `session_id` and an `email` override, and *patches the booking row's `customer_email` field* to whatever the caller provides before re-sending the confirmation email. The endpoint validates the email shape but does not verify that the caller is the original customer or an admin. Anyone with a `session_id` can:

1. Change the recorded customer email on the booking row to an attacker-controlled address.
2. Re-send the full confirmation email (with charter details and a waiver link) to that address.

The DB write is permanent — the original `customer_email` is overwritten. Future admin emails, reminders, and waiver links will go to the attacker's address until an admin notices and corrects it manually.

This is a higher-impact variant of finding 1.2.

**Recommendation:** Either (a) remove the email override capability entirely and only re-send to the current `booking.customer_email`, or (b) add admin-token gating to the override path while keeping the re-send-to-current-email path public. Option (a) is simpler and lower risk. If admin needs to correct an email, that's already supported through the admin panel's update-booking flow.

**Pre-portal blocker: YES.**

### 1.4 `api/send-confirmation.js` — unauthenticated re-trigger
**Severity: MEDIUM**
**Location:** `api/send-confirmation.js:18-22, 67-69`
**Description:** Public POST endpoint that accepts a `session_id`, looks up the Stripe checkout session, and re-sends both the customer confirmation AND business notification emails. There's no rate limit and no auth. An attacker with a `session_id` can repeatedly trigger this to:

1. Email-bomb the customer's inbox.
2. Email-bomb the business inbox (each call generates a "New Booking" notification to `tx4evercharters@gmail.com`).
3. Burn Resend quota.

The same `session_id` is the only required parameter — no recaptcha, no rate limiting, no honeypot.

**Recommendation:** Add per-session-id rate limiting (e.g., max 1 send per 60 seconds) or gate behind admin token. Or remove this endpoint entirely if `api/resend-confirmation.js` covers the same need (it does, per the duplicate functionality observed across both files).

**Pre-portal blocker: NO** (operational annoyance, not a data breach), but high-priority for general hygiene.

### 1.5 Public mutation endpoints — abuse surface

The following endpoints are publicly POST-able and write to the DB. Documented here so future audits have the inventory:

- `api/create-checkout.js` — writes Stripe sessions, can be invoked anonymously; price-mismatch guard at lines 109-126 prevents customer-driven discount tampering.
- `api/waiver.js` — writes `waivers` rows; rate-limited 20/hour/IP at line 14 + 83.
- `api/feedback.js` — emails only, no DB write; could be abused for email bomb to business inbox (see §9.2).
- `api/subscribe.js` — Mailchimp PUT + welcome email; could be abused for email-bomb against arbitrary addresses (see §9.3).
- `api/capture-lead.js` — writes `leads` row + optional admin alert; could be abused for DB bloat + alert spam (see §9.4).
- `api/chat.js` — Anthropic API proxy; could be abused for free LLM usage (see §9.5).

---

## 2. Supabase Row-Level Security audit

### 2.1 Key usage — service-role only

**Severity: INFORMATIONAL (positive finding)**
**Location:** `lib/storage.js:13-50`, mirrored in `api/cron-reminders.js:18-52` and `api/create-checkout.js:16-61`.

Every Supabase REST call in this codebase uses `SUPABASE_SECRET_KEY` (the service-role key) via the shared `request()` helper. There is **zero** use of any anon/publishable Supabase key. There is **zero** frontend Supabase access — the browser never holds a Supabase URL or key. All DB access flows through the server-side API.

This means:
- The frontend cannot leak a key.
- RLS policies on Supabase do not affect what this codebase reads/writes (service role bypasses RLS by design).
- The endpoints themselves are the only authorization gate.

Confirmed by `Grep` for `SUPABASE_ANON|SUPABASE_PUBLISHABLE|anon[-_]key` returning no matches.

### 2.2 Tables touched
From `lib/storage.js`:
- `bookings` (line 67, 90, 116, 127, 133, 139, 146, 164, 308, 495, 532, 552, 837)
- `blackouts` (line 175, 195, 207, 215)
- `customers` (line 252, 265, 274, 299, 309, 317, 322, 359, 376, 389, 439, 456)
- `waivers` (line 632, 643, 647, 661, 701)
- `leads` (line 738, 754, 763, 772, 783, 797, 808, 866)

All access is through `request()` with the service-role key. No table is touched via any other path.

### 2.3 RLS dependency
**Severity: LOW (defense-in-depth observation)**
The capture-lead doc comment at `api/capture-lead.js:13` notes "Read-only RLS lockdown on `leads` (service-role only), so this endpoint is the single ingress path." This suggests RLS policies exist on the `leads` table that block anon access. If the same pattern holds for `bookings`, `customers`, and `waivers` (RLS enabled with no anon policies), then a future accidental anon-key exposure on the frontend would not immediately drain the database.

**Recommendation:** This audit can't confirm RLS state without querying Supabase. Verify in the Supabase dashboard that all five tables have RLS enabled with no anon-role policies. Document in a separate ops doc.

**Pre-portal blocker: NO** (current architecture doesn't expose anon key anywhere).

---

## 3. Webhook signature verification

**Severity: INFORMATIONAL (positive finding)**
**Location:** `api/stripe-webhook.js:218-248`

The handler enforces signature verification correctly:

1. Line 226-228: rejects non-POST with 405.
2. Line 230-234: rejects missing `stripe-signature` header with 400.
3. Line 236-239: rejects when `STRIPE_WEBHOOK_SECRET` env var is unset with 500 (no fallback to "allow unsigned").
4. Line 241-248: calls `stripe.webhooks.constructEvent()` with the raw body. Any signature mismatch throws and returns 400 before any DB write.

Crucially, `module.exports.config = { api: { bodyParser: false }}` at line 24 disables Vercel's automatic body parsing — required because signature verification must operate on the raw byte stream.

Every DB write (`saveBookingWithRetry`, `patchBooking`, `patchLead`) and every email side effect occurs **after** the signature check at line 244. No code path processes webhook data before verification.

**Pre-portal blocker: NO** (correctly implemented).

---

## 4. Token / ID generation audit

### 4.1 Admin session token — HMAC over timestamp
**Severity: MEDIUM**
**Location:** `lib/auth.js:5-9` (generation), `lib/auth.js:11-26` (verify)

The admin auth token format is `<sha256-hmac>.<timestamp-ms>` where the HMAC uses `ADMIN_PASSWORD` as the secret and `Date.now().toString()` as the message. The token verifies as valid for 7 days from issuance (`TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000`).

Issues:
1. **The HMAC is over the timestamp only.** It does not bind to a user identity, session id, IP, or any other context. Since there is only one admin user, this is functionally equivalent to "any token issued in the last 7 days." That's an intentional design choice given the single-admin model.
2. **No revocation mechanism.** If a token is leaked (e.g., from localStorage via XSS, see §10), there is no way to invalidate it short of rotating `ADMIN_PASSWORD` — which invalidates *all* tokens, including the legitimate session.
3. **`crypto.timingSafeEqual`** is correctly used at line 22 for the comparison.
4. **No nonce.** Two tokens issued within the same millisecond would be identical. Practically impossible with single-admin sequential issuance, but a defense-in-depth gap.

**Recommendation:** For pre-portal scope, this is acceptable. Post-portal, consider adding a server-side token-revocation list (Redis or a Supabase `admin_sessions` table) so a logout actually invalidates the token.

**Pre-portal blocker: NO.**

### 4.2 Session IDs for manual bookings — `Math.random` is insufficient entropy
**Severity: HIGH**
**Location:** `lib/storage.js:415` and `lib/storage.js:506`

```js
'historical_' + Date.now() + '_' + i + '_' + Math.random().toString(36).slice(2, 6)  // 4 base36 chars ≈ 20 bits
'manual_'     + Date.now() + '_' +     Math.random().toString(36).slice(2, 8)        // 6 base36 chars ≈ 31 bits
```

Both use `Math.random()` which is NOT cryptographically secure. Worse, both have low entropy (20-31 bits of randomness on top of a predictable timestamp).

**Why this matters for the portal:** The upcoming `/booking/<token>` portal will need an unguessable identifier. If the portal lookup also accepts session_id (the path of least resistance), then a `manual_<timestamp>_<6chars>` id can be brute-forced in seconds — the timestamp is known to ~1-minute precision (booking_at column is queryable, and weekly admin patterns make even the hour guessable), and 6 base36 chars is only ~2 billion possibilities. An attacker with 1000 RPS could enumerate the entire keyspace for a known-day booking in under a day.

The `bookings.session_id` column is currently used as the primary join key in `findBookingBySessionId`, which is invoked by `api/waiver.js`, `api/feedback.js`, `api/resend-confirmation.js`, `api/get-checkout-session.js` — all unauthenticated endpoints. Stripe-issued session_ids (`cs_test_*`, `cs_live_*`) have ~256 bits of entropy and are not enumerable; **admin-created** session_ids have ~30 bits.

This is a portal-blocker because the portal can't reuse `session_id` as the unguessable identifier without also fixing the manual/historical generation.

**Recommendation:** Replace both occurrences with `crypto.randomBytes(16).toString('hex')` (128 bits, hex-encoded for URL safety). Keep the `manual_` / `historical_` prefix so admin can still distinguish in logs:

```js
'manual_'     + Date.now() + '_' + require('crypto').randomBytes(16).toString('hex')
'historical_' + Date.now() + '_' + i + '_' + require('crypto').randomBytes(16).toString('hex')
```

Run a follow-up migration script that backfills existing low-entropy `manual_*` and `historical_*` session_ids with new high-entropy values if any unauthenticated endpoint will accept them as portal lookups. (Stripe-issued ones don't need migration.)

**Pre-portal blocker: YES.**

### 4.3 No customer-portal token column yet
**Severity: INFORMATIONAL (gap analysis)**
**Location:** Schema (Supabase `bookings` table)

Confirmed via `Grep public_token|portal_token|customer_token` returning no matches: there is no portal-suitable token column in the `bookings` table today. The portal will need to either:

(a) Add a new column `portal_token` to `bookings` (e.g., `text unique`), generated via `crypto.randomBytes(32).toString('hex')` at booking creation (64 hex chars = 256 bits).
(b) Reuse `session_id` after the §4.2 fix lands.

Option (a) is cleaner — it separates the Stripe identifier from the portal identifier, lets you rotate the portal token without touching Stripe, and lets you scope portal access (e.g., expire it post-charter). Option (b) is faster but couples concerns.

**Recommendation:** Add `portal_token` column. Generate at booking creation. Use it for the `/booking/<token>` route. Do not allow portal access by `session_id`.

**Pre-portal blocker: This IS the portal infrastructure decision** — call it before portal implementation starts.

---

## 5. Hardcoded secrets / credentials scan

### 5.1 Codebase scan — clean
**Severity: INFORMATIONAL (positive finding)**

`Grep` for `sk_(test|live)_|pk_(test|live)_|rk_(test|live)_` across the repo: zero matches in production code paths. Two appearances:
- `diagnose-sandbox-bookings.js:11-65` — usage instructions and validation regex; no actual key values.
- `node_modules/stripe/` — third-party test fixtures, not our code.

`Grep` for `(api[_-]?key|secret|token|password)\s*[:=]\s*['"]` across `**/*.{js,json,html}`: zero matches in our code; node_modules-only.

`Grep` for `SUPABASE_ANON|SUPABASE_PUBLISHABLE`: zero matches.

All API keys flow through `process.env.*` exclusively.

### 5.2 .env files — not committed
**Severity: INFORMATIONAL (positive finding)**

`git ls-files | grep -iE "\.env"` returned no results. No `.env`, `.env.local`, `.env.production` files are checked into git. The `.gitignore` does NOT explicitly list `.env*`, but the absence of committed files indicates the workflow has avoided committing them.

### 5.3 .gitignore — missing `.env*` rule
**Severity: LOW**
**Location:** `.gitignore:1-7`

The `.gitignore` currently lists only `.vercel` and large video files. There is no rule for `.env*` files. If a developer ever creates `.env.local` for local testing, it would be staged and potentially committed.

**Recommendation:** Add to `.gitignore`:
```
.env
.env.local
.env.*.local
```

**Pre-portal blocker: NO** (preventative).

### 5.4 `lib/send-emails.js` — no hardcoded API keys
**Severity: INFORMATIONAL (positive finding)**

The Resend API key is read at request time via `process.env.RESEND_API_KEY` (called in `postToResend` and inline in `api/subscribe.js:70`). No hardcoded fallback. The `FROM_EMAIL` constant at the top of the file is a display string, not a secret.

---

## 6. PII handling in logs

### 6.1 Customer email in log lines — pervasive
**Severity: MEDIUM**
**Location:** `lib/send-emails.js` (28 instances), `api/cron-reminders.js:296, 381`, `api/resend-confirmation.js:49, 111`, `api/waiver.js:150, 155, 177, 181`

Many `console.log` and `console.error` calls include the customer's email address alongside the session id. Example: `lib/send-emails.js:770` —
```js
console.log('[send-emails] Sending cancellation email to:', booking.customer_email, 'session:', booking.session_id);
```

This is operationally useful (the log line lets the team trace a specific customer's flow) but it does mean customer email addresses are committed to Vercel function logs. Vercel logs are retained per platform policy and accessible to anyone with project access.

This isn't a code defect — every system needs some trace logging — but it's an observation about the privacy boundary. If the team adds an external log aggregator (Datadog, Logflare, Sentry), the email PII flows there too.

**Recommendation:**
- Document Vercel log retention in the privacy policy if not already (`privacy.html:218` lists analytics but not the log surface).
- Consider redacting customer email in the cron reminder/digest paths where it's not needed for debugging (the session id alone is enough to look up the row).
- Don't log `payment_method_id`, full card metadata, or `digital_signature` — none of those appear in current log calls (checked).

**Pre-portal blocker: NO.**

### 6.2 ADMIN_PASSWORD never logged
**Severity: INFORMATIONAL (positive finding)**

`Grep ADMIN_PASSWORD` returned three matches: the env-check whitelist, the auth check at `lib/auth.js:12`, and the login handler at `api/admin.js:47-49`. Login error case never echoes the password back. The token verify path does not log the password value either. Clean.

### 6.3 No credit card numbers in logs
**Severity: INFORMATIONAL (positive finding)**

Stripe's library handles all card data — the codebase only sees `payment_method_id` (an opaque Stripe ref). No `card_number`, `cvv`, or `last4` raw values appear in log calls. Clean.

### 6.4 Waiver `digital_signature` not logged
**Severity: INFORMATIONAL (positive finding)**

`api/waiver.js` and `lib/send-emails.js` (waiver paths) do not log the signature string itself. Clean.

---

## 7. CORS audit

### 7.1 Wildcard CORS on public endpoints — acceptable, but flagged
**Severity: LOW**
**Locations:**
- `api/availability.js:4`
- `api/capture-lead.js:23`
- `api/chat.js:4`
- `api/feedback.js:8`
- `api/create-checkout.js:8`
- `api/env-check.js:24`
- `api/waiver.js:9`
- `api/resend-confirmation.js:5`
- `api/send-confirmation.js:5`
- `api/subscribe.js:6`
- `api/get-checkout-session.js:5`

Eleven public endpoints set `Access-Control-Allow-Origin: *`. Because none of them require credentials (no `Authorization` header from the frontend, no signed cookies), the wildcard is acceptable per the browser CORS spec — browsers won't send credentials with a wildcard origin.

The combined risk profile depends on what each endpoint accepts (see findings 1.2, 1.3, 1.4 above for the actually problematic public surface).

### 7.2 `api/admin.js` — no CORS headers
**Severity: INFORMATIONAL (positive finding)**

The admin endpoint correctly does NOT set `Access-Control-Allow-Origin`. Combined with the `Authorization: Bearer` header model, this means:
- Same-origin (`texasforevercharters.com`) calls work.
- Cross-origin browser calls are blocked at preflight.
- Direct curl/Node clients with the token still work (they're not browser-gated).

No misconfiguration here.

### 7.3 `api/stripe-webhook.js` — no CORS, correct for server-to-server
**Severity: INFORMATIONAL (positive finding)**

No CORS headers needed — Stripe calls server-to-server, not from a browser. Correctly absent.

### 7.4 `api/cron-reminders.js` — no CORS, correct
**Severity: INFORMATIONAL (positive finding)**

Vercel cron is also server-to-server. Correctly absent.

---

## 8. Input validation audit

### 8.1 PostgREST URL-encoding — universally applied
**Severity: INFORMATIONAL (positive finding)**

49 calls to `encodeURIComponent()` across `api/create-checkout.js`, `api/cron-reminders.js`, `lib/storage.js`, `lib/send-emails.js`. Every user-supplied value passed into a PostgREST `eq.`, `ilike.`, `in.(...)`, `gte.`, or similar filter is URL-encoded first. This is the correct injection mitigation for PostgREST.

Spot-checked:
- `lib/storage.js:120` (patchBooking): `'/bookings?session_id=eq.' + encodeURIComponent(session_id)` ✓
- `lib/storage.js:317` (searchCustomers): `'%' + q.toLowerCase() + '%'` then `encodeURIComponent` ✓ (literal `%` from the user becomes `%25` after encoding, so user can't inject extra wildcards into the SQL operator)
- `lib/storage.js:838` (findBookingsForLead): each filter pre-built then `filters.join(',')` after encoding ✓
- `api/cron-reminders.js:174, 222, 249, 282` (cron PATCH paths) ✓

### 8.2 Eval / child_process — absent
**Severity: INFORMATIONAL (positive finding)**

`Grep eval|child_process|execSync|exec\(|spawn\(` across `{api,lib}/**/*.js` returned zero matches. No code-injection surfaces.

### 8.3 Stripe metadata truncation — applied consistently
**Severity: INFORMATIONAL (positive finding)**

`api/create-checkout.js:170-172` and `api/admin.js:390` both define a `truncate()` helper that caps strings at 500 chars (490 for `special_requests`). Stripe metadata values would error out at the 500-char limit otherwise. Consistent application across both code paths.

### 8.4 Length caps on user input
**Severity: LOW**
**Locations:**
- `api/capture-lead.js:48-60` — `full_name`, `customer_email`, `phone`, `user_agent` are all length-bounded.
- `api/feedback.js:44, 46-47` — `comment` capped at 4000, `name` at 200, `email` lowercased and trimmed.
- `api/admin.js:1218, 1228` — lead notes capped at 2000.
- `api/waiver.js` — `signer_first_name`, `signer_last_name`, `digital_signature` are trimmed but NOT length-capped before insertion.
- `api/resend-confirmation.js:24-26` — email override is regex-validated but the regex (`/^[^\s@]+@[^\s@]+\.[^\s@]+$/`) doesn't enforce a max length. A 10MB email-shaped string would pass validation.

**Recommendation:** Add `.slice(0, 200)` after email validation in `resend-confirmation.js` (line 20 area), and `.slice(0, 200)` on `signer_first_name`/`signer_last_name` in `api/waiver.js:125-126` (before `.trim()`). Cap `digital_signature` at 200 too (line 138).

**Pre-portal blocker: NO.**

### 8.5 add_ons JSON parsing — defensive
**Severity: INFORMATIONAL (positive finding)**

`api/capture-lead.js:80-84` and `lib/storage.js:54` both wrap `JSON.parse` in try/catch and fall back gracefully on malformed input. Good defensive coding.

---

## 9. Rate limiting audit

### 9.1 `api/waiver.js` POST — IP rate-limited
**Severity: INFORMATIONAL (positive finding)**
**Location:** `api/waiver.js:14, 77-90`

Rate limit: 20 waivers per IP per hour, enforced by counting `waivers.ip_address` rows in the last hour. Soft-fail: if the rate-limit query itself fails, the waiver is accepted rather than dropped. Reasonable tradeoff for a low-volume legal-compliance surface.

### 9.2 `api/feedback.js` — NO rate limit
**Severity: MEDIUM**
**Location:** `api/feedback.js`

Public POST with no rate limiting. Each call sends one email to `BUSINESS_EMAIL` (`tx4evercharters@gmail.com`). An attacker can email-bomb the business inbox at the cost of one HTTP request per email.

**Recommendation:** Add per-IP rate limit (e.g., 10 feedback submissions per IP per hour). Mirror the `countWaiversByIpInLastHour` pattern. Since there's no `feedback` table to count from, either (a) add one with `ip_address` + `submitted_at`, or (b) use the simpler approach of storing IP-keyed counters in a future `request_rate` table.

**Pre-portal blocker: NO** (operational annoyance, not a data breach), but worth fixing before any future marketing push that might attract attention.

### 9.3 `api/subscribe.js` — NO rate limit
**Severity: MEDIUM**
**Location:** `api/subscribe.js:11-25`

Public POST that accepts an email and sends a welcome email containing the `LAKELIFE10` promo code. An attacker can:
- Spray arbitrary email addresses with welcome emails (Mailchimp + Resend), making this site look like a phishing source. Resend may eventually flag the domain.
- Burn Mailchimp and Resend quota.

**Recommendation:** Same as 9.2 — add per-IP rate limiting (5-10/hour seems reasonable for newsletter signup).

**Pre-portal blocker: NO**, but high-priority general hygiene.

### 9.4 `api/capture-lead.js` — NO rate limit
**Severity: MEDIUM**
**Location:** `api/capture-lead.js:37-145`

Public POST that writes a `leads` row and fires a high-value alert if `grand_total >= $500`. Without a rate limit, an attacker can:
- Stuff the `leads` table with junk rows (DB bloat).
- Spam the business inbox with high-value alerts (set `grand_total: 999` in the payload).

The 90-day retention sweep in cron-reminders eventually cleans up non-converted leads, but in the interim it's noise.

**Recommendation:** Same per-IP rate limit pattern (e.g., 3 lead captures per IP per hour — leads should be rare from a single user).

**Pre-portal blocker: NO.**

### 9.5 `api/chat.js` — NO rate limit
**Severity: HIGH**
**Location:** `api/chat.js:82-149`

Public POST that proxies to the Anthropic API. No rate limit, no auth. An attacker can:
- Burn the `ANTHROPIC_API_KEY` quota by repeatedly calling the chatbot endpoint with arbitrary `messages` arrays.
- Send arbitrarily long `messages` arrays (no size cap) and arbitrary `max_tokens` values (capped at the request's `max_tokens` field, not a server-side ceiling).

`max_tokens` defaults to 512 but accepts any client-supplied number (line 99 — `typeof incoming.max_tokens === 'number' ? incoming.max_tokens : 512`). A client could request 200000 tokens per call.

This is a direct cost-vulnerability — an attacker can run up an Anthropic bill measured in dollars-per-minute.

**Recommendation:**
- Cap `max_tokens` server-side at a sensible ceiling (e.g., 1024).
- Cap `messages` array length (e.g., 30 turns).
- Add per-IP rate limit (e.g., 20 messages per IP per hour, 100/day).
- Consider an interactive captcha / proof-of-work for high-volume IPs.

**Pre-portal blocker: NO** (independent of portal), but should be addressed soon.

### 9.6 `api/admin.js` login — NO rate limit / lockout
**Severity: MEDIUM**
**Location:** `api/admin.js:43-59`

The login handler does `crypto.timingSafeEqual` (good — line 54) but has no rate limit or account lockout. The password is a single shared secret (`ADMIN_PASSWORD`); an attacker who learns the URL can brute-force at whatever rate the Vercel function will sustain.

Mitigating factors: the password is presumed strong (admin-chosen), and `crypto.timingSafeEqual` prevents timing-based byte-by-byte exfiltration.

**Recommendation:** Add per-IP rate limit on `?action=login` (5 attempts per IP per 10 minutes is standard). On 5 failures, lock out for 1 hour. Log all login failures to a `login_attempts` table so brute-force patterns are visible to an admin.

**Pre-portal blocker: NO.**

### 9.7 Other endpoints with rate-limit gaps
- `api/create-checkout.js` — no rate limit, but writes a Stripe Checkout Session (not a DB row directly). Side effects bounded by Stripe's own rate limits.
- `api/availability.js` — read-only, low-cost DB query. Acceptable without rate limit.
- `api/get-checkout-session.js` — read-only Stripe lookup; also see finding 1.2 for the PII issue separate from the rate-limit question.
- `api/resend-confirmation.js` and `api/send-confirmation.js` — see 1.3 and 1.4 above; rate-limit gap compounds the email-bomb risk.
- `api/env-check.js` — no rate limit, intentionally public probe. Low risk; returns only booleans.

---

## 10. Admin authentication review

### 10.1 Password storage — env var only
**Severity: INFORMATIONAL (positive finding)**
**Location:** `lib/auth.js:12`, `api/admin.js:47`

The admin password is stored solely in the Vercel env var `ADMIN_PASSWORD`. It is never written to the DB, never hashed-at-rest in the codebase (because it never persists to disk in the codebase), never logged. The login handler does a constant-time byte comparison with the env var value at `api/admin.js:52-54`.

This is acceptable for the single-admin model. Multi-admin would require switching to a `users` table with bcrypt-hashed passwords.

### 10.2 Token mechanism — HMAC + localStorage
**Severity: MEDIUM**
**Location:** `lib/auth.js:5-26` + `admin.html:3049-3061`

The token is HMAC-over-timestamp, stored in `localStorage` under key `tfc_admin_token`. Implications:
- **XSS vulnerability:** any XSS on `admin.html` exfiltrates the token. The token is bearer-only — possession = authentication for 7 days.
- **Token theft via dev tools / shared computer:** anyone who opens DevTools on a logged-in admin's browser can read the token in plaintext.
- **No HTTP-only flag possible:** because the token is in localStorage (not a cookie), it cannot be marked HttpOnly.

Mitigating factors:
- `admin.html` does not appear to render user-supplied HTML directly (spot-checked — admin rendering uses `textContent` and explicit escapeHtml-style helpers).
- The admin surface is at `/admin.html`, which is publicly reachable but not linked from any public page.

**Recommendation:** For the single-admin model, this is workable. Two long-term improvements:
1. Move the token into a signed HTTP-only cookie (eliminates the XSS exfil path).
2. Add a server-side revocation list so logout actually invalidates the token (see §4.1).

**Pre-portal blocker: NO** (current state).

### 10.3 Session timeout — 7 days, no sliding renewal
**Severity: LOW**
**Location:** `lib/auth.js:3, 19`

`TOKEN_TTL_MS = 7 days`. Tokens expire 7 days after issuance with no sliding renewal. An admin who logs in once gets exactly 7 days, then is prompted to log in again. This is reasonable.

### 10.4 No lockout policy
See finding 9.6.

### 10.5 No 2FA
**Severity: LOW**
**Location:** entire auth flow

No multi-factor authentication. For the single-admin model with a strong password and limited attack surface (`/admin.html` is not enumerated anywhere), this is acceptable. Adding TOTP-based 2FA would be a meaningful improvement if the threat model evolves (e.g., if more people gain admin access).

**Pre-portal blocker: NO.**

---

## 11. Customer portal pre-audit

### 11.1 Token column — does not exist yet
See finding 4.3. The `bookings` table needs a `portal_token` column before the portal can launch.

### 11.2 Safe token generation pattern — partial
See finding 4.2. The manual/historical session_id generation needs to move to `crypto.randomBytes` before the portal launches. The portal's `portal_token` column itself should use `crypto.randomBytes(32).toString('hex')` (256 bits = practically unguessable).

### 11.3 Proposed portal auth model
Reading between the lines of the existing `/api/waiver?session_id=X` pattern (which already implements the "leaked-id-can't-expose-PII" model correctly), the portal should follow the same shape:

- **Auth model:** Token-only (no user account). The token in the URL IS the credential.
- **Endpoint:** New `api/customer-portal.js` with GET (fetch booking) and POST (limited mutations — e.g., update party_size, reschedule request, cancellation request).
- **Lookup key:** `bookings.portal_token` (new column), not `session_id`. Rationale: lets you rotate the portal token without touching Stripe, and lets you scope/expire it (e.g., revoke 24h post-charter).
- **Response shape:** Whitelist fields, never return raw row. Mirror `api/waiver.js:35-74`'s approach.
- **Rate limit:** Per-token rate limit on mutations (e.g., 10 modifications per portal_token per day).
- **No cross-token access:** Token A can only see booking A. Validate this in the handler.

### 11.4 Things the portal must NOT do
- Must NOT accept `session_id` as an alternate lookup key (defeats §4.2's mitigation).
- Must NOT return `customer_email`, `phone`, `stripe_customer_id`, `payment_method_id`, `payment_intent_id`, `damage_hold_intent_id` in any GET response. The customer knows their own email; the portal doesn't need to confirm it back.
- Must NOT allow the customer to change their email through the portal (use admin-only flow for that — addresses §1.3).
- Must NOT allow the customer to change pricing, dates, or vessel without admin involvement (those become refund / cancel / new-booking requests routed to admin).

**Pre-portal blocker: This entire section IS the portal design checklist.**

---

## 12. Dependency audit

### 12.1 `package.json` — pinned major, floating minor
**Severity: LOW**
**Location:** `package.json:5-8`

```json
"stripe": "^16.0.0",
"@vercel/blob": "^0.27.0"
```

Both use caret ranges. `^16.0.0` accepts any 16.x release; `^0.27.0` for a 0.x version accepts only 0.27.x (npm's special handling of pre-1.0 caret).

**Recommendation:** For a single-developer project this is fine. For a production checkout flow, consider exact-pinning (`"stripe": "16.0.0"`) so dependency updates require an intentional bump.

### 12.2 No `package-lock.json`
**Severity: MEDIUM**
**Location:** Repo root

`Glob package-lock.json` returned no results. The repo has no committed lockfile. Implications:
- Every fresh `npm install` may resolve to slightly different transitive dependency versions.
- Vercel's build may install different transitive versions than the developer's local env.
- Supply-chain audits (`npm audit`) can't reliably pin known-vulnerable versions.
- Reproducibility of any past production deploy degrades over time.

**Recommendation:**
1. Run `npm install` once locally.
2. Commit the generated `package-lock.json`.
3. Use `npm ci` instead of `npm install` in Vercel's build settings (or keep `npm install` — npm 7+ respects the lockfile for `install` too).

This is a meaningful hygiene gap. Not blocking the portal, but should be fixed regardless.

**Pre-portal blocker: NO.**

### 12.3 Supply-chain attack surface
Stripe and `@vercel/blob` are both widely-used Node packages with active security maintenance from their respective vendors. Risk profile is low.

`node_modules` brings in additional transitive packages (visible in the file scan: `undici`, `retry`, `qs`, `object-inspect`, `es-errors`, `function-bind`, `has-symbols`, `side-channel*`, `@fastify/busboy`, `async-retry`, `is-buffer`, `throttleit`, etc.). None of these were individually audited here; the standard advice applies — run `npm audit` periodically once the lockfile is committed.

---

## 13. Environment hygiene crosscheck

Cross-referenced with `docs/queue/env-var-hygiene.md` (commit 917511a).

The five items in that queue doc are all dashboard organization issues, not security defects. Specifically:

| Item | Security implication |
|---|---|
| 1. 11 stale `GOOGLE_REVIEW_URL` Preview-branch entries | None. Public URL value, not a secret. |
| 2. 11 stale `CRON_SECRET` Preview-branch entries | **LOW.** Each stale entry is a separate revocable copy of the cron secret. If any old Preview branch was ever deployed and the function still exists, that secret may grant cron access. Mitigation: delete stale entries (queue doc already calls this out). |
| 3. `SUPABASE_SECRET_KEY` 4× / `SUPABASE_URL` 3× duplicates | **LOW.** Duplicates are operational risk (deleting the wrong one could break production), but not exploitable. |
| 4. Missing Development-scope coverage on 7 vars | None — these are env-var-coverage gaps, not leaks. |
| 5. `STRIPE_PUBLISHABLE_KEY` configured server-side | **None and confirmed-unused.** `Grep STRIPE_PUBLISHABLE_KEY` against the codebase returned no matches outside the queue doc itself. The env var is set in Vercel but referenced nowhere in code. Safe to remove. |

### 13.1 Item (2) is the relevant security note
**Severity: LOW**
The stale `CRON_SECRET` Preview entries each hold their own copy of a value that, if discovered, would grant `api/cron-reminders.js` access — letting an attacker fire customer-facing reminder/final-notice emails on demand or trigger the lead retention sweep. Real-world exploitability is constrained (each entry is scoped to a deleted Preview branch and Vercel function instances for deleted branches may already be deprovisioned), but per least-privilege, those entries should be removed.

**Pre-portal blocker: NO.**

---

## Pre-portal blocker summary

Sorted by severity:

| # | Severity | Finding | Pre-portal blocker |
|---|---|---|---|
| 4.2 | HIGH | `Math.random` session_id generation in `lib/storage.js:415, 506` | **YES** |
| 1.2 | HIGH | `api/get-checkout-session.js` leaks customer PII for any leaked session_id | **YES** |
| 1.3 | HIGH | `api/resend-confirmation.js` accepts unauthenticated `customer_email` overwrite | **YES** |
| 4.3 | INFO | No `portal_token` column on `bookings` (architectural decision needed) | **YES (architectural)** |
| 11.* | DESIGN | Customer-portal design constraints (§11.3 / §11.4) | **YES (must-follow at impl time)** |

Everything else is non-blocking — either a defense-in-depth gap (rate limits, missing lockfile, missing `.gitignore` rules), an operational annoyance, or a positive finding documented for completeness.

## What's NOT in this audit

- Live Supabase schema inspection (RLS policy enumeration).
- Live Vercel project settings (cron config, build env vars, deploy hooks).
- Stripe dashboard webhook endpoint configuration.
- Mailchimp account permissions.
- Penetration testing of any sort. This is a static read-only audit.

A follow-up "ops audit" should cover the live-platform-state items.
