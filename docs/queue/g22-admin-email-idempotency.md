# G22 — Admin-handler email layer is not idempotent against rapid double-clicks

**Status:** queued. Starter doc only. Not implemented. **Has a real design decision to make before code.**
**Discovered:** during G21 audit on 2026-05-14. Surfaces NOW because G3 (commit `b150eaa`) made `handleChargeRemaining` actually send a customer confirmation email, and G21 (commit pending) dedupes the Stripe charge but not the email.
**Related audit refs:** `docs/audits/admin-comprehensive-audit-2026-05-13.md` §10.3 G8/G15 (email visibility), §10.4 G10 (webhook email idempotency, already shipped); `docs/queue/g21-admin-paymentintent-idempotency.md` (parent fix).

## The bugs

After G21 lands, the Stripe-side charge is deduped against rapid admin double-clicks. But the email-sending step inside each handler runs once per click — Stripe's dedupe doesn't propagate to our Resend calls. Customer receives ONE charge + TWO emails.

### Bug 1 — `handleChargeRemaining` (`api/admin.js`, post-G3 lines 273-283)

After `markBookingPaid(session_id)` and emailData construction, the handler calls `sendConfirmationEmails(emailData)` (around line 276 in the current `api/admin.js`). The send is wrapped in try/catch and any failure becomes `email_warning` in the 200 response — but there is no precondition check on `booking.confirmation_email_sent`. Two rapid clicks → both reach this send → customer receives two "Booking Confirmed" emails.

The pre-call `paid_in_full` check at line 215 doesn't catch this: both clicks fetch `booking` with `paid_in_full=false` before either's `markBookingPaid` lands, both proceed past the check, both reach `sendConfirmationEmails`.

### Bug 2 — `handleCaptureDamageCharge` (`api/admin.js:605-612`)

After `patchBooking({ damage_hold_status: 'captured', ... })`, the handler calls `sendDamageChargeEmail(updated || booking, dollars)`. Same shape. The `damage_hold_status === 'captured'` precondition at line 567 doesn't catch the double-click race for the same reason.

## Why this surfaces NOW (and didn't before)

- **Before G3:** `handleChargeRemaining` sent ZERO emails on success (the bug G3 fixed). Rapid double-clicks produced one or two Stripe charges + zero emails. The customer-trust failure was "no email at all," not "duplicate emails."
- **After G3 (commit `b150eaa`):** the handler correctly sends one email per successful charge. But each invocation sends its own email.
- **After G21 (commit pending):** Stripe charge is deduped (one charge), but two emails still send.

So G22 is a **side effect of fixing G3 + G21 together.** Neither commit introduced a regression — they each fixed a real bug. G22 is the residual that becomes visible once the loud failures (silent success, double charge) are eliminated.

## Why this is lower-severity than G21

- **G21 fixed FINANCIAL impact** (double-charge of the remaining balance — could be hundreds of dollars; refund required).
- **G22 fixes COSMETIC / UX impact** (two identical emails — customer reads one, deletes the other, slightly confused). No financial harm. No data harm. No silent failure.
- **Frequency: same as G21** (rapid admin double-clicks; narrow window).
- **Severity: low to medium.** Annoying for the customer if it happens; the receiving customer might wonder if they were charged twice and call us. That's the only real downstream cost.

Worth fixing, but not P0/P1.

## Fix direction — Option (b): scoped guard inside email-send paths

From the G21 proposal, Option (b) is: make `sendConfirmationEmails` (and `sendDamageChargeEmail`) consult `confirmation_email_sent` before sending, but **scoped only to "fresh charge" code paths so legitimate manual resends still work.**

The webhook's G10 guard handles this cleanly — it returns early from the entire webhook branch when `confirmation_email_sent === true`. For admin handlers, the issue is more nuanced because the same library function (`sendConfirmationEmails`) is called from:

1. **Webhook `checkout.session.completed`** (wizard flow, legacy branch). First-time send. G10 already guards the `original_session_id` sub-branch; legacy branch's race is rare.
2. **Webhook `original_session_id` branch.** First-time send. G10 guards.
3. **Admin `handleAddBooking` with `send_confirmation: true`.** First-time send. Admin-initiated, single click. Not a retry.
4. **Admin `handleChargeRemaining`** (G3). First-time send. Rapid double-click race — this is the new G22 concern.
5. **`api/resend-confirmation.js`.** Admin-initiated MANUAL RESEND. **Must NOT be blocked by the guard** — that's the whole point of the endpoint.
6. **`api/send-confirmation.js`.** Manual resend by Stripe session lookup. **Must NOT be blocked.**
7. **`cron-reminders.js` pass 2.** Retry of previously-failed confirmation emails. Looks for `confirmation_email_sent: false` rows specifically. **Must NOT be blocked.**

