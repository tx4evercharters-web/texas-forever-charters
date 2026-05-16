# Portal balance payment — TFC-branded confirmation email

## Scope

Add a TFC-branded "balance received" email that fires after a customer pays their remaining balance via the portal Pay Balance Now flow.

Today the customer relies on Stripe's auto-receipt (generic "you paid $X to Texas Forever Charters"). A branded follow-up email confirms the charter is now fully paid, restates the charter date/vessel, and links back to the portal.

## Why deferred

Phase 4 Commit 8 (Stripe Checkout balance payment) intentionally skipped this to keep the commit narrowly scoped to the money-moving paths. Stripe's auto-receipt covers the legal/technical confirmation requirement. The branded follow-up is UX polish.

## Where to wire

- New helper in `lib/send-emails.js` modeled after `sendPortalLinkEmail` (commit `820e8d7`) and `sendWaiverLinkEmail`:
  - `buildBalancePaidEmail(booking, amountCents)` — HTML body using existing `emailWrapper` / `emailHeader` / `emailFooter` / `sectionBox` helpers.
  - `sendBalancePaidEmail(booking, amountCents)` — calls `postToResend`.
  - Export both in module.exports.
- Subject: "Your Texas Forever Charters Balance Is Paid In Full" (no em-dash, em-dash rule applies).
- Body content:
  - Greeting using first name (`(b.full_name || '').split(' ')[0] || 'there'`).
  - "Your remaining balance of $X has been received. Your charter on <date> is now fully paid."
  - Big red CTA → portal URL.
  - Plain-text fallback URL.
  - Phone/email fallback contact.

## Where to call it

`api/stripe-webhook.js` → `handleBalancePayment(event, res)` — call after the successful `patchBooking` and after `logBookingEvent`, BEFORE returning the 200 response. Wrap in try/catch — email send failure must not unwind the payment state mutation. On failure, log loud + fire `sendAdminActionEmailFailureAlert` so admin gets a paper-trail email.

## Estimated diff size

- `lib/send-emails.js`: ~+55 lines (build + send + export)
- `api/stripe-webhook.js`: ~+15 lines (call site + defensive alert)
- Total: ~+70 lines, single commit.

## Verification

- Trigger a balance payment via portal Pay Balance flow.
- Confirm customer receives BOTH Stripe's auto-receipt AND the new TFC-branded "balance paid" email.
- Stripe Resend dashboard should show 2 successful sends per balance payment (admin "New Booking Update" alert + customer "Balance Paid" email).

## Concurrent with this commit

When this ships, also remove the "If you have a remaining balance, you'll receive a separate payment reminder email closer to your charter date." line from `buildPortalLinkEmail` in `lib/send-emails.js` (commit `820e8d7`) — the placeholder no longer applies once balance payments are self-serve through the portal.

## Reference

- Phase 4 Commit 8 (Stripe Checkout balance payment): the money flow this email closes the loop on.
- `lib/send-emails.js` existing helpers `sendPortalLinkEmail`, `sendWaiverLinkEmail`, `sendConfirmationEmails` — the established template pattern.
