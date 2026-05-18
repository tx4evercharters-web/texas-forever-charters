# Follow-up: admin Send Payment Link still uses Stripe Payment Link (not portal)

**Status:** queued. Starter doc only. Not implemented.
**Parent fix:** "centralize payment in customer portal - remove payment links from automatic cron-fired reminders, preserve admin-initiated payment links" (this session's commit).
**Related audit refs:** `docs/audits/admin-comprehensive-audit-2026-05-13.md` §1.1 (`handleSendPaymentLink`); `docs/audits/admin-audit-2026-05-14.md` row P1.2; `docs/handoff/next-session.md:363` (the `payment_link` field is read by cron but never written).

## State after parent fix

The parent commit centralizes the **cron-fired** customer reminder emails on the portal: the 21/14/12-day templates (`buildFriendlyReminderEmail`, `buildDueTodayEmail`, `buildFinalNoticeEmail`) no longer accept a `paymentLink` argument, no longer render `paymentLinkBlock`, and now route customers exclusively through the booking portal's Pay Balance Now button.

The **admin-initiated** Send Payment Link flow (`handleSendPaymentLink`, `api/admin.js:404-536`) is unchanged. It still:

1. Creates a fresh Stripe Payment Link via `stripe.paymentLinks.create({...})` with full metadata and `original_session_id` back-link.
2. Sends its own inline-HTML email via `postToResend` (lines 494-514) with a "Pay $X" button that links to the Stripe Payment Link.
3. Does NOT mention the booking portal at all.

The admin email is structurally independent of `lib/send-emails.js` templates. It uses its own header/body markup written inline in the handler.

## The architectural drift

Customer-facing payment now has two parallel mechanisms that don't align:

| Path                       | Email content                              | Stripe surface                       | Portal mention |
|----------------------------|--------------------------------------------|--------------------------------------|----------------|
| Customer self-serve        | Portal CTA only (post parent fix)          | Stripe Checkout Session (one-shot)   | Yes (primary)  |
| Cron-fired reminders       | Portal CTA only (post parent fix)          | n/a (no payment surface in email)    | Yes (primary)  |
| Admin Send Payment Link    | Stripe Payment Link button (inline HTML)   | Stripe Payment Link (reusable URL)   | No             |

The customer can hit the portal from any of their booking-time / reminder emails, but an admin-triggered email points them at a fundamentally different payment surface that the rest of the system has moved away from.

## Why this is worth fixing

1. **Single source of truth.** The portal is now the canonical place a customer pays. Admin sends should reinforce that pattern, not split it.
2. **Idempotency and audit trail.** Portal Checkout Sessions are scoped per-session with `metadata.payment_type='balance'` and a deterministic idempotency key (`portal_balance_<session_id>`). The webhook routes balance events through `handleBalancePayment` with a `paid_in_full` idempotency check. Admin Payment Links route through a different webhook branch (`meta.original_session_id`) with different idempotency semantics.
3. **Cosmetics.** The admin-initiated email body (`api/admin.js:498-513`) is bare-bones inline HTML that doesn't match the design language of the cron reminder templates. Migrating to a shared template would tighten brand consistency.
4. **Drift risk.** Every customer-facing email surface routes through `lib/send-emails.js` template builders except this one. Templates evolve; this handler will keep drifting.

## Why this was deliberately scoped out of the parent commit

DJ explicitly carved admin sends out of the parent task scope: *"Admin UI changes for adding a manual 'include payment link' toggle — admin sends keep their existing behavior, whatever that currently is."* and *"the Stripe Payment Link generation logic itself — keeping Payment Links as a feature for admin use; only removing their automatic email injection."*

So the parent commit was scoped to the cron path. This follow-up is the next-logical-step question: do we also want the admin send to pivot to the portal, or do we keep it as a deliberate two-track system?

## Two ways to pivot (when picked up)

### Option A — Replace admin Send Payment Link with admin Send Portal Reminder

Rewrite `handleSendPaymentLink` to skip Stripe Payment Link creation entirely. Send an email that points the customer at their portal URL. The portal's existing Pay Balance Now button + `/api/portal-checkout` flow handles the actual payment.

- Pros: full alignment. Single payment surface. Webhook idempotency is uniform. Template can reuse `buildFriendlyReminderEmail` or a new admin-tone variant.
- Cons: loss of the "admin can copy the Stripe URL and text it to the customer" affordance that the current Payment Link flow provides. The portal URL would be the copy-paste artifact instead.

### Option B — Keep Stripe Payment Link, but rewrite the email to lead with the portal

Keep `handleSendPaymentLink` creating a Stripe Payment Link (so the URL artifact still exists for admin's manual workflows). Rewrite the email body to lead with "your booking portal" and demote the Stripe URL to a secondary "or pay directly" link.

- Pros: zero behavior change to the admin workflow; cleanup is purely cosmetic / informational.
- Cons: still maintains two parallel payment surfaces. Doesn't solve the architectural drift, just papers over the customer-visible surface.

Option A is the principled cleanup. Option B is the pragmatic one if the admin team is actively using the Stripe URL copy-paste affordance.

## Files in scope (when picked up)

- `api/admin.js` — `handleSendPaymentLink` (lines 404-536). Either rewrite to skip `stripe.paymentLinks.create()` (Option A) or rewrite the inline email body only (Option B).
- `lib/send-emails.js` — if Option A, add an `sendAdminPortalReminderEmail(booking)` builder + sender that leans on the existing `buildFriendlyReminderEmail` shape. Admin tone (less perky than the cron reminder, since this is a directed nudge).
- `admin.html` — Send Payment Link button label may want a relabel ("Send Portal Reminder"?). UI copy + button tooltip.
- Webhook — no change. Portal balance flow already exists.

## Out of scope for the eventual fix

- The Stripe Payment Link generation feature itself stays available as a Stripe-dashboard-level capability. Removing it from the admin-triggered email doesn't remove it from Stripe.
- The `payment_link` / `balance_payment_link` booking-row fields stay nullable (nothing writes them after the parent commit; the cron no longer reads them).

## Verification when implemented

- Trigger Send Payment Link (or its replacement) from admin on a real upcoming unpaid booking. Confirm the email arrives, the embedded link routes the customer to a payment surface, and the post-payment webhook lands `paid_in_full=true` on the correct booking row.
- If Option A: confirm the admin email's portal URL matches `portalUrlFor(booking)` and that clicking through hits the customer's portal with the correct token.
- If Option B: confirm the portal mention is positioned as the primary CTA and the Stripe link reads as the fallback.
