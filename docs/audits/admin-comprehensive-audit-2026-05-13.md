# Comprehensive Admin / Payment / Booking Lifecycle Audit

**Date:** 2026-05-13
**HEAD commit at audit time:** `f10c429` ("Admin: attach metadata to payment links + webhook updates original booking on completion")
**Scope:** Map every code path that touches booking state, payment state, or customer communication. Identify silent-failure surfaces and structural gaps so the next phase can plan a redesign.
**Mode:** Read-only. No code changes. No fixes proposed inline — the synthesized requirements live in §10.

## Conventions used in this document

- `file:line` references are clickable in any tool that understands them.
- **REQUIRES DJ INPUT** marks every question I could not answer from code alone. All are bundled into Appendix B for single-pass resolution.
- ⚠ marks a silent-failure surface. A failure happens but neither the customer nor the admin necessarily learns about it.
- The phrase "validate → parse → write → return" comes from the handoff doc — it's the safety-ordering pattern used to flag handlers that take destructive action before fully validating input.

## Last live evidence anchor

The fresh evidence driving this audit:

1. **Jaida Matthews $746.08 incident (pre-`f10c429`):** Stripe checkout session had zero metadata, confirmation email failed with "No customer email in session data," booking didn't auto-update. Root cause: old `handleSendPaymentLink` created Stripe Payment Links without `metadata`.
2. **$10 live test (post-`f10c429`):** Empty-metadata symptom reproduced. Diagnostic suspicion (per Phase 2 read-only audit): the payment link the customer clicked was created before deploy and is therefore frozen with empty metadata. Not yet conclusively confirmed against Stripe dashboard timestamps — the live test verification is still pending.

---

## Table of contents