So the guard cannot live inside `sendConfirmationEmails` itself — that would break #5, #6, #7. It has to be in the calling code, scoped to the rapid-click race surfaces (#1, #4).

## The real design decision

**How does the caller signal "this is a fresh charge, dedupe me" vs "this is a manual resend, send me"?**

Three options:

### Option A — Boolean flag passed to `sendConfirmationEmails`

```js
await sendConfirmationEmails(emailData, { skipIfAlreadySent: true });
```

`sendConfirmationEmails` checks `confirmation_email_sent` via a Supabase read if the flag is true; bypasses the read otherwise.

**Pros:** explicit at every call site. Easy to audit.
**Cons:** adds a DB read inside the email function (mixes concerns — currently the function is pure email-send). Caller has to remember to pass the flag.

### Option B — Caller-side precondition check, no library change

Each "fresh charge" call site does its OWN pre-send check:
```js
// inside handleChargeRemaining post-G3:
const fresh = await findBookingBySessionId(session_id);
if (fresh && fresh.confirmation_email_sent === true) {
  // skip the email — this is a rapid retry that the prior click already handled
  console.log('[charge-remaining] confirmation_email_sent already true — skipping duplicate email');
} else {
  // send normally
  ...
}
```

**Pros:** zero changes to `sendConfirmationEmails`. Library stays a pure send. Each call site explicitly handles its own race.
**Cons:** duplicated check at every fresh-charge call site (2-3 places). Easy to forget when adding a new path.

### Option C — Separate function names

`sendConfirmationEmails(emailData)` stays for resends + cron retries. New `sendConfirmationEmailIfFirst(session_id, emailData)` for fresh-charge paths — internally does the precondition read + send + flag patch. Fresh-charge paths switch to the new function; resend/cron paths keep the old one.

**Pros:** intent is type-system-clear (no runtime flag to forget). Library encapsulates the dedupe logic.
**Cons:** two functions with similar names and ~20-line duplication. Worse if a third "mode" emerges later.

### Tentative recommendation: Option B

Caller-side check, no library change. Reasons:
- The "fresh charge" call sites are few (`handleChargeRemaining`, `handleCaptureDamageCharge` — possibly `handleAddBooking` if its rapid-click race is also a concern). Duplication is bounded.
- Keeps `lib/send-emails.js` purely about sending email — single responsibility.
- Each call site can choose its own race-handling (e.g., handleChargeRemaining might want to RETURN early; handleCaptureDamageCharge might want to LOG-AND-CONTINUE). Library wouldn't be able to express that nuance.
- Matches the G10 pattern (the webhook's idempotency guard lives in the caller — `api/stripe-webhook.js`).

But Option A or C might be cleaner if more fresh-charge paths emerge in Phase 4 (the single payment-state machine). **Decide at fix time.**

## Suggested commit shape for the fix

Once the design decision is made:

- **If Option B:** small commit to `api/admin.js` only. Add a pre-`sendConfirmationEmails` check in `handleChargeRemaining` (~6 lines) and a pre-`sendDamageChargeEmail` check in `handleCaptureDamageCharge` (~6 lines). Total ~15 lines. No library change.
- **If Option A:** `lib/send-emails.js` gets a new param + DB-read branch (~20 lines), call sites pass `{ skipIfAlreadySent: true }`. Library coupling increases.
- **If Option C:** new function in `lib/send-emails.js` (~25 lines), call sites switch to the new function (~6 lines per site).

Triple-gate cadence: audit → propose → diff → approve → commit. **Add a 4th micro-gate before the diff:** explicitly pick A/B/C.

## Why this isn't in the G21 commit

The G21 spec was scoped to "ONLY the Stripe-side idempotency on `paymentIntents.create` calls." Bundling the email-layer fix would expand the surface to `lib/send-emails.js` (Option A/C) or to deeper call-site logic restructuring (Option B). Different concern, different review story, different smoke-test plan (email duplication is harder to actively test than Stripe charge duplication).

Ship G21 standalone; circle back to G22 when there's a clean slot to make the A/B/C design call.

## Related future work

Phase 4 G2 — single payment-state-machine helper (`transitionPaymentState(...)`) — could centralize the "should we send the confirmation email?" decision alongside the other state mutations. If/when G2 ships, G22 becomes a non-issue (the helper would consult the flag internally). G22 is the right interim fix until G2 lands; if Phase 4 is close, consider skipping G22 and going straight to G2.
