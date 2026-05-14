# G21 — Admin-handler PaymentIntent.create calls have no idempotency keys

**Status:** queued. Starter doc only. Not implemented.
**Discovered:** during G20 audit on 2026-05-14.
**Related audit refs:** `docs/audits/admin-comprehensive-audit-2026-05-13.md` §1.2 (Charge Card), §1.3 (Capture Damage Charge); `docs/audits/admin-audit-2026-05-14.md` §4 rows 3 + 11; `docs/queue/g20-damage-hold-idempotency.md` (parent / sibling fix).

## The bugs (plural — two sibling code paths)

### Bug 1 — `handleChargeRemaining` (`api/admin.js:225`)

`stripe.paymentIntents.create({ amount, currency, customer, payment_method, off_session: true, confirm: true, ... })` is called with no idempotency key. This handler runs synchronously when the admin clicks the "💳 Charge Card" kebab action against a booking with a saved card. If the admin double-clicks (or the network blips and they click again before the first response returns), both clicks reach the backend, both call `paymentIntents.create`, and the customer's saved card is charged twice for the remaining balance.

### Bug 2 — `handleCaptureDamageCharge` overflow (`api/admin.js:519`)

`stripe.paymentIntents.create({ amount: overflowCents, currency, customer, payment_method, off_session: true, confirm: true, ... })` is called when damage > $250 (the captured-hold amount). Same shape, same lack of idempotency key. If the admin double-clicks "Capture Damage Charge…" with an amount over $250, the overflow portion could be charged twice.

## Why these are lower-urgency than G20

**G20** was a webhook with **Stripe-automatic retries on 5xx**. Stripe's retry is non-negotiable; the customer can't see or stop it; duplicate $250 holds appear on their statement without any human action. That's why G20 was a HIGH priority.

**G21** is two synchronous admin actions. Neither is auto-retried by anything:
- No Stripe retry (Stripe doesn't auto-retry on responses to API calls we initiated; only on webhooks it sends US)
- No client-side auto-retry in admin.html
- No cron retry

The retry hazard is **human-initiated**: a rapid double-click before the first response returns, OR a network blip that delays the first response while the admin clicks again. Mitigated (partially) by the handlers' existing precondition checks:
- `handleChargeRemaining` at `api/admin.js:215` early-returns if `booking.paid_in_full` is true. After a successful charge, `markBookingPaid` flips the flag; a subsequent click is blocked there. But if both clicks reach the booking lookup before either `markBookingPaid` runs, the early-return doesn't fire and both charges hit Stripe.
- `handleCaptureDamageCharge` at `api/admin.js:502-509` gates on `damage_hold_status`. Similar race profile.

So the risk is real but the window is narrow (low milliseconds between concurrent reads of the same booking row). Real-world incidence: rare but not zero.

## Why they still warrant a fix

1. **Customer-impact severity is HIGH if it does happen** — double-charging a customer's card for the remaining balance (could be hundreds of dollars) is a much worse customer experience than a transient duplicate $250 hold. The hold auto-releases; a double-charge requires a refund.
2. **Stripe idempotency keys are essentially free to add** — single-argument addition to an existing call.
3. **Defense-in-depth** — the existing precondition checks are good but rely on Supabase write-then-read consistency within a narrow window. Belt-and-suspenders with Stripe-side idempotency closes the window entirely.

## Fix direction — and the key-shape question

The naive shape `'admin_charge_' + session.id` (what G20 uses for the webhook) has a subtle problem for admin handlers: **admin retries after a card decline are LEGITIMATE**, unlike webhook retries which are always deduplications of the same logical event. With a static `session.id`-only key:

- ✓ Rapid double-click: same key → Stripe dedupes → second call returns the first PI. Correct behavior — no double charge.
- ⚠ Card declined on first attempt, admin retries within 24h: same key → Stripe returns the SAME declined response (Stripe idempotency keys cache the entire response, not just successes). Admin sees a confusing "still declined" message even if they switched cards or fixed the issue. Workaround: wait 24h OR force a different key (but the code doesn't currently know how to force).

Two key shapes to consider, both viable:

### Option A — `'admin_charge_' + session.id` (G20-style)

Pros: simplest. Single line per handler.
Cons: blocks legitimate decline-then-retry-within-24h. Admin would need to wait or work around.

### Option B — `'admin_charge_' + session.id + '_' + Math.round(remaining * 100)`

Pros: when admin updates the booking's `remaining_balance` (via Edit Booking modal) between attempts, the key changes, allowing a new Stripe call. Same key on rapid double-click → dedupe. Same key on a retry-without-changing-anything → dedupe (still blocks legitimate retry of an unchanged amount after decline).

Cons: doesn't help the decline-without-changing-amount case.

### Option C — Hybrid: DB precondition + Stripe idempotency key

Use the existing precondition checks (paid_in_full, damage_hold_status) as the primary guard against happy-path race, AND add an idempotency key for defense-in-depth. The key shape can stay simple (`'admin_charge_' + session.id`) because the precondition catches the decline-then-retry case (admin would need to manually adjust state before retrying, which also changes the precondition).

**Tentative recommendation: Option C.** The precondition checks are already there; adding a Stripe-side dedupe key is pure defense-in-depth. The decline-then-retry edge case is rare and admin-visible (they'd see the same error message and know to escalate), and it's better than the rapid-double-click double-charge silent failure.

Worth re-evaluating during the actual fix commit — the right answer might be Option B if Option C feels too coupled.

## Suggested commit shape for the fix

Single file edit to `api/admin.js` — two locations:

- Line 225 (`handleChargeRemaining`): add `, { idempotencyKey: 'admin_charge_' + session_id }` as second argument.
- Line 519 (`handleCaptureDamageCharge` overflow): add `, { idempotencyKey: 'admin_damage_overflow_' + session_id }` as second argument.

Both keys scoped to the booking's `session_id`. Two-line change. Tests: code review acceptance; live verification on next admin Charge Card / Capture Damage Charge that the operation still succeeds normally.

**Estimated effort: ~10 minutes.** Can ship right after G20 lands. Lower urgency than G20 because synchronous admin clicks rarely retry, but cheap insurance against the race.

## Why this isn't in the G20 commit

The G20 commit's spec explicitly said "ONLY adding an idempotency_key to ONE Stripe API call." The two admin handlers are different code paths (different file, different functions, different invocation context). Bundling would expand scope beyond what was approved. Cleaner as its own commit.

## Related future work

Phase 4's G2 (single payment-state-machine helper from `docs/audits/admin-comprehensive-audit-2026-05-13.md` §10.1) could centralize the "is this booking in a chargeable state?" check across all three call sites (webhook, Charge Card, Capture Damage Charge). When that lands, the idempotency keys can be set at the helper level instead of at each call site. G21 is the right interim fix until that lands.