1. [Admin actions inventory](#1-admin-actions-inventory)
2. [Webhook event handlers](#2-webhook-event-handlers)
3. [Cron jobs](#3-cron-jobs)
4. [Booking creation paths](#4-booking-creation-paths)
5. [Payment state transitions](#5-payment-state-transitions)
6. [Schema audit](#6-schema-audit)
7. [Email sends](#7-email-sends)
8. [Customers tab kebab clip](#8-customers-tab-kebab-clip)
9. [Silent-failure inventory](#9-silent-failure-inventory)
10. [Gaps for the redesign](#10-gaps-for-the-redesign)

Appendices A-D follow §10.

---

## 1. Admin actions inventory

Every admin-triggered action that mutates booking/payment state or sends mail. Login is intentionally excluded per scope adjustment.

The router that dispatches all admin actions lives at `api/admin.js:1041-1071` (`ROUTES` table) and `api/admin.js:1063` (`module.exports = async function handler`). All authenticated routes pass through `requireAuth(req, res)` at `api/admin.js:1069`.

### 1.1 Send Payment Link

- **UI surface:** Kebab dropdown in Bookings tab AND Customers-tab booking history (shared `bkActionMenu`).
- **Frontend:** `admin.html:6195-6205 sendPaymentLink(session_id, btn)`; also chained from Add Booking modal at `admin.html:5984-5988` when payment mode is `stripe-link`.
- **Endpoint:** `POST /api/admin?action=send-payment-link`
- **Backend:** `api/admin.js:247-345 handleSendPaymentLink` (modified by `f10c429`).
- **Inputs:** `{ session_id }` — looks up booking via `getBookings()`, filters by session_id.
- **Stripe calls:** `stripe.paymentLinks.create({...})` — line 267. Post-`f10c429` includes 26-key metadata block (line 283-313) with `original_session_id` back-link.
- **Supabase writes:** None directly. The booking row is read-only here. The eventual `checkout.session.completed` webhook is what writes (via the `original_session_id` branch added in `f10c429`).
- **Email sent (this handler):** Payment-link delivery email via `postToResend` (api/admin.js:317-338), to `booking.customer_email`. Subject: "Your Remaining Balance — Texas Forever Charters."
- **Customer confirmation email on failure of this handler:** No — handler only delivers the link. Customer confirmation comes later via the webhook.
- **Defensive alert when delivery fails:** ⚠ **None.** If `postToResend` throws, the catch at line 343-345 returns 500 with `{ error }`. Admin sees the failure inline only if they're watching the API response in the kebab. There's no email/log alert. **HIGH-impact silent failure** if the API response is ignored (e.g. tab close during loading).
- **Availability update:** None at this stage. Slot is already held by the original deposit booking.
- **Silent-failure modes:**
  1. ⚠ Payment-link create succeeds but email send fails — link exists in Stripe (and may be auto-emailed by Stripe if URL was leaked), but customer never gets ours. No alert.
  2. ⚠ Payment link URL is **not** persisted to the booking row (`paymentLink.url` is only returned in the HTTP response at line 343). Cron reminders try to read `b.payment_link` (api/cron-reminders.js:168) — that column is never written, so reminder emails never include the link. See §3 and §6.
  3. The booking lookup at line 254 uses `getBookings()` which returns ALL rows. Quadratic if the table grows large, but not a correctness issue. Cosmetic.
- **Gaps observed:** No persistence of the created `paymentLink.id`, `paymentLink.url`, amount, or created-at timestamp. No way for admin to know which active link(s) exist on a booking. Re-clicking generates new links infinitely with no de-dup. See §10.

### 1.2 Charge Card (collect remaining balance)

- **UI:** Kebab dropdown.
- **Frontend:** `admin.html:6182-6193 chargeCard(session_id, btn)`.
- **Endpoint:** `POST /api/admin?action=charge-remaining`
- **Backend:** `api/admin.js:206-245 handleChargeRemaining`.
- **Inputs:** `{ session_id }`. Reads booking; requires `payment_method_id` + `stripe_customer_id` (saved at original deposit).
- **Stripe calls:** `stripe.paymentIntents.create({ amount, currency, customer, payment_method, off_session: true, confirm: true, ... })` at line 225. Note: **no `metadata`** on this PaymentIntent.
- **Supabase writes:** `markBookingPaid(session_id)` (lib/storage.js:145-153) — patches `{ paid_in_full: true, remaining_balance: 0, payment_type: 'full' }`.
- **Customer email:** ⚠ **NONE.** The handler returns success but does NOT send a "your balance has been paid" confirmation. The customer's card was charged but they get no email about it. **HIGH-impact silent failure for customer trust.**
- **Defensive alert:** None. Admin sees inline UI success but customer is in the dark.
- **Availability update:** N/A — slot already held.
- **Refund integrity:** The PaymentIntent created here has no metadata back-linking to the booking. `findBookingByPaymentIntent` in the webhook's refund handler (`stripe-webhook.js:99`) will find the deposit's PI but not THIS one if the balance payment ever needs separate refunding. Same gap noted for "Send Payment Link" in §10 (queue item: `balance_payment_intent_id`).
- **Silent-failure modes:**
  1. ⚠ No customer-facing email confirms the charge succeeded. (Severity: HIGH)
  2. ⚠ The new PaymentIntent has no booking back-link metadata.
  3. ⚠ The webhook is bypassed entirely — `checkout.session.completed` doesn't fire for off-session PaymentIntents, so none of the post-payment side effects (lead conversion, email retry tracking) execute.
- **Gaps observed:** This is the parallel-track of bug #1 (the Send Payment Link bug). Filed as bug #3 in handoffs.

### 1.3 Capture Damage Charge

- **UI:** Kebab dropdown ("⚠ Capture Damage Charge…") — only enabled when `damage_hold_status` is `pending`.
- **Frontend:** `admin.html bkCaptureDamageOpen` (opens prompt modal; final call unknown without further grep — REQUIRES DJ INPUT only if it isn't a vanilla fetch wrapper).
- **Endpoint:** `POST /api/admin?action=capture-damage-charge`
- **Backend:** `api/admin.js:491-562 handleCaptureDamageCharge`.
- **Inputs:** `{ session_id, amount }`. Requires existing `damage_hold_intent_id` in `pending` state.
- **Stripe calls:**
  1. `stripe.paymentIntents.capture(booking.damage_hold_intent_id, { amount_to_capture: captureCents })` (line 511) — captures up to $250 from the hold.
  2. If damage exceeds $250: `stripe.paymentIntents.create({ amount: overflowCents, ..., metadata: { purpose: 'damage_overflow', booking_session_id } })` (line 519-531). Note: this PI **does** have metadata — but the webhook still doesn't process it because it's not a checkout-session event.
- **Supabase writes:** `patchBooking(session_id, { damage_hold_status: 'captured', damage_charge_amount, damage_captured_at })` at line 535.
- **Customer email:** Yes — `sendDamageChargeEmail(booking, dollars)` at line 544. Failure is logged and surfaced as `email_warning` in the response (line 542-548). **Does not** abort the captured charge.
- **Defensive alert when email fails:** None — the failure is reported only in the API response (admin UI must surface `email_warning`). Bookings tab `chargeCard` button doesn't read `email_warning` in any path I can see — REQUIRES DJ INPUT on whether the admin sees this in the modal UI.
- **Silent-failure modes:**
  1. ⚠ If the overflow charge succeeds but the patch fails, the Stripe charge is real but Supabase says hold is still pending. Manual reconciliation required.
  2. Customer email failure is logged but not alerted.
- **Gaps observed:** No alert email path for "damage charge captured but customer didn't get the email." The `email_warning` surfaces in JSON but the admin may not see it.

### 1.4 Full Refund

- **UI:** Kebab dropdown — "↩ Full Refund ($X)" — only enabled when `payment_intent_id` exists and there's refundable balance.
- **Frontend:** `admin.html bkFullRefund(id)` (calls `handleRefundBooking` with `refund_amount = booking.amount_total - already_refunded`).
- **Endpoint:** `POST /api/admin?action=refund-booking`
- **Backend:** `api/admin.js:391-463 handleRefundBooking` (same handler for partial; differentiated by `refund_amount`).
- **Stripe calls:** `stripe.refunds.create({ payment_intent: paymentIntentId, amount: Math.round(amount * 100) })` at line 417.
- **Supabase writes:** `patchBooking(session_id, { refund_amount, refunded_at, status: 'cancelled', cancelled_at })` at line 427.
- **Customer email:** Yes — `sendRefundEmail` at line 443. Failure logged but not fatal; surfaced as `email_warning` in response.
- **Defensive alert:** Webhook's `charge.refunded` handler ALSO fires for the same refund event (stripe-webhook.js:78-151). It's idempotent (line 117-123: skips if `refund_amount` already matches), so no double-write. BUT the webhook's `sendStripeRefundReconciledAlert` is the "admin-side refund reconciled" alert path; on the admin-initiated full-refund flow this should self-skip via the idempotency guard. REQUIRES DJ INPUT: confirm in production logs that the dispute-style alert hasn't double-fired.
- **Availability update:** Yes — `status: 'cancelled'` (line 430). `api/availability.js:53` filters out cancelled bookings → slot becomes available again.
- **Silent-failure modes:**
  1. If `stripe.refunds.create` succeeds but `patchBooking` fails (line 427), Stripe says refunded, Supabase says paid. The `charge.refunded` webhook will reconcile this on its next event, but if the webhook isn't configured for this event type, it's a manual cleanup.
  2. Customer email failure → no alert.
- **Validate-parse-write-return ordering:** ✓ Validates `refund_amount` shape (line 396-399) and refundable balance (line 412-415) BEFORE the Stripe call. Good.
- **Gaps:** None major beyond shared customer-email-failure-no-alert pattern.

### 1.5 Partial Refund

Same handler as Full Refund (`handleRefundBooking`). The only frontend difference is the modal prompts for an amount. `isFullRefund` is computed server-side at line 437 by checking if `remainingAfter < $0.01`. Email subject differs ("Partial Refund Processed" vs "Refund Processed"). `status: 'cancelled'` is applied **even on partial refunds** at line 430 — REQUIRES DJ INPUT on whether this is intentional (it has availability consequences: any partial refund frees up the slot).

### 1.6 Release Damage Hold

- **UI:** Kebab dropdown — "🔓 Release Damage Hold" — only when `damage_hold_status` is `pending`.
- **Frontend:** `admin.html bkReleaseDamageHold(id)`.
- **Endpoint:** `POST /api/admin?action=release-damage-hold`
- **Backend:** `api/admin.js:465-489 handleReleaseDamageHold`.
- **Stripe calls:** `stripe.paymentIntents.cancel(damage_hold_intent_id)` at line 478.
- **Supabase writes:** `patchBooking(session_id, { damage_hold_status: 'released', damage_hold_released_at })` at line 480.
- **Customer email:** ⚠ **NONE.** The customer doesn't get notified that their hold was released. Possibly fine (most customers won't notice an auto-release), but worth flagging.
- **Defensive alert:** None.
- **Silent-failure modes:** If `stripe.paymentIntents.cancel` succeeds but the patch fails, the hold is gone from Stripe but Supabase still says `pending`. Customer's card is free; admin will retry release and get a "no damage hold" error. Manual cleanup.
- **Gaps:** No audit log of hold-release operations.

### 1.7 Mark Paid

- **UI:** Kebab dropdown — "✓ Mark Paid" — for bookings not paid in full.
- **Frontend:** `admin.html markPaid(id, btn)`.
- **Endpoint:** `POST /api/admin?action=mark-paid`
- **Backend:** `api/admin.js:130-138 handleMarkPaid`.
- **Inputs:** `{ session_id }`.
- **Stripe calls:** None.
- **Supabase writes:** `markBookingPaid(session_id)` → `{ paid_in_full: true, remaining_balance: 0, payment_type: 'full' }` (lib/storage.js:145-153).
- **Customer email:** ⚠ **NONE.** This is a manual flag flip — customer doesn't get a "paid in full" confirmation.
- **Defensive alert:** None.
- **Use case:** Admin received cash/check off-platform and wants to mark the booking complete. No money moves through Stripe. Reasonable that customer doesn't get auto-email since the receipt would be misleading (no transaction occurred on Stripe).
- **Gaps:** No audit trail of who/when. The action is reversible only by manually editing the row.

### 1.8 Mark Concluded

- **UI:** Kebab dropdown — "✓ Mark Concluded."
- **Frontend:** `admin.html bkMarkConcluded(id)`.
- **Endpoint:** `POST /api/admin?action=mark-concluded`
- **Backend:** `api/admin.js:350-362 handleMarkConcluded`.
- **Supabase writes:** `patchBooking(session_id, { status: 'concluded' })`.
- **Customer email:** None directly. But the post-charter cron pass (api/cron-reminders.js:308-386) auto-concludes yesterday's bookings AND sends a `sendReviewRequestEmail`. The admin's manual "Mark Concluded" does **NOT** trigger the review email — inconsistency.
- **Gaps:** Manual concluding skips review-request email. If admin marks early (charter completed mid-day), no review email goes out for that customer.

### 1.9 Cancel Booking

- **UI:** Kebab dropdown — "⊘ Cancel Booking."
- **Frontend:** `admin.html bkCancel(id)`.
- **Endpoint:** `POST /api/admin?action=cancel-booking`
- **Backend:** `api/admin.js:364-389 handleCancelBooking`.
- **Stripe calls:** None. (No refund — that's a separate action.)
- **Supabase writes:** `patchBooking(session_id, { status: 'cancelled', cancelled_at })` at line 369.
- **Customer email:** Yes — `sendCancellationEmail(updated)` at line 379. Failure logged + surfaced as `email_warning`; cancel itself is not unwound.
- **Defensive alert:** None for email failure.
- **Availability update:** Yes — cancelled bookings free their slot (api/availability.js:53).
- **Gaps:**
  1. ⚠ Customer email failure is silent to admin unless they read `email_warning` from the response. Same pattern as refund/damage.
  2. No refund is processed. If the customer paid (deposit or full), they're cancelled but still charged. The admin must then run a separate Refund action. Race risk: cancel without refund = bad customer experience.

### 1.10 Delete Booking

- **UI:** Kebab dropdown — "🗑 Delete Booking" (danger styled).
- **Frontend:** `admin.html bkDelete(id)`.
- **Endpoint:** `POST` or `DELETE /api/admin?action=delete-booking`.
- **Backend:** `api/admin.js:602-613 handleDeleteBooking`.
- **Supabase writes:** `deleteBookingRow(session_id)` (lib/storage.js:139-143) — hard DELETE from `/bookings`.
- **Customer email:** None.
- **Defensive alert:** None.
- **Availability update:** Yes (by removal — the row is gone, so availability.js can't see it).
- **Gaps:**
  1. ⚠ **Hard delete with no audit trail.** No `deleted_at` flag, no archive table, no row preserved. If admin deletes by mistake, the booking is gone with no recoverable record.
  2. ⚠ Linked waivers (`booking_id` foreign key) become orphans. `lib/storage.js:631 listAllWaiversEnriched` would tag them `link_status: 'orphan'`.
  3. Customer-facing impact: customer keeps their Stripe receipt (charge still happened), but our system has no memory of them. Refund-by-PI lookup fails because the row is gone.

### 1.11 Edit Booking (update-booking)

- **UI:** Pencil/edit button in Bookings row; opens the Add Booking modal in edit mode.
- **Frontend:** `admin.html:5850-5901 abSave` edit-mode branch.
- **Endpoint:** `POST /api/admin?action=update-booking`
- **Backend:** `api/admin.js:140-203 handleUpdateBooking`.
- **Allowed fields:** Whitelist at lines 165-183. Includes charter, customer, pricing, payment, lifecycle, damage-hold fields. **Not allowed:** `session_id`, `customer_id`, `created_by_admin`, audit timestamps, JSON `add_ons` is coerced from object to string at line 190-192.
- **Supabase writes:** `patchBooking(session_id, sanitized)`.
- **Customer email:** None — silent edit.
- **Defensive alert:** Env-preflight at lines 148-160 produces a structured 500 if Supabase vars are missing (admin-facing safety net for env-misconfigured function instances).
- **Gaps:**
  1. ⚠ Any change to customer_email here does NOT trigger any notification to the new or old address. A bookings-tab email-fix would be silent to both parties.
  2. The edit modal's payment-type derivation at `admin.html:5881` overrides `payment_type` based on the `paid_in_full` checkbox — see §5 for state-transition implications.

### 1.12 Update Payment (legacy)

- **Endpoint:** `POST /api/admin?action=update-payment`
- **Backend:** `api/admin.js:830-843 handleUpdatePayment`.
- **Allowed fields:** Strict whitelist via `updateBookingPayment` (lib/storage.js:155-171): `amount_total`, `paid_in_full`, `remaining_balance`, `payment_method_external`, `payment_type`.
- **UI:** Embedded in some pricing-edit flows. REQUIRES DJ INPUT — is there still a frontend trigger for this, or did Edit Booking absorb it?

### 1.13 Add Booking (manual)

- **UI:** "+ Add Booking" button at top of Bookings tab.
- **Frontend:** `admin.html:5837-6004 abSave` create-mode branch.
- **Endpoint:** `POST /api/admin?action=add-booking`
- **Backend:** `api/admin.js:627-680 handleAddBooking`.
- **Supabase writes:** `addManualBooking(booking)` (lib/storage.js:474-504) — generates `session_id = 'manual_' + Date.now() + '_' + random`. Inserts directly into `/bookings`. Side effect: `upsertCustomerForBooking` (lib/storage.js:305-348).
- **Customer email when `send_confirmation: true`:** `sendConfirmationEmails(...)` at line 638. Failure handled at line 659-668: returns 200 with `email_warning` and does NOT abort the save. Booking is saved either way.
- **Defensive alert on email failure:** None. Only the `email_warning` field on the response (admin must surface it).
- **Availability:** Slot is now occupied (until cancelled).
- **session_id idempotency vs webhook retries:** The `manual_*` prefix means Stripe webhooks never collide with this row (they all start with `cs_*`). Idempotency against Stripe retry is N/A here — no Stripe involvement.
- **Gaps:**
  1. If frontend chains a `send-payment-link` call after this (Add Booking with payment mode `stripe-link`, admin.html:5984-5988), the metadata fix in `f10c429` now applies — the link will carry full metadata. See §4 for the full chained flow.

### 1.14 Add Booking — stripe-link chained flow

When `payment === 'stripe-link'` is selected in the Add Booking modal, the frontend chains two requests serially (admin.html:5977-5988):

1. `POST /api/admin?action=add-booking` — saves a row with `session_id = manual_*`, `paid_in_full: false`, `remaining_balance = grandTotal`, `payment_type: 'full'` (line 5918 — note: 'full' even though nothing has been paid yet; this is the "what was their intent" semantic).
2. `POST /api/admin?action=send-payment-link` (only on stripe-link mode) — runs `handleSendPaymentLink` with the new `session_id`. Post-`f10c429`, this attaches full metadata + `original_session_id` to the Stripe Payment Link.

When the customer pays, the webhook's `original_session_id` branch (stripe-webhook.js:344-435, added in `f10c429`) patches THIS row to `paid_in_full: true`, `remaining_balance: 0`, `payment_type: 'full'`.

**Critical hazard:** if step 2 fails (HTTP error, Stripe outage), step 1's row is still saved but no payment link was sent. Admin sees "✅ Booking saved" with maybe a stale state — REQUIRES DJ INPUT: confirm whether the frontend reports step-2 failures distinctly. From code inspection at admin.html:5985 the `await api(...)` result is not checked — silent failure path.

### 1.15 Resend Confirmation

- **UI:** Kebab dropdown — "📧 Resend Confirmation."
- **Frontend:** `admin.html:3198 bkResendConfirmation(id)`.
- **Endpoint:** `POST /api/resend-confirmation` (standalone route, NOT under `/api/admin?action=`).
- **Backend:** `api/resend-confirmation.js` (full file ~117 lines).
- **Supabase reads:** `findBookingBySessionId`. Optional PATCH if `email` override provided (line 47).
- **Email sent:** `sendConfirmationEmails(emailData)` (line 87) — same function the webhook uses.
- **Critical dependency:** Email rendering at `lib/send-emails.js:419` reads `d.payment_type === 'deposit'` to pick the "Deposit (10%)" vs "Paid in Full" label. After our `f10c429` change to also patch `payment_type: 'full'` on the original row when balance is paid, resend emails will correctly render "Paid in Full" — confirmed working as designed.
- **PATCH on success:** `confirmation_email_sent: customerOk` at line 99 — same flag the cron retry pass reads.
- **Gaps:** None major; this route is well-formed.

### 1.16 Send Waiver Link

- **UI:** Kebab dropdown.
- **Endpoint:** `POST /api/admin?action=send-waiver-link`.
- **Backend:** `api/admin.js:584-600 handleSendWaiverLink`.
- **Email:** `sendWaiverLinkEmail(booking)` (lib/send-emails.js:915-...). Includes a session-specific waiver URL.
- **Gaps:** None for the immediate redesign scope.

### 1.17 Blackouts: Add / Remove

- **Endpoints:** `POST /api/admin?action=add-blackout`, `DELETE /api/admin?action=remove-blackout`.
- **Backends:** `api/admin.js:96-128`.
- **Supabase writes:** `/blackouts` table — date + vessel + time_slot tuple. Idempotent insert via `on_conflict=date,vessel,time_slot`.
- **Customer-facing impact:** Availability shifts. No notifications fire for existing bookings if their slot suddenly conflicts with a new blackout — REQUIRES DJ INPUT on intent here.
- **Gaps:** No collision check against existing bookings.

### 1.18 Customer CRUD

- **Endpoints:**
  - `POST /api/admin?action=create-customer` → `handleCreateCustomer` (api/admin.js:765-781). Dedup-by-email at the storage layer (lib/storage.js:244-272).
  - `POST /api/admin?action=update-customer` → `handleUpdateCustomer` (line 751-763). Whitelisted fields only (lib/storage.js:228).
  - `POST/DELETE /api/admin?action=delete-customer` → `handleDeleteCustomer` (line 783-794). **Detaches bookings first** by setting `customer_id: null` on `/bookings?customer_id=eq.X` (lib/storage.js:278), then deletes the customer.
- **Email:** None.
- **Gaps:**
  1. Customer edits do NOT propagate to historical bookings (`bookings.full_name`, `bookings.phone`, `bookings.customer_email` stay frozen at booking time). Whether this is desired is REQUIRES DJ INPUT.
  2. Delete-customer detaches but does not re-link if customer is later recreated with the same email. The booking row's `customer_id` stays null forever.

### 1.19 Import Bookings (CSV)

- **Endpoint:** `POST /api/admin?action=import-bookings`.
- **Backend:** `api/admin.js:796-828 handleImportBookings` → `lib/storage.js:354-471 importHistoricalBookings`.
- **session_id shape:** `historical_TIMESTAMP_INDEX_RANDOM` (lib/storage.js:384-385). Never collides with Stripe's `cs_*` or manual's `manual_*`.
- **Side effect:** `upsertCustomer` or createCustomer per row. Limits at 1000 rows per call.
- **Email:** None. Historical imports are silent by design.
- **Gaps:**
  1. ⚠ Imported rows have `payment_type: 'full'` and `paid_in_full: true` hardcoded (lib/storage.js:456-458). If admin imports a deposit booking (rare but possible), it will be marked paid-in-full by default. The CSV format doesn't expose a payment_type column — REQUIRES DJ INPUT.

### 1.20 Lead actions

- `GET /api/admin?action=leads` → `handleListLeads` (api/admin.js:898-920). Enriches each lead with `outcome_editable`.
- `POST /api/admin?action=mark-lead-contacted` → `handleMarkLeadContacted` (line 949-...). Handles outcome logging (booked / hard_no / maybe / no_response / quoted / other), bounce-reason tagging, optional `linked_booking_session_id`.
- `GET /api/admin?action=find-bookings-for-lead` → `handleFindBookingsForLead` (line 922-941).
- **Gaps:** Lead-conversion writes happen via webhook (not these admin handlers). Admin can manually mark `outcome: 'booked'` with a linked session_id, but that PATCH path is separate from the webhook's auto-conversion at `stripe-webhook.js:552-571`. REQUIRES DJ INPUT: confirm that both paths converge on the same `status: 'converted'` shape (they do, based on inspection — but worth verifying analytics aren't double-counting).

---

## 2. Webhook event handlers

The webhook lives at `api/stripe-webhook.js` (663 lines post-`f10c429`).

### 2.1 Signature validation and ordering

The webhook follows the **validate → parse → write → return** safety pattern:

1. **Validate** request method (line 225-227): rejects non-POST with 405.
2. **Validate** presence of `stripe-signature` header (line 229-233): 400 if missing.
3. **Validate** `STRIPE_WEBHOOK_SECRET` env (line 235-238): 500 if not configured.
4. **Parse + validate signature** via `stripe.webhooks.constructEvent(rawBody, sig, secret)` (line 242-243). Raw bytes are required → `module.exports.config = { api: { bodyParser: false } }` at line 23, plus a manual `getRawBody` helper at line 25-32.
5. **Dispatch** to event-specific handler.
6. Within `checkout.session.completed`:
   a. Parse `meta`, `stripeCustomerId`, `paymentIntentId` (line 340-342).
   b. **NEW (`f10c429`)** — `meta.original_session_id` branch (line 344-435). Validates → patches original row → emails → returns 200.
   c. Legacy: retrieve payment intent (line 346-352) → authorize damage hold (line 358-394) → build `bookingRow` (line 416-456) → `saveBookingWithRetry` (line 464) → `sendConfirmationEmails` (line 506) → damage-hold alerts (line 525-540) → patch `confirmation_email_sent` (line 546) → lead conversion (line 558-571) → return 200.

**Ordering verdict:** all five legacy event branches and the new remaining-balance branch follow validate → parse → write → return correctly. No handler writes before validating.

### 2.2 Event handlers

#### 2.2.1 `checkout.session.completed` — legacy path (no `original_session_id`)

- **Entry:** Line 327-573 (after the new branch falls through OR is skipped).
- **Reads:** `session.metadata`, `session.customer_email`, `session.amount_total`, `session.customer`, `session.payment_intent`, `session.customer_details.address` (city, state).
- **Writes:**
  - Authorizes $250 damage hold via `stripe.paymentIntents.create({ capture_method: 'manual', confirm: true, off_session: true })` (line 363-376).
  - Upserts the booking row via `saveBookingWithRetry` (line 464) using `Prefer: resolution=merge-duplicates,return=minimal` on `session_id` conflict.
  - Patches `confirmation_email_sent` (line 546).
  - Patches lead row if a matching captured/abandoned lead exists (line 558-571).
- **Emails:** `sendConfirmationEmails` (customer + business). Conditional damage-hold failure alert + customer notice (line 525-540).
- **Idempotency:** `saveBooking` uses `on_conflict=session_id` (lib/storage.js:90-95). Stripe retries on 5xx — if the retry fires before/during the first attempt's commit, the second hits the conflict and merges. **Idempotent ✓.**
- **session_id shape:** Stripe-generated `cs_live_*` or `cs_test_*`.

#### 2.2.2 `checkout.session.completed` — `original_session_id` branch (post-`f10c429`)

- **Entry:** Line 344-435 (gated on `if (meta.original_session_id)`).
- **Reads:** `meta.original_session_id` (the original admin-created booking's session_id).
- **Writes:** Two `patchBooking` calls (line 347, 425). First sets `paid_in_full: true, remaining_balance: 0, payment_type: 'full'`; second sets `confirmation_email_sent`.
- **Emails:** `sendConfirmationEmails(emailData)` built from the patched row's data, not from session metadata directly.
- **Fall-through case:** If `patchBooking` returns null (original row not found — deleted between link-send and link-click), the branch logs a warning (line 432) and falls through to the legacy code, which inserts a new row using session metadata. **Behavior:** customer still gets an email and a row still exists, just a fresh one rather than the original.
- **Idempotency vs Stripe retries:** `patchBooking` is idempotent (setting `paid_in_full: true` repeatedly is fine). The first email send is NOT idempotent — a Stripe webhook retry would resend the confirmation email. Mitigated by Stripe's standard retry policy + the patched `confirmation_email_sent: true` flag, but a webhook double-fire within seconds could double-email. REQUIRES DJ INPUT: is this acceptable?
- **session_id shape involved:** `meta.original_session_id` is a `manual_*` (or webhook-created `cs_*` if balance link was sent against a wizard booking). The Stripe-side session_id of this completion event is a fresh `cs_*` and is **not** persisted anywhere on the patched row.

#### 2.2.3 `charge.refunded` → `handleChargeRefunded` (line 78-151)

- **Reads:** `event.data.object` (the charge), `findBookingByPaymentIntent(piId)` (line 99) to locate the booking.
- **Idempotency guard:** Line 117-123 — skips the patch and the alert if Supabase already shows the refund amount matches (i.e. admin-initiated refund already did it). Critical for avoiding double-firing the reconciled-alert email when an admin already used the Refund button.
- **Writes:** `patchBooking(booking.session_id, { refund_amount, refunded_at, ...(isFull ? { status: 'cancelled' } : {}) })` (line 132).
- **Emails:** `sendStripeRefundReconciledAlert(...)` — business-facing.
- **Gaps:** If `payment_intent_id` on the booking row is null (older imported rows, or off-session balance-payment intents not back-linked), the refund can't be reconciled — `findBookingByPaymentIntent` returns null → handler logs warning and 200s (line 105-108). Refund happens at Stripe; our DB never reflects it.

#### 2.2.4 `charge.dispute.created` → `handleDisputeCreated` (line 153-215)

- **Reads:** dispute object, `findBookingByPaymentIntent`.
- **Writes:** `patchBooking(booking.session_id, { dispute_id, dispute_status, dispute_amount, dispute_reason, disputed_at })`. **Does NOT change `status`** — chargebacks aren't cancellations (per inline comment line 190-191).
- **Emails:** `sendChargebackAlert(booking, dispute)` — business-facing only.
- **Fallback:** If no booking matches the PI, sends the alert with a stub booking so admin still gets notified (line 174-187).

#### 2.2.5 `checkout.session.expired` (line 260-286)

- **Reads:** session object, `findLeadByStripeSession(s.id)` (line 273).
- **Writes:** If a lead exists, patches `status: 'abandoned_stripe'`.
- **Emails:** `sendHighValueLeadAlert(updated, 'abandoned_stripe')` if `grand_total >= $500`.

#### 2.2.6 `payment_intent.payment_failed` (line 287-321)

- **Reads:** `pi.id`, `pi.last_payment_error`, `pi.receipt_email`.
- **Writes:** `patchLead(lead.id, { status: 'payment_failed', payment_intent_id })` if a matching lead exists.
- **Emails:** `sendHighValueLeadAlert(updated, 'payment_failed')` if `grand_total >= $500`.
- **Lead lookup:** PI first (specific), then `findActiveLeadByEmail` (broader fallback).

#### 2.2.7 Silent default for other event types (line 323-324)

```js
if (event.type !== 'checkout.session.completed') {
  return res.status(200).json({ received: true });
}
```

This early-return after the dispatch chain. Any event Stripe sends that we don't handle (`charge.succeeded`, `customer.created`, etc.) returns 200 silently. **Intentional** — Stripe sends many event types we don't care about, and 200 stops retries.

⚠ **Implication:** if we ever rely on a new event type (e.g. `refund.updated`), it'll silently 200 forever until someone adds a branch. Not a current bug, but a future-proofing trap.

---

## 3. Cron jobs

### 3.1 Schedule

From `vercel.json`:

```json
"crons": [{ "path": "/api/cron-reminders", "schedule": "0 14 * * *" }]
```

**14:00 UTC = 9 AM Central daily.** Single cron, no others scheduled in `vercel.json`.

### 3.2 `api/cron-reminders.js` — five sequential passes

The cron runs five passes in one invocation (api/cron-reminders.js:104-465):

#### Pass 1: Day-count reminders (line 113-191)

Picks bookings where `days_out` matches `{21, 14, 13, 12}` (REMINDERS table line 81-86) and sends:
- 21 days → `sendFriendlyReminderEmail` (customer)
- 14 days → `sendDueTodayEmail` (customer)
- 13 days → `sendOwnerAlertEmail` (admin)
- 12 days → `sendFinalNoticeEmail` (customer)

**Per-booking idempotency:** Tracks sent state in `reminders_sent` JSONB column (`{ '14day': true, ... }`). Re-runs skip already-sent buckets.

**Payment-link inclusion in reminder emails:**
```js
const paymentLink = b.payment_link || b.balance_payment_link || null;
await r.fn(b, paymentLink);
```
(line 168-169)

⚠ **Bug confirmed via cross-reference with §6:** Neither `payment_link` nor `balance_payment_link` is ever **written** anywhere in the codebase. The columns are read-only orphans. **Result:** reminder emails to customers with unpaid balances never include a clickable "Pay Now" button — recipients have to call/text to figure out how to pay.

**Per-booking error handling:** Each send wrapped in try/catch (line 167-190). A failure on one booking does NOT abort the loop for others. Errors collected into `summary.errors` for the JSON response.

#### Pass 2: Confirmation-email retry (line 193-306)

Picks rows with `confirmation_email_sent = false` AND `booked_at` between 1 hour ago and 7 days ago. Retries up to 5 attempts (tracked via `confirmation_email_retries` counter). On the 5th failure, fires a one-time `sendConfirmationEmailPermanentFailureAlert` (tracked via `reminders_sent.confirmation_perm_fail_alerted`).

**1-hour floor:** Avoids racing with brand-new bookings whose webhook may still be in flight.

**7-day ceiling:** Caps indefinite retries against permanently broken addresses.

#### Pass 3: Post-charter conclude + review (line 308-388)

For every booking where `date === yesterday` (Central time) and `status` is upcoming/null/concluded:
1. Auto-conclude if not already (line 348-363) → `status: 'concluded'`.
2. Send review-request email (line 370-385) → tracked via `reminders_sent.review_requested`.

**Gap noted in §1.8:** Manual "Mark Concluded" via admin doesn't trigger the review email. Only this auto-conclude path does.

#### Pass 4: Leads daily digest (line 390-448)

Queries leads captured in the last 24 hours, groups by status, and sends `sendDailyLeadDigest` to admin. Also computes a 7-day bounce-reason + outcome breakdown for the digest body.

#### Pass 5: Lead retention cleanup (line 450-461)

Hard-deletes unconverted leads older than 90 days via `deleteStaleLeads(90)`. Privacy policy compliance.

### 3.3 Authorization

Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`. Manual curl can use `x-cron-secret` header. Anyone without the secret gets 401 (line 105-108). The secret comes from `CRON_SECRET` env var.

### 3.4 Cron silent-failure modes

1. ⚠ **Payment link missing from reminders** (already covered in §3.2). HIGH-impact customer-facing.
2. The single cron is responsible for five different concerns. If a Supabase query early in pass 1 fails, the whole invocation 500s and passes 2-5 don't run (review request, leads digest, retention cleanup all skip for that day). Mitigation: error-tolerant code per pass — but pass 1's catastrophic query failure at line 126-129 short-circuits to 500.
3. ⚠ Email send failures don't fire a meta-alert. If Resend is down for the day, ALL reminder emails fail silently and admin learns about it only via `summary.errors` in cron response logs — which nobody reads unless they're actively debugging.

---

## 4. Booking creation paths

Every way a row appears in `/bookings`. Each path documented with `session_id` shape and idempotency story vs Stripe webhook retries.

### 4.1 Customer booking wizard

- **Trigger:** Customer fills `booking.html` form → frontend posts to `/api/create-checkout` → Stripe Checkout → customer pays → Stripe fires `checkout.session.completed` → webhook calls `saveBookingWithRetry`.
- **Frontend:** `booking.html` (the public booking wizard).
- **Server entry:** `api/create-checkout.js:174-235` builds the Checkout Session with full metadata (26 keys, same shape as our `f10c429` Payment Link fix).
- **Row creator:** `lib/storage.js:70-114 saveBooking` (called from `api/stripe-webhook.js:464`).
- **`session_id` shape:** Stripe-issued `cs_live_*` (or `cs_test_*`).
- **Idempotency vs Stripe retries:** ✓ Webhook upserts with `on_conflict=session_id` (`saveBooking`, lib/storage.js:90-95). Multiple retries collapse to one row.
- **Side effects on creation:** `upsertCustomerForBooking` (line 100-110), $250 damage hold authorized in the webhook (stripe-webhook.js:361-394), confirmation emails dispatched, lead row converted if matched.

### 4.2 Admin Add Booking (non-stripe-link)

- **Trigger:** Admin clicks "Save Booking" or "Save & Send Confirmation" with payment mode ∈ `{deposit, external, invoice}` (i.e. NOT `stripe-link`).
- **Frontend:** `admin.html:5837-6004 abSave`.
- **Server entry:** `api/admin.js:627-680 handleAddBooking` → `lib/storage.js:474-504 addManualBooking`.
- **Row creator:** Direct INSERT (line 502) with `Prefer: return=minimal`. No upsert — INSERT fails if `session_id` collides.
- **`session_id` shape:** `manual_TIMESTAMP_RANDOM` (lib/storage.js:475-476). Never collides with Stripe.
- **Idempotency vs Stripe retries:** N/A (no Stripe webhook involved in this path).
- **Side effects:** `upsertCustomerForBooking` is called from inside `addManualBooking` via `lib/storage.js:479-485`. Optional `sendConfirmationEmails` if `send_confirmation: true`.

### 4.3 Admin Add Booking — stripe-link chained

- **Trigger:** Admin clicks Save with payment mode `stripe-link`.
- **Frontend:** Two-step chain at `admin.html:5977-5988`:
  1. `POST /api/admin?action=add-booking` (same as 4.2) — creates `manual_*` row.
  2. `POST /api/admin?action=send-payment-link` — creates Stripe Payment Link with `original_session_id` metadata back-link (post-`f10c429`).
- **Eventual row mutation:** When customer pays, webhook's `original_session_id` branch (stripe-webhook.js:344-435) patches the SAME `manual_*` row — no new row created.
- **`session_id` shape:** `manual_*` (persists through payment).
- **Idempotency vs Stripe retries:** ✓ `patchBooking` is idempotent. Setting `paid_in_full: true` repeatedly is safe. Email is NOT strictly idempotent (would resend on retry); see §2.2.2.
- **Fall-through risk:** If admin deletes the `manual_*` row between link-send and link-click, `patchBooking` returns null → falls through to legacy path → inserts a fresh `cs_*` row with full metadata. Two rows could exist briefly, depending on timing of delete vs retry.

### 4.4 Historical CSV import

- **Trigger:** Admin "Import Bookings" tab.
- **Server entry:** `api/admin.js:796-828 handleImportBookings` → `lib/storage.js:354-471 importHistoricalBookings`.
- **Row creator:** Direct INSERT per row (line 465) inside the loop. Hardcodes `paid_in_full: true, remaining_balance: 0, payment_type: 'full', source: 'historical_import', payment_method_external: 'external_platform'` (lines 456-462).
- **`session_id` shape:** `historical_TIMESTAMP_INDEX_RANDOM` (line 384-385). Never collides.
- **Idempotency:** Manual — admin shouldn't re-import the same CSV. There's no de-dup beyond per-row customer matching.
- **Side effects:** Per-row customer match (byEmail then byPhone) or create. No emails. No damage holds.

### 4.5 Webhook orphan-row fall-through

- **Trigger:** Webhook receives `checkout.session.completed` with `meta.original_session_id` set, but `patchBooking` returns null (original row missing).
- **Server entry:** `api/stripe-webhook.js:432-435` — falls through; then legacy code at line 459-464 inserts via `saveBooking`.
- **Row creator:** `lib/storage.js:70-114 saveBooking` with `on_conflict=session_id`.
- **`session_id` shape:** Stripe-issued `cs_*`.
- **Reachability:** Rare. Requires the original row to be deleted between link creation and customer pay. Should be loud in logs (warn at line 432) but no alert email fires.

### 4.6 Summary table

| Path | session_id shape | Idempotent vs Stripe retry | Auto emails | Damage hold |
|---|---|---|---|---|
| 4.1 Wizard | `cs_*` | ✓ upsert on conflict | confirmation + business | yes |
| 4.2 Admin manual (non-link) | `manual_*` | N/A | confirmation if send_confirmation | no |
| 4.3 Admin → stripe-link chain | `manual_*` (patched in place) | ✓ patch is idempotent (email is not strictly so) | confirmation on customer pay | no (skipped per `f10c429`) |
| 4.4 CSV import | `historical_*` | N/A | none | no |
| 4.5 Webhook fall-through orphan | `cs_*` | ✓ upsert | confirmation + business | yes (auto-fires from session.customer fields) |

---

## 5. Payment state transitions

### 5.1 Observed state set

Derived from `status` column reads and `paid_in_full` semantics:

- `status`: `null | 'upcoming' | 'concluded' | 'cancelled'` (and `'disputed'` would be derivable from `dispute_id` non-null, but isn't stored in `status`).
- `paid_in_full`: boolean.
- `remaining_balance`: number.
- `amount_total`: cents paid so far.
- `refund_amount`: dollars refunded.

There is no `payment_status` column. The display badge (admin.html:3612-3619 `bkPaymentStatus`) derives state from `paid_in_full + remaining_balance + amount_total`. Author's note at admin.html:3605-3611 explicitly says `payment_type` is NOT a payment-success signal — it's a "what did the customer choose at checkout" intent record.

### 5.2 Transition table

| From | To | Trigger | Writes | Email | Availability | Audit |
|---|---|---|---|---|---|---|
| (none) | `upcoming + unpaid` | Wizard checkout pre-pay | n/a | n/a | n/a | n/a |
| (none) | `upcoming + deposit_paid` | Wizard payment with deposit selection | webhook saveBooking with `paid_in_full=false, remaining_balance>0` | customer + business confirmation | slot held | session_id stamped |
| (none) | `upcoming + paid_in_full` | Wizard full-payment | webhook saveBooking with `paid_in_full=true, remaining_balance=0` | customer + business | slot held | session_id stamped |
| `deposit_paid` | `paid_in_full` | **`f10c429`-fixed**: customer pays via admin payment link | webhook `original_session_id` branch patches row | customer + business (new) | unchanged | ⚠ no audit row for the second payment |
| `deposit_paid` | `paid_in_full` | Admin "Charge Card" off-session | `markBookingPaid` → patches row | ⚠ **NONE** | unchanged | ⚠ no audit row |
| `deposit_paid` | `paid_in_full` | Admin "Mark Paid" (cash/check) | `markBookingPaid` → patches row | none (intentional) | unchanged | ⚠ no audit row |
| Any | `upcoming → concluded` | Cron auto-conclude (post-charter) | patches `status: 'concluded'` | review request | n/a | `reminders_sent.review_requested = true` |
| Any | `upcoming → concluded` | Admin "Mark Concluded" | patches `status: 'concluded'` | ⚠ **NONE** (cron does it; admin doesn't) | n/a | none |
| Any | `cancelled` | Admin "Cancel Booking" | patches `status: 'cancelled', cancelled_at` | cancellation | slot released | `cancelled_at` |
| `paid_*` | `cancelled + refunded` | Admin "Full Refund" | Stripe refund + patches `refund_amount, refunded_at, status: 'cancelled'` | refund | slot released | `refunded_at` |
| `paid_*` | `cancelled + refund_amount > 0` | Admin "Partial Refund" | Stripe partial refund + patches `refund_amount, refunded_at, status: 'cancelled'` ⚠ (cancels EVEN on partial) | partial-refund | slot released | `refunded_at` |
| `paid_*` | webhook charge.refunded reconcile | Stripe-side refund | patches `refund_amount, refunded_at`, `status: 'cancelled'` if full | refund-reconciled alert (business only) | slot released if full | `refunded_at` |
| `paid_*` | disputed | charge.dispute.created | patches `dispute_id, dispute_status, dispute_amount, dispute_reason, disputed_at` — **`status` NOT changed** | chargeback alert (business only) | unchanged (still held) | `disputed_at` |
| (booking exists) | deleted | Admin "Delete Booking" | hard DELETE | none | slot released (row gone) | ⚠ NONE |

### 5.3 Transitions missing side effects

- ⚠ **"Charge Card" → paid_in_full:** no customer email (HIGH severity).
- ⚠ **"Mark Concluded" (admin) → concluded:** no review email (cron-only).
- ⚠ **"Delete Booking":** no audit trail, hard delete.
- ⚠ **Partial Refund → cancels the booking:** REQUIRES DJ INPUT — this seems like a bug, partial refund should not cancel.

---

## 6. Schema audit

The `bookings` table column list is inferred from every write/read in `api/`, `lib/`, and `admin.html`. There is no migrations folder I can find — schema lives in Supabase only.

### 6.1 Column inventory

| Column | Type (inferred) | Written by | Read by | Status |
|---|---|---|---|---|
| `id` | uuid (Supabase default) | implicit on insert | `lib/storage.js:649` (waiver linkage) | core |
| `session_id` | text, UNIQUE | webhook, addManual, import | almost everywhere | **primary lookup key** |
| `customer_id` | uuid (FK → customers.id) | addManual, import, customer-delete nulls it | listCustomers join | core |
| `customer_email` | text | webhook (from session), addManual, import, edit-modal | many | core |
| `full_name` | text | webhook (from meta), addManual, import, edit | many | core |
| `phone` | text | webhook (meta), addManual, import, edit | many | core |
| `city`, `state` | text | webhook (session.customer_details), edit | listCustomers display | written sometimes |
| `vessel` | text — 'yacht' / 'pontoon' | webhook, addManual, import, edit | many | core |
| `experience` | text | webhook, addManual, import, edit | display | core |
| `charter_name` | text (optional) | webhook, addManual, import, edit | display | core |
| `date` | date (YYYY-MM-DD) | webhook, addManual, import, edit | many — availability, cron | core |
| `time_slot` | text | webhook, addManual, import, edit | availability, cron | core |
| `duration` | integer (hours) | webhook, addManual, import, edit | availability buffer math | core |
| `party_size` | integer | webhook, addManual, import, edit | display | core |
| `add_ons` | text or jsonb (JSON.stringified by webhook + addManual) | webhook, addManual, edit | calcAddOns, email render | **REQUIRES DJ INPUT — type?** |
| `add_on_total` | number | computed by saveBooking + addManual | display | core |
| `special_requests` | text | webhook, addManual, edit | display | core |
| `payment_type` | text — 'deposit' / 'full' | webhook, addManual, markBookingPaid, edit, update-payment | bkPaymentStatus does NOT read; email renderer reads; admin overdue widget reads | core (semantic: customer intent) |
| `grand_total` | numeric | webhook, addManual, import, edit | display, customer record sums | core |
| `deposit_amount` | numeric | webhook, addManual, edit | display | core |
| `amount_total` | bigint (cents) | webhook (session.amount_total), addManual computes, edit | bkPaymentStatus, refund math | core |
| `paid_in_full` | boolean | webhook (`payment_type !== 'deposit'`), markBookingPaid, addManual, edit | bkPaymentStatus, cron filter | core |
| `remaining_balance` | numeric | webhook, addManual, markBookingPaid, edit, `f10c429` patch | bkPaymentStatus, cron filter | core |
| `charter_subtotal` | numeric | webhook, addManual, edit, saveBooking fallback | display | core |
| `admin_fee` | numeric | webhook, addManual, edit | display | core |
| `tax_amount` | numeric | webhook, addManual, edit, saveBooking fallback | display | core |
| `processing_fee` | numeric | webhook, addManual, edit | display | core |
| `promo_discount` | numeric | webhook, addManual, edit | display | core |
| `promo_applied` | boolean (sometimes stringified) | webhook, addManual, edit | email render | core |
| `newsletter` | boolean | webhook (from meta), addManual | customer derivation | core |
| `terms_agreed` | boolean | webhook coerces `meta.terms_agreed === 'true'` | nowhere — written-never-read ⚠ | written-never-read |
| `terms_agreed_at` | timestamptz | webhook | nowhere — written-never-read ⚠ | written-never-read |
| `payment_method_external` | text — 'cash' / 'invoice_pending' / etc. | addManual (when external), edit, update-payment | display | core |
| `stripe_customer_id` | text (cus_*) | webhook | handleChargeRemaining, handleCaptureDamageCharge | core |
| `payment_method_id` | text (pm_*) | webhook | handleChargeRemaining, handleCaptureDamageCharge | core |
| `payment_intent_id` | text (pi_*) | webhook | refund, webhook charge.refunded | core |
| `damage_hold_intent_id` | text (pi_*) | webhook | release-hold, capture-charge | core |
| `damage_hold_status` | text — 'pending' / 'released' / 'captured' / 'failed' | webhook, release-hold, capture-charge | display, action gating | core |
| `damage_charge_amount` | numeric | capture-charge | display | written sometimes |
| `damage_hold_released_at` | timestamptz | release-hold | nowhere ⚠ | written-never-read |
| `damage_captured_at` | timestamptz | capture-charge | nowhere ⚠ | written-never-read |
| `confirmation_email_sent` | boolean | webhook, resend-confirmation, cron retry pass | cron retry filter, get-checkout-session response | core |
| `confirmation_email_retries` | integer | cron retry pass | cron retry pass | cron-internal |
| `reminders_sent` | jsonb | cron passes 1, 2 (perm-fail), 3 (review) | cron passes | cron-internal |
| `status` | text — null / 'upcoming' / 'concluded' / 'cancelled' | webhook (implicit null), cancel, refund, mark-concluded, cron auto-conclude | many | core |
| `cancelled_at` | timestamptz | cancel, refund | display | core |
| `refund_amount` | numeric | refund, charge.refunded webhook | display, idempotency | core |
| `refunded_at` | timestamptz | refund, charge.refunded | display | core |
| `dispute_id` | text | charge.dispute.created webhook | display | webhook-only |
| `dispute_status` | text | charge.dispute.created | display | webhook-only |
| `dispute_amount` | numeric | charge.dispute.created | display | webhook-only |
| `dispute_reason` | text | charge.dispute.created | display | webhook-only |
| `disputed_at` | timestamptz | charge.dispute.created | display | webhook-only |
| `booked_at` | timestamptz | webhook, addManual, import | order-by + retry-window filters | core |
| `source` | text — 'website' / 'historical_import' / etc. | addManual, import | customer derivation | core |
| `source_notes` | text | addManual, edit | display | non-critical |
| `internal_notes` | text | addManual, edit | display | non-critical |
| `created_by_admin` | boolean | addManual, import | nowhere ⚠ | written-never-read |
| `payment_link` | text | **NEVER WRITTEN** | api/cron-reminders.js:168 | **READ-NEVER-WRITTEN** ⚠⚠ |
| `balance_payment_link` | text | **NEVER WRITTEN** | api/cron-reminders.js:168 | **READ-NEVER-WRITTEN** ⚠⚠ |

### 6.2 Schema flags

**(a) Read-never-written orphans:**
- `payment_link` — referenced as fallback at cron-reminders.js:168 for reminder-email payment URL. **Never set anywhere.** Reminder emails therefore never include a payment link button.
- `balance_payment_link` — same.

**(b) Written-never-read deadwood:**
- `terms_agreed`, `terms_agreed_at` — webhook writes them from metadata, no UI or process reads them. Inserted at `f10c429` and pre-existing; intended for compliance audits but no audit path exists. **REQUIRES DJ INPUT:** is this a known TODO?
- `damage_hold_released_at`, `damage_captured_at` — timestamp the operation but nothing reads them.
- `created_by_admin` — set on addManual + import, never read.

**(c) Missing columns the redesign will need:**

Based on `f10c429` aftermath + handoff hints + audit findings:

1. **`payment_link_url`** — the most recent active payment link URL for this booking. Written by `handleSendPaymentLink`, read by cron reminders and admin UI.
2. **`payment_link_id`** — Stripe `plink_*` ID for the active link. Allows future deactivation via `stripe.paymentLinks.update({ active: false })`.
3. **`payment_link_amount_cents`** — what the link was created for. Diverges from `remaining_balance` if admin manually edits the row after sending.
4. **`payment_link_created_at`** — for the `>= deploy_time` check that would have prevented today's $10 confusion.
5. **`payment_link_status`** — `active` / `paid` / `superseded` / `expired`. Allows UI to surface "this link was paid X minutes ago" vs "stale link, customer hasn't clicked."
6. **`balance_payment_intent_id`** — the second payment's PI when the balance is collected via "Send Payment Link" or "Charge Card." Enables admin refund of just the balance payment (separate from the deposit's PI).
7. **`charged_card_intent_id`** — same idea for "Charge Card" off-session collection. Could collapse with #6 if the design names them generically.
8. **`audit_log` jsonb or separate `booking_events` table** — every state transition recorded with `who`, `when`, `what changed`. See §10 architectural gap.
9. **`payment_history` jsonb array** — every payment event with amount, type (deposit/balance/damage_overflow), intent_id, captured_at. Single column or separate table.

---

## 7. Email sends

Every Resend send across the codebase. Cell convention: ✓ = present, ⚠ = silent-on-failure, n/a = not applicable.

| # | Trigger | Function | Recipient | Throws? | Aborts parent? | Defensive alert? |
|---|---|---|---|---|---|---|
| 1 | Customer paid (wizard or balance) | `sendConfirmationEmails` (lib/send-emails.js:457) | customer + business | only if BOTH fail | no | self-fires alert email when customer fails AND business OK (line 525-540) ✓ |
| 2 | Admin Add Booking (send_confirmation flag) | `sendConfirmationEmails` | customer + business | only if both fail | no — saved row stands | inherits #1's alert path ✓ |
| 3 | Resend confirmation manual | `sendConfirmationEmails` via api/resend-confirmation.js | customer + business | only if both fail | no | inherits #1 ✓ |
| 4 | Admin cancel | `sendCancellationEmail` (line 634) | customer | yes | no (logged as `email_warning`) | none ⚠ |
| 5 | Admin refund (full/partial) | `sendRefundEmail` (line 652) | customer | yes | no | none ⚠ |
| 6 | Admin damage capture | `sendDamageChargeEmail` (line 703) | customer | yes | no | none ⚠ |
| 7 | Waiver signed | `sendWaiverConfirmationEmail` (line 861) | signer_email | yes | REQUIRES DJ INPUT (depends on waiver handler — not in this audit's scope but worth noting) | none ⚠ |
| 8 | Admin "Send Waiver Link" | `sendWaiverLinkEmail` (line 915) | customer | yes | no (caller's try/catch) | none ⚠ |
| 9 | Send Payment Link delivery | inline `postToResend` in `handleSendPaymentLink` (api/admin.js:317) | customer | yes | no (returned in JSON) | none ⚠ |
| 10 | Cron 21-day reminder | `sendFriendlyReminderEmail` (line 1083) | customer | yes (caught per booking) | no | none ⚠ |
| 11 | Cron 14-day due-today | `sendDueTodayEmail` (line 1101) | customer | yes (caught per booking) | no | none ⚠ |
| 12 | Cron 13-day owner alert | `sendOwnerAlertEmail` (line 1699) | business | yes | no | n/a (this IS the alert) |
| 13 | Cron 12-day final notice | `sendFinalNoticeEmail` (line 1715) | customer | yes | no | none ⚠ |
| 14 | Webhook damage hold authorize failed | `sendDamageHoldFailedAlert` (line 1123) | business | yes | no (logged) | n/a |
| 15 | Webhook damage hold failed → customer notice | `sendDamageHoldFailedCustomerNotice` (line 1441) | customer | yes | no | n/a |
| 16 | Webhook charge.refunded reconciled | `sendStripeRefundReconciledAlert` (line 1512) | business | yes | no | n/a |
| 17 | Webhook charge.dispute.created | `sendChargebackAlert` (line 1567) | business | yes | no | n/a |
| 18 | capture-lead high-value | `sendHighValueLeadAlert` (line 1182) | business | yes | no (lead is saved) | n/a |
| 19 | Webhook session.expired high-value | `sendHighValueLeadAlert` | business | yes | no | n/a |
| 20 | Webhook payment_failed high-value | `sendHighValueLeadAlert` | business | yes | no | n/a |
| 21 | Cron review request | `sendReviewRequestEmail` (line 1817) | customer | yes (caught) | no | none ⚠ |
| 22 | Cron perm-fail alert | `sendConfirmationEmailPermanentFailureAlert` (line 1651) | business | yes | no | n/a |
| 23 | Cron daily leads digest | `sendDailyLeadDigest` (line 1264) | business | yes (caught) | no | none |

**Summary:** customer-facing sends in rows 4-6, 7-9, 10, 11, 13, 21 all fail silently to admin. Failure only surfaces in JSON responses (rows 4-6, 9) that may or may not be read by the admin UI.

---

## 8. Customers tab kebab clip

### 8.1 Symptom

When the admin opens the kebab dropdown on a booking row INSIDE the Customers tab's expanded customer detail, the menu is clipped by adjacent UI elements — the same symptom the Bookings tab had before commit `1678e56`.

### 8.2 Why the previous fix didn't carry over

Commit `1678e56` ("Admin: fix kebab dropdown layering on Bookings tab") added:

```css
#bookings-wrap table tbody tr.bk-menu-row-open td:last-child {
  z-index: 190;
}
```

(admin.html:1418-1426)

The selector is **scoped to `#bookings-wrap`**. The Customers tab renders bookings inside a customer-detail expansion via `renderCustDetail` at `admin.html:6528`, which lives inside `<td colspan="10">` of a `tr.cust-detail-row` (admin.html:6470).

**Confirmed from code:** the Customers tab does NOT have an equivalent wrap-level ID. The structure is:

```
<div class="table-wrap">              ← class-only, no id  (admin.html:2377)
  <table id="cust-table">             ← table-level id    (admin.html:2378)
    ...
  </table>
</div>
```

The Bookings tab, by contrast, has `<div class="table-wrap" id="bookings-wrap">` (admin.html:1902). The asymmetry (one has the ID, the other doesn't) is why the scoped CSS rule never matched anything in the Customers context.

### 8.3 Stacking context inventory at the customer-detail nested kebab

- Outer table row: `<tr class="cust-detail-row">` (admin.html:1613). CSS at 1613-1614: `padding: 0`, `background: var(--gray-50)`. No `z-index`, no `position`. No own stacking context.
- Inner wrapper: `<div class="cust-detail">` at admin.html:6629. CSS at 1614-1622: `padding: 20px`, etc. No `z-index`.
- Inner booking row: rendered by `renderCustDetail` as a `<tr>` inside a nested table at line 6547 (`<td style="text-align:right">${bkActionMenu(b)}</td>`). The `<td>` has no `position: sticky` (the original Bookings-tab issue was sticky cells trapping the menu in a stacking context).
- `.bk-menu` CSS (need to check exact `position` — typically `position: fixed` per the inline comment in 1678e56's commit message: "position: fixed on .bk-menu doesn't escape the sticky cell's stacking context").

### 8.4 Why the menu still clips in Customers tab

Without `position: sticky` on the nested `<td>`, the original trap shouldn't apply. The clip is more likely caused by:
- The outer `tr.cust-detail-row` or wrapping `<div class="cust-detail">` has `overflow: hidden` or a similar clip rule, OR
- A parent element (the Customers tab's outer wrap, `.customer-row`, etc.) has `overflow: hidden` for its own scroll containment, AND
- The kebab `.bk-menu` is `position: fixed` but its computed `top/left` lands inside an ancestor's clip box because of how `position: fixed` interacts with `transform`, `filter`, `will-change`, or `backdrop-filter` ancestors (any of these convert the parent into a containing block for fixed descendants).

REQUIRES DJ INPUT — confirm by inspecting elements live (DevTools → check whether `position: fixed` on the open menu actually escapes the viewport, or whether some ancestor became a containing block). Code-only diagnosis can't tell without seeing computed styles.

### 8.5 Reference pattern for the fix (not implemented — documentation only)

The `1678e56` fix had two parts:
1. CSS rule scoping the z-index promotion to `#bookings-wrap` open rows.
2. JS toggle code at `admin.html:3218-3260` adding/removing `.bk-menu-row-open` on the parent `<tr>` when the menu opens.

To extend to Customers tab, the rule needs to:
- Either scope the selector additionally to `#cust-table tbody tr.bk-menu-row-open td:last-child` (the actual identifier available in the Customers tab DOM, per §8.2), OR change to a wrap-agnostic selector like `tr.bk-menu-row-open td:last-child` that matches in either tab, AND
- Ensure the JS already adds `.bk-menu-row-open` to the nested booking row — looking at `bkToggleMenu` (line 3218), the code does `const tr = el.closest('tr');` which would close on the **nearest** `<tr>` ancestor. In the Customers tab nested case, that's the booking-detail `<tr>`, which is correct.
- AND fix whatever ancestor `overflow: hidden` / `transform` is clipping the fixed-positioned menu.

This is documentation; the fix itself is out of scope.

---

## 9. Silent-failure inventory

Cross-cutting summary of every place a failure could happen with no notification to either party. Sorted by customer impact.

| # | Where | Failure | Customer learns via | Admin learns via | Severity |
|---|---|---|---|---|---|
| 1 | `handleChargeRemaining` (§1.2) | Card charged, but no confirmation email fires | Nothing (must check card statement) | Inline UI success only — no email to admin | **HIGH** |
| 2 | `handleSendPaymentLink` Resend send (§1.1) | Stripe link created, delivery email fails | Nothing — they never receive the link | Inline 500 if admin watches; otherwise nothing | **HIGH** |
| 3 | Cron reminders payment_link missing (§3.2) | 21/14/12-day emails arrive without a payment link button | Email arrives but has no clickable "Pay" | Nothing | **HIGH** |
| 4 | `handleSendPaymentLink` → no link persistence (§1.1) | Admin can't see active links per booking; re-clicks generate duplicates | n/a (potential confusion if multiple links sent) | Nothing | **MEDIUM** |
| 5 | "Mark Concluded" (§1.8) | No review email request | Nothing (would have wanted the review nudge) | Nothing | **MEDIUM** |
| 6 | `handleCancelBooking` email failure (§1.9) | Booking cancelled but no email | Nothing until they check status | `email_warning` in JSON only | MEDIUM |
| 7 | `handleRefundBooking` email failure (§1.4) | Refund processed but no email | Sees refund on statement, no context | `email_warning` in JSON only | MEDIUM |
| 8 | `handleCaptureDamageCharge` email failure (§1.3) | Damage charge captured but no email | Sees charge, no context | `email_warning` in JSON only | MEDIUM |
| 9 | Webhook `original_session_id` branch double-fire (§2.2.2) | Stripe retries → confirmation email sent twice | Two emails | Nothing (logged only) | LOW |
| 10 | Webhook fall-through orphan (§4.5) | Original row missing → new row created | Email still fires | Log warning, no alert | LOW |
| 11 | `handleDeleteBooking` (§1.10) | Hard delete with no audit | n/a (customer keeps Stripe receipt) | Nothing | LOW (but compliance risk) |
| 12 | Customer edits don't propagate to historical bookings (§1.18) | Old booking shows pre-edit info | Sees stale name/phone if they look | Nothing | LOW |
| 13 | Partial Refund auto-cancels booking (§1.5) | Booking marked cancelled despite partial refund being administratively meant to keep it open | Cancellation email | None | **MEDIUM** if intent was partial-only |
| 14 | Damage hold authorize fail at webhook (§2.2.1) | Customer sees a damage-hold-failed email after booking | Email | `sendDamageHoldFailedAlert` ✓ | n/a (already alerted) |
| 15 | "Release Damage Hold" email | Hold released, no email | Sees less hold on card | Nothing | LOW |
| 16 | Customer types different email at Stripe-hosted payment-link page | Different email than booking has | Confirmation email goes to typed address | Nothing | LOW |
| 17 | Cron pass 1 catastrophic Supabase failure | passes 2-5 skip for the day | Nothing | Logs only | LOW |
| 18 | `confirmation_email_perm_fail_alerted` flag never gets manually cleared | After 5 retries, no further retries even after fixing the address | Stays broken | One alert at 5th failure ✓ | LOW |
| 19 | Stripe sends unhandled event type (line 323-324) | Silent 200 | n/a | Nothing | LOW |
| 20 | refund-by-PI lookup fails because PI is missing on row | Stripe refund happens but DB never reflects | Sees refund on card | charge.refunded handler logs and 200s | MEDIUM |

---

## 10. Gaps for the redesign

Synthesized requirements list. **Total: 19 gaps** (G1-G17 identified at audit shipping; G18 + G19 added during May 13 night session). Each gap has: **what** / **why** / **direction** / **severity** / **depends on** / **evidence**.

### 10.1 Architectural

#### G1 — No persisted payment-link state

- **What:** Payment Links are created in `handleSendPaymentLink` but their URL, ID, amount, and timestamp are never written to Supabase.
- **Why it matters:** Cron reminders can't include "Pay Now" buttons. Admin can't see which link is active or when it was sent. Re-clicking creates duplicate links with no de-dup. Stale pre-deploy links can be the source of empty-metadata confusion (today's $10 incident).
- **Direction:** Add a `payment_links` jsonb array OR dedicated columns (`payment_link_url`, `payment_link_id`, `payment_link_amount_cents`, `payment_link_created_at`, `payment_link_status`). Webhook patches `payment_link_status = 'paid'` when `original_session_id` branch fires.
- **Severity:** HIGH
- **Depends on:** Schema migration (new columns), code change in `handleSendPaymentLink` and webhook's remaining-balance branch
- **Evidence:** §1.1, §3.2, §6.1 (read-never-written `payment_link` / `balance_payment_link`), §9 row 3

#### G2 — Single-funnel payment-state machine doesn't exist

- **What:** Payment state transitions are scattered across `handleMarkPaid`, `handleChargeRemaining`, `markBookingPaid`, the `f10c429` webhook branch, `handleUpdateBooking`, `handleUpdatePayment`. Each writes slightly different field combinations.
- **Why:** Inconsistent state. Admin can't audit "how did this booking get to paid_in_full" without grepping logs.
- **Direction:** Introduce one helper `transitionPaymentState(session_id, transition_type, source, context)` that all writers route through. Single audit trail. Single point for triggering the missing customer-facing email on `handleChargeRemaining`.
- **Severity:** HIGH
- **Depends on:** new helper + refactor all writers (small, mostly mechanical)
- **Evidence:** §5.2, §9 rows 1 + 5

#### G3 — Webhook is the only path that sends customer confirmation on payment

- **What:** Off-session balance collection (`handleChargeRemaining`) bypasses the webhook. No `checkout.session.completed` event fires. No confirmation email is sent.
- **Why:** Customer gets charged silently. Trust erosion. This is bug #3 in handoffs.
- **Direction:** After `markBookingPaid` succeeds in `handleChargeRemaining`, explicitly call `sendConfirmationEmails(...)` with `payment_type: 'full'`. Optional: also persist `balance_payment_intent_id` (see G7).
- **Severity:** HIGH
- **Depends on:** code change only, no schema needed for the immediate fix
- **Evidence:** §1.2, §9 row 1

#### G4 — No audit trail for state transitions

- **What:** Cancel, mark-paid, mark-concluded, charge-card, capture-damage, release-hold, edit-booking, delete-booking — none leave any audit record of who did what when.
- **Why:** Compliance + debugging both blind. "When did Jaida's booking get marked paid?" is unanswerable.
- **Direction:** New `booking_events` table (booking_id, event_type, actor, payload jsonb, created_at). Every state-changing handler appends a row. Read-only from admin UI as a "history" panel per booking.
- **Severity:** MEDIUM
- **Depends on:** new table + helper + writer-side changes
- **Evidence:** §1.7-1.10, §5.3, §9 rows 11 + 12

#### G18 — Incomplete `original_session_id` webhook patch (✅ FIXED in commit `38f8a03`)

- **What:** The `original_session_id` branch added in `f10c429` only patched `paid_in_full`, `remaining_balance`, and `payment_type`. It never wrote `amount_total`, `payment_intent_id`, `stripe_customer_id`, or `payment_method_id` — so the booking row was left half-updated. Bookings-tab pill rendered UNPAID (reads `amount_total`) while the Edit modal correctly showed Paid in Full (reads `paid_in_full` directly). Refund actions were also disabled because they gate on `payment_intent_id`.
- **Why:** Different admin UI surfaces read different columns and reported contradictory states for the same row. Real customer-impact: admin can't see payment, can't refund through UI.
- **Direction (shipped):** Read existing row first via `findBookingBySessionId`; retrieve PI for `payment_method_id` (mirror legacy path at stripe-webhook.js:436-441); write the four transaction-data fields ONLY when the existing column is empty (`0` for `amount_total`, `null` for the three ID fields). State flags (`paid_in_full`, `remaining_balance`, `payment_type`) still flip unconditionally. Conditional gating preserves deposit-flow data; interim until G7 (Phase 2) gives the balance payment its own column.
- **Severity:** HIGH (regression from `f10c429`; live customer-impact)
- **Depends on:** ✅ shipped — no further work in this gap. G7 (Phase 2 schema) will retire the conditional gating.
- **Evidence:** Reproduced live on the $10 Add-Booking-with-stripe-link test row late May 13 night; diagnosed via code analysis (Stripe/Supabase credentials were sensitive and couldn't be pulled locally for live verification). Symptoms matched the predicted column state exactly.

### 10.2 Data model

#### G5 — `payment_type` semantics overloaded

- **What:** Comment at admin.html:3605-3611 says `payment_type` is the customer's chosen option at checkout (intent). But `markBookingPaid` and our `f10c429` branch overwrite it to 'full' on successful balance payment. The email renderer reads it as state.
- **Why:** Two semantics in one column. Future analytics breaks.
- **Direction:** Either:
  - (a) Keep current "intent + state hybrid" but document explicitly that 'full' is the canonical post-paid state; OR
  - (b) Add a separate `payment_method_result` or `paid_via` column for the state portion; OR
  - (c) Stop overwriting `payment_type` and update email renderer to fall back on `paid_in_full` for the label.
- **Severity:** LOW (not urgent, but worth picking a direction)
- **Depends on:** decision first; then either nothing (a), schema (b), or code (c)
- **Evidence:** §5.1, §6.1 row `payment_type`

#### G6 — `terms_agreed` + `terms_agreed_at` written-never-read

- **What:** Webhook writes them on every wizard checkout. Nothing reads them.
- **Why:** Either compliance value that's silently broken, OR deadwood from a previous spec.
- **Direction:** Either expose them in admin UI per booking (compliance audit view) OR drop them from the writer.
- **Severity:** LOW
- **Depends on:** DJ decision
- **Evidence:** §6.1 row `terms_agreed`

#### G7 — No back-link from secondary PaymentIntents to the booking

- **What:** Off-session `handleChargeRemaining` creates a PI with no metadata. Damage-overflow PI has `purpose + booking_session_id` metadata. Send-Payment-Link's auto-generated checkout session has the metadata fix from `f10c429` — but the patched original row doesn't store the new PI ID.
- **Why:** `findBookingByPaymentIntent` can only find the deposit PI. Refunds of balance/overflow payments need manual Stripe dashboard lookup.
- **Direction:** Schema:
  - `balance_payment_intent_id` text
  - `damage_overflow_intent_id` text
  Writers: `handleChargeRemaining` after success, webhook's `original_session_id` branch, `handleCaptureDamageCharge`'s overflow path.
- **Severity:** MEDIUM (low frequency, high pain when it hits)
- **Depends on:** Schema migration + 3 small writer updates
- **Evidence:** §1.2, §9 row 20, §6.2 (c) item 6-7

### 10.3 Communication

#### G8 — Email-failure visibility for admin-initiated actions

- **What:** Cancel, refund, damage capture, send-payment-link, send-waiver-link — every customer email send is wrapped in try/catch with `email_warning` returned in JSON. No alert email fires.
- **Why:** Admin clicks button, sees success, doesn't realize customer wasn't notified. Customer is in the dark.
- **Direction:** Either (a) admin UI surfaces `email_warning` prominently (toast banner that persists), OR (b) any customer-email failure on an admin-initiated action fires a `sendOwnerEmailFailureAlert(booking, action)` so the admin gets an inbox alert.
- **Severity:** MEDIUM
- **Depends on:** code change only — pick (a) or (b) or both
- **Evidence:** §1.4, §1.6, §1.9, §9 rows 6-8, 15

#### G9 — Reminders missing payment link

- **What:** Cron reminders include a "Pay Now" placeholder that reads `b.payment_link` — a column that's never written.
- **Why:** Customers receive nag emails for unpaid balances with no clickable way to pay. They must call/text. Friction = unpaid balances at charter time.
- **Direction:** Requires G1 (persisted payment-link state). Once `payment_link_url` is populated, the cron reads it via the same fallback chain.
- **Severity:** HIGH
- **Depends on:** G1
- **Evidence:** §3.2 (read at api/cron-reminders.js:168)

#### G15 — `email_warning` never surfaced in admin UI

- **What:** Multiple admin-initiated handlers (cancel, refund, damage capture, waiver link, add-booking with confirmation) return `email_warning` in the JSON response when the customer email fails. The admin frontend does not render this field anywhere — it's dropped on the floor.
- **Why:** Admin clicks the button, sees the success toast, never learns the customer didn't get an email. Customer is in the dark. Confirmed dropped per DJ.
- **Direction:** Either (a) admin UI surfaces `email_warning` as a persistent banner/toast on every action that returns it, OR (b) any non-empty `email_warning` triggers a defensive owner alert email (admin gets it in their inbox).
- **Severity:** MEDIUM
- **Depends on:** code change only
- **Evidence:** §1.3, Appendix B Q1

#### G16 — Blackout conflicts with existing bookings fire no alert

- **What:** `handleAddBlackout` (api/admin.js:96-112) inserts a blackout row without checking whether the date/vessel/time_slot collides with an existing booking. No notification fires when admin accidentally blacks out a slot that's already booked.
- **Why:** Admin might block out a day they forgot already has a charter on it. Currently they only find out at charter time when the calendar shows the conflict. Per DJ: defensive alert to the owner is the right move; customer doesn't need to know unless admin decides to cancel.
- **Direction:** Before inserting the blackout row, query for matching active bookings (same date + vessel scope intersects + time_slot overlaps). If any match, fire `sendBlackoutConflictAlert(admin_email, blackout_payload, conflicting_bookings)` and still let the blackout proceed (don't block — admin may have intent). Alert lists the conflicting bookings so admin can decide next step.
- **Severity:** MEDIUM
- **Depends on:** code change only (new helper + new email template + 1 call in `handleAddBlackout`)
- **Evidence:** §1.17, Appendix B Q6

#### G17 — Waiver-signed email best-effort + `terms_agreed` not surfaced

- **What:** Two related communication gaps:
  1. Waiver-signed confirmation email (`sendWaiverConfirmationEmail`) is best-effort. If it fails, no defensive alert fires. Customer-side waiver row still saves but no one knows the email didn't reach the signer.
  2. `terms_agreed` + `terms_agreed_at` are written by the webhook on every wizard checkout but never displayed in admin UI. Per DJ this is intended as a compliance audit trail that's currently silently invisible.
- **Why:** Compliance value is silently broken (terms_agreed) AND waiver email failures go unnoticed.
- **Direction:** Two-part fix in one gap:
  1. Wrap waiver-confirmation send in a try/catch that, on failure, fires `sendWaiverEmailFailureAlert(waiver_row, error)` to admin. Waiver row still saves regardless.
  2. Add a "Terms Acknowledged" line item to the admin booking-detail panel rendering `terms_agreed_at` (or "Not on file" if null).
- **Severity:** MEDIUM
- **Depends on:** code change only (alert path + small admin UI addition)
- **Evidence:** §6.2 (terms_agreed flag), §7 row 7 (waiver email best-effort), Appendix B Q12 + Q13

### 10.4 Idempotency

#### G10 — Confirmation-email idempotency on webhook retry

- **What:** Stripe retries on 5xx. The `original_session_id` branch is idempotent at the DB level (patchBooking) but NOT at the email level — a 5xx after the email send but before the response would resend the email on retry.
- **Why:** Customer gets the same "your charter is confirmed" email twice. Low impact but tacky.
- **Direction:** Either:
  - (a) Check `updated.confirmation_email_sent === true` before sending in the remaining-balance branch (skip if already sent), OR
  - (b) Track a fingerprint per (session_id, event.id) to detect retries; OR
  - (c) Accept it as a minor cost of Stripe-retry safety.
- **Severity:** LOW
- **Depends on:** code change in webhook
- **Evidence:** §2.2.2

#### G11 — Partial refund auto-cancels the booking

- **What:** `handleRefundBooking` sets `status: 'cancelled'` (line 430) regardless of whether refund is full or partial.
- **Why:** Admin's intent on a partial refund is usually "compensate the customer for X" not "cancel the charter." Auto-cancelling frees the slot up (availability.js excludes cancelled bookings) and could lead to double-booking.
- **Direction:** Set `status: 'cancelled'` only on full refunds. On partial refunds, leave status alone (or introduce `status: 'partial_refund'`).
- **Severity:** MEDIUM (potentially HIGH if a partial refund has actually freed a slot and another customer booked it)
- **Depends on:** code change (one-liner)
- **Evidence:** §1.5, §5.2 partial-refund row, §9 row 13

### 10.5 UI

#### G12 — Customers-tab kebab clip

- **What:** Kebab dropdown clipped in Customers tab booking history.
- **Why:** Admin can't reliably use Send Payment Link, Mark Paid, etc. from the Customers tab without scrolling around.
- **Direction:** Either extend the `#bookings-wrap` z-index rule to also match `#customers-wrap` (assuming that's the parent ID — REQUIRES DJ INPUT), or unscope the selector entirely. Plus inspect ancestor `overflow: hidden` / `transform` (see §8.4).
- **Severity:** LOW (workaround: open booking from Bookings tab)
- **Depends on:** code change only
- **Evidence:** §8

#### G19 — booking-confirmation.html error page after admin-flow payment

- **What:** After a customer pays via an admin-initiated Stripe Payment Link, the post-payment redirect lands them on `booking-confirmation.html` which renders a "something went wrong" error page. The underlying DB state is correct (verified — G18 fix wrote the row properly), but the customer sees a failure UI despite a successful charge.
- **Why:** Customer trust signal at the worst moment. They just paid; the page should celebrate, not apologize. Recoverability requires admin to reach out manually to reassure them.
- **Direction:** Suspected cause — `booking-confirmation.html` expects a `session_id` query parameter shape from the customer-wizard checkout flow (a `cs_*` Stripe session id that exists in `bookings` table). The admin-flow Payment Link redirect either omits the param, passes a session id that doesn't match the patched `original_session_id` row, or the page's lookup logic doesn't account for the admin-flow shape. Fix is two-sided: (a) ensure `handleSendPaymentLink` configures `after_completion.redirect.url` with the right session id template, and (b) update `booking-confirmation.html` to handle the admin-flow case (or fall back gracefully if no session_id param is present).
- **Severity:** MEDIUM (customer-facing UI bug; cosmetic in DB-state terms but real in customer-experience terms)
- **Depends on:** code change only (frontend page logic + likely the redirect URL string in `handleSendPaymentLink`)
- **Evidence:** Reproduced May 13 night during G18 verification. DJ saw the page after successfully paying the $10 test link.

### 10.6 Refund / lifecycle

#### G13 — Hard delete of bookings

- **What:** `handleDeleteBooking` does a hard DELETE.
- **Why:** No recovery if admin clicks by accident. Stripe receipt persists; we have no record.
- **Direction:** Soft-delete via `deleted_at` timestamp. Hide from default listings, keep in DB. Optional: archive table.
- **Severity:** LOW-MEDIUM (compliance risk in edge cases)
- **Depends on:** schema (add `deleted_at`) + filter changes in `getBookings` and availability queries
- **Evidence:** §1.10, §9 row 11

#### G14 — Send Payment Link has no de-dup or supersede semantics

- **What:** Clicking the kebab "Send Payment Link" twice creates two active Stripe Payment Links. Either can be paid. Both will fire the webhook. The `original_session_id` branch patches the same row each time → effectively double-pay if customer clicks both links.
- **Why:** Customers do click old emails. If the second link is for a different amount (because admin edited the row between sends), one of them is wrong.
- **Direction:** On send, if a previous active link exists, deactivate it (`stripe.paymentLinks.update(id, { active: false })`) before creating the new one. Requires G1 (persisted state) to know the previous link's ID.
- **Severity:** MEDIUM (low-probability but plausible)
- **Depends on:** G1
- **Evidence:** §1.1 gaps list

### 10.7 Suggested commit sequence

For the next session, the dependency graph suggests this order:

1. **Phase 1 (code-only, no migrations):** ~~G11 (partial-refund no auto-cancel)~~ ✅ shipped `e754b8b` 2026-05-13 night, ~~G18 (incomplete original_session_id patch; regression hotfix)~~ ✅ shipped `38f8a03` 2026-05-13 night, **G19 (booking-confirmation error page)** ← next priority, G12 (kebab clip), G3 (charge-card confirmation email), G8 (email-failure visibility), G10 (idempotency check), G15 (surface `email_warning`), G16 (blackout-conflict alert), G17 (waiver-email alert + `terms_agreed` admin UI).
2. **Phase 2 (schema migration):** Add columns for G1, G7, G13 in one migration. Then ship the code that writes/reads them.
3. **Phase 3 (refactor):** G2 (single payment-state machine) and G4 (booking_events audit table). These are bigger refactors that benefit from Phase 1/2 being landed first.
4. **Phase 4 (cleanup):** G5 (payment_type decision), G6 (terms_agreed decision — note: G17 surfaces `terms_agreed` in the admin UI; G6 then becomes a narrower "keep or drop the column" decision), G14 (link de-dup — requires G1).

---

## Appendix A — File index

| File | Lines audited |
|---|---|
| `admin.html` | 1485-1524 (CSS), 3150-3210 (kebab menu), 3605-3619 (badge), 4755-4770 (overdue), 4837-4848 (table cell), 5837-6004 (Add Booking), 6181-6205 (kebab handlers), 6456-6629 (Customers detail) |
| `api/admin.js` | 1-205 (router, login, blackouts, mark-paid, update-booking), 206-345 (charge-remaining, send-payment-link), 350-680 (mark-concluded, cancel, refund, damage hold, waivers, delete, search, add-booking), 682-941 (customers, update-payment, waivers list, leads) |
| `api/stripe-webhook.js` | full (663 lines post-`f10c429`) |
| `api/create-checkout.js` | full (240 lines) |
| `api/cron-reminders.js` | full (465 lines) |
| `api/resend-confirmation.js` | full (117 lines) |
| `api/send-confirmation.js` | full (75 lines) |
| `api/capture-lead.js` | full (146 lines) |
| `api/availability.js` | full (86 lines) |
| `api/get-checkout-session.js` | full (60 lines) |
| `lib/storage.js` | full (858 lines) |
| `lib/send-emails.js` | 1-175 (helpers), 175-550 (customer/business confirmation, alert), 555-720 (cancel, refund, damage), 1080-1130 (cron reminders), 1699-1737 (owner alert, final notice) |
| `vercel.json` | full (32 lines) |

## Appendix B — REQUIRES DJ INPUT (consolidated)

Bundle of questions where the audit needs DJ to answer before the redesign can resolve them.

1. **§1.3:** Is `email_warning` from `handleCaptureDamageCharge` surfaced anywhere in the admin UI, or just dropped on the floor?
2. **§1.4:** In production logs, has `sendStripeRefundReconciledAlert` ever double-fired alongside an admin-initiated refund? (The idempotency guard at line 117-123 should prevent it, but worth confirming.)
3. **§1.5:** Is auto-cancelling on Partial Refund (line 430) intentional or a bug? See G11.
4. **§1.12:** Does `handleUpdatePayment` still have a frontend trigger, or did Edit Booking absorb it?
5. **§1.14:** In `abSave` after the chained `send-payment-link` call (admin.html:5985), does the frontend distinguish step-2 failures from step-1 successes? Code reads as silent — confirm.
6. **§1.17:** When admin adds a blackout that conflicts with an existing booking's slot, should anything notify the customer or admin? Current behavior: silent.
7. **§1.18:** Customer edits don't propagate to historical bookings. Intentional (preserve booking-time snapshot) or a bug?
8. **§1.19:** CSV import hardcodes `payment_type: 'full', paid_in_full: true`. If a deposit booking is imported, this is wrong. Is the CSV format meant to support deposits, or are all imports always paid in full?
9. **§1.20:** Confirm both webhook auto-conversion and admin manual conversion produce the same lead-row shape (no double-counting in analytics).
10. **§2.2.2:** Is double-emailing on Stripe webhook retry acceptable, or do we want the idempotency check from G10?
11. **§6.1 `add_ons`:** Type — text or jsonb? Code stringifies in `addManualBooking` (line 488-490) and at the webhook, but reads back without a parse in some places.
12. **§6.2 (b) `terms_agreed`/`terms_agreed_at`:** Compliance TODO or deadwood?
13. **§7 row 7:** Does the waiver-signed flow abort if the confirmation email fails, or is it best-effort?
14. **§8.2:** ~~Confirm the Customers-tab outer wrap ID (likely `#customers-wrap`).~~ **Resolved by code inspection:** the Customers tab has NO wrap-level ID. The structure is `<div class="table-wrap">` (class-only, admin.html:2377) wrapping `<table id="cust-table">` (admin.html:2378). The fix needs to scope to `#cust-table` or use a wrap-agnostic selector. See §8.2 for the full asymmetry write-up.
15. **General — webhook retry policy:** Are we OK accepting Stripe's default 3-attempts-over-3-days retry schedule for permanent failure, or do we want a longer/shorter window in some places?

## Appendix C — Cross-reference: incidents → sections

- **Jaida Matthews $746.08 empty metadata (pre-`f10c429`):** §1.1 (fixed handler), §2.2.2 (new branch), §10.G1
- **$10 live test empty metadata (post-`f10c429`):** §1.1 (single-funnel confirmed), §10.G1 (persisted state would have helped diagnose), pending live verification
- **Kebab clipping (handoff item):** §8, §10.G12
- **Bug #3 (Charge Card silent confirmation):** §1.2, §10.G3
- **`payment_link` / `balance_payment_link` field hint:** §3.2, §6.1, §10.G1, §10.G9

## Appendix D — Tooling notes

- All file reads via Read tool. No external schema introspection available (no Supabase CLI in this environment) — column types inferred from code usage.
- Greps used: `paymentLinks|payment_link|paymentLink` (cross-reference), `^async function|^function send` (email send catalog), `payment_type` (semantics audit), `Send Payment Link|sendPaymentLink` (UI trigger map), `handleAddBooking|addManualBooking` (creation path), `ROUTES|action=` (router inventory).
- `git diff main~1 main -- api/admin.js admin.html` verified the `f10c429` commit shape.
- `git show 1678e56 -- admin.html` retrieved the prior kebab fix for §8 reference.
- No Vercel CLI access — deploy/env verification deferred to DJ.

## Appendix E — DJ's answers to Appendix B (2026-05-13)

Answers provided in the same chat that approved this audit. Numbered 1-to-1 with Appendix B.

1. **§1.3 `email_warning` surface** — not currently surfaced anywhere in admin UI. Dropped on the floor. Bug.
2. **§1.4 double-fire reconciled alert** — never noticed it firing twice in production. Idempotency guard probably works. Leave as-is, no change needed.
3. **§1.5 partial refund auto-cancel** — BUG. Never intentional. Always wanted partial refunds to leave the booking active. G11 is correct.
4. **§1.12 `handleUpdatePayment`** — Edit Booking absorbed it as far as I know. Worth confirming during the rewrite that no UI still calls it.
5. **§1.14 `abSave` silent step-2 failure** — silent, and that's a bug. If the chained send-payment-link fails after the booking was created, I should see it.
6. **§1.17 blackout conflicts with existing booking** — should fire a defensive alert to me (the admin). Customer doesn't need to know unless I decide to cancel. Add to the redesign scope.
7. **§1.18 customer edits don't propagate** — intentional. Preserve booking-time snapshot.
8. **§1.19 CSV import hardcodes `paid_in_full`** — currently correct. Every CSV import to date has been a FareHarbor record of a fully completed charter. If that ever changes I'll flag it. Leave as-is for now.
9. **§1.20 lead-row shape consistency** — confirm during the rewrite. Don't have a confident answer right now.
10. **§2.2.2 double-email on Stripe retry** — I want the G10 idempotency check. No double emails.
11. **§6.1 `add_ons` type** — should be jsonb. If code is stringifying somewhere, that's a bug. Verify during rewrite.
12. **§6.2 `terms_agreed`** — compliance value, not deadwood. Need to expose it in admin UI per booking. Add to scope.
13. **§7 row 7 waiver-signed email failure** — best-effort is wrong. Should fire a defensive alert if it fails. Customer-side waiver state should still save.
14. **§8.2 Customers-tab wrap ID** — Claude Code should grep admin.html for the outer wrapper of the customers tab. I don't have it memorized. Confirm from code. **(Resolved during this update — see §8.2 + Appendix B Q14 for the answer: no wrap ID exists; `#cust-table` is the table-level ID; wrap is a class-only `.table-wrap`.)**
15. **Webhook retry policy** — Stripe's default 3-attempts-over-3-days is fine. No customization needed.

### New gaps introduced by these answers

- Q1 → **G15** ("`email_warning` never surfaced in admin UI"), severity MEDIUM, code-only, in §10.3 Communication.
- Q6 → **G16** ("Blackout conflicts with existing bookings fire no alert"), severity MEDIUM, code-only, in §10.3 Communication.
- Q12 + Q13 → **G17** ("Waiver-signed email best-effort + `terms_agreed` not surfaced"), severity MEDIUM, code-only, in §10.3 Communication.

All three are Phase 1 in the suggested commit sequence (§10.7).

### Answers that adjust existing gaps

- Q3 (partial refund auto-cancel = bug) → confirms G11 is correctly classified as a bug, not a debate.
- Q10 (no double emails) → settles G10 in favor of option (a) or (b), not (c).
- Q11 (`add_ons` should be jsonb) → REQUIRES verification during the rewrite. If the code is stringifying anywhere, that's a separate fix not captured as a numbered gap yet — flag it then.
- Q12 (`terms_agreed` is compliance) → reframes G6: instead of "expose or drop," it becomes "expose" (per G17), and G6 narrows to "keep or drop the column itself."

### Answers that do NOT introduce new gaps

- Q2 (no double-fire reconciled alert in practice) → no change.
- Q4 (confirm during rewrite that no UI calls `handleUpdatePayment`) → verification item, not a gap.
- Q5 (silent step-2 failure in `abSave`) → already covered by G15 (`email_warning`-style visibility) for the API failure side; the JS silence at admin.html:5985 should also be addressed in Phase 1 alongside G15.
- Q7 (snapshot semantics intentional) → no change.
- Q8 (CSV import correctness) → no change for now.
- Q9 (lead-row shape) → verification item.
- Q14 (wrap ID) → resolved here.
- Q15 (Stripe retry policy) → no change.
