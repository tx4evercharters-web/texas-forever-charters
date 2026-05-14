# G20 — Damage-hold PaymentIntent not idempotent against Stripe webhook retries

**Status:** queued. Starter doc only. Not implemented.
**Discovered:** during G3/G10 audit on 2026-05-14.
**Related audit refs:** `docs/audits/admin-comprehensive-audit-2026-05-13.md` §1.1, §2 (webhook handlers); `docs/audits/admin-audit-2026-05-14.md` §4 row 4 + §10 P1.x (out-of-scope items at end of G10 proposal).

## The bug

`api/stripe-webhook.js:503` (legacy `checkout.session.completed` branch) calls `stripe.paymentIntents.create({ amount: 25000, capture_method: 'manual', confirm: true, off_session: true, ... })` to authorize the $250 damage-deposit hold. **The call has no Stripe idempotency key.** If Stripe retries the webhook delivery (rare — only triggered when `saveBookingWithRetry` permanently fails at line 611, returning 500), the retry runs the same `paymentIntents.create` call and authorizes a **second** $250 hold on the customer's card. The hold rows accumulate; the customer sees two pending $250 holds on their statement until both auto-release 48 hours later.

The bug is structurally identical to G10 (email idempotency) but on a different non-idempotent operation. G10 is shipped in the same commit that filed this starter doc; G20 is parked because the fix surface is different (Stripe idempotency key vs. DB-flag check) and lower-frequency (legacy branch only).

## Frequency

Low. The legacy `checkout.session.completed` branch is the wizard-flow webhook. Stripe retries on 5xx, but the only 5xx path in this branch is `saveBookingWithRetry` permanent failure after 3 internal retries (`api/stripe-webhook.js:611`). Other failures (PI retrieve at line 487, damage-hold authorize, sendConfirmationEmails, lead conversion) swallow and return 200. So Stripe retries the wizard webhook only when Supabase is genuinely down for an extended window. The `original_session_id` branch has a more aggressive 500-retry trigger but doesn't authorize a damage hold (it returns at line 470 before reaching that code).

Practically: this bug fires when (a) a customer completes wizard checkout AND (b) Supabase is down for the full 3-retry window AND (c) Stripe retries the webhook AND (d) Supabase has recovered by the retry. Rare. But when it fires, the customer-visible impact is two $250 holds on their card — they will notice.

## Fix direction

Two reasonable approaches:

### Option A — Stripe idempotency key

`stripe.paymentIntents.create({...}, { idempotencyKey: 'damage_hold_' + session.id })`. Stripe deduplicates based on the key for 24 hours. A retry with the same key returns the SAME PaymentIntent that was created the first time, not a new one. No DB read required, no state checking.

This is the canonical Stripe pattern. The Stripe SDK passes the key as an option object as the second argument to `create()`.

### Option B — Check existing row first

Before calling `paymentIntents.create`, do `findBookingBySessionId(session.id)` and check whether `damage_hold_intent_id` is already populated. If yes, skip the create call. This requires a DB read and a state check.

Option A is cleaner and matches the existing Stripe-side idempotency primitive. Option B duplicates that primitive in DB state and requires more code.

**Recommendation:** Option A. Single-line change to add the idempotency key on the existing `paymentIntents.create` call.

## Suggested commit shape for the fix

Single file edit to `api/stripe-webhook.js:503`:

- Change `stripe.paymentIntents.create({ ... })` to `stripe.paymentIntents.create({ ... }, { idempotencyKey: 'damage_hold_' + session.id })`.
- That's it. One change in one location. No DB schema change. No other code path affected. Verifiable via the existing `damage_hold_intent_id` column being identical across retries.

Triple-gate cadence: audit → propose → diff → approve → commit. Should be a ~10-minute commit when picked up.

## Why this isn't in the G3/G10 commit

The user's spec for the G3/G10 commit was: "Both fixes touch confirmation-email logic. Pairing them keeps that surface area changes in one diff." G20 is a different surface area (Stripe PI idempotency, not email idempotency). Bundling it would dilute the focused commit and require additional smoke testing for a separate failure mode. Better as its own commit when DJ has a Phase 1 slot for it.

## Related future work

Once Phase 2 schema migration lands the `payment_links` columns from G1 + the `balance_payment_intent_id` from G7, this commit can also use the schema-aware checks. But G20's Option A (Stripe idempotency key) doesn't require any schema and can ship in Phase 1 standalone.
