# G19 follow-up — admin-flow confirmation-page consistency

**Status:** queued. Starter doc only. Not implemented.
**Parent fix:** G19 primary fix (this session's commit) — `handleSendPaymentLink` redirect URL now includes `?session_id={CHECKOUT_SESSION_ID}` so the confirmation page renders the success UI instead of the error panel.
**Related audit refs:** `docs/audits/admin-comprehensive-audit-2026-05-13.md` §10.5 G19; `docs/audits/admin-audit-2026-05-14.md` §6 + §10 P1.3 (out-of-scope items list).

After the primary G19 fix, the admin-flow confirmation page loads and renders the success UI — but three secondary inconsistencies remain because the page is wizard-shaped and the admin-flow's row keys differently in Supabase than the Stripe checkout session id used in the URL. None are P0/P1 (the customer sees the right amount paid and right charter details), but all three together are a polish gap worth a focused commit before Phase 2.

## 1. Booking reference number uses Stripe checkout session id, not the original booking session id

`booking-confirmation.html:775` renders the booking reference as `session.id.slice(-12).toUpperCase()`. For admin-flow payments, `session.id` is the Stripe auto-generated `cs_live_*` checkout session id from the payment-link completion event, NOT the admin's original booking `session_id` (which is a `manual_*` shape or the original wizard `cs_*`). The customer sees a reference code that won't match the admin's Bookings tab if they ever cross-reference. The cleanest fix: in `booking-confirmation.html`'s `renderConfirmation`, prefer `meta.original_session_id` for the ref-number computation when present, fall back to `session.id`. The metadata is already on the wire (post-`f10c429` payment-link metadata block includes `original_session_id`), no API changes needed.

## 2. Waiver link on the confirmation page points to a session_id that doesn't exist in `bookings`

`booking-confirmation.html:779` builds `/waiver.html?session_id=<session.id>`. The waiver page calls `/api/waiver?session_id=<session.id>` which does `findBookingBySessionId(session_id)` — returns null for admin-flow because the booking row's `session_id` is the original (`manual_*` etc.), not the Stripe `cs_live_*`. The customer who clicks "Sign the Waiver" from an admin-flow confirmation page gets a "Booking not found" error. Lower frequency than #1 because admin-flow payments are usually balance-due collections where the customer already engaged with the waiver at initial booking, but still broken. Same fix surface as #1: prefer `meta.original_session_id` when building the waiver URL.

## 3. `get-checkout-session.js` does not need changes, but worth confirming

`api/get-checkout-session.js:46` already passes `session.metadata` through to the response unchanged, so the frontend can read `metadata.original_session_id` without backend changes. The endpoint also does a best-effort `findBookingBySessionId(session_id)` and returns `booking: null` when no row matches — which is fine for admin-flow (the `confirmation_email_sent` truthy check at `booking-confirmation.html:785` already handles the null case). If we ever want to additionally surface the patched original-booking row to the confirmation page (e.g., to show the admin-flow's true ref code as a fallback when frontend logic can't compute it), the endpoint could do a second lookup: if `metadata.original_session_id` is set and `findBookingBySessionId(session_id)` returned null, retry the lookup with the original id. **Tentative recommendation:** don't add the second lookup; let the frontend prefer `meta.original_session_id` and keep the API surface unchanged. Re-evaluate if a future feature needs the admin-flow row data on the confirmation page.

---

## Suggested commit shape for the follow-up

Single file edit to `booking-confirmation.html`:

- In `renderConfirmation`, after reading `meta = session.metadata || {}`, compute `const refSourceId = meta.original_session_id || session.id;` and use `refSourceId` for both the booking-reference display (line 775) and the waiver link (line 779).
- That's it. One change in two callsites. No API change. No webhook change. No CSS change. No copy change.

Triple-gate cadence: audit → propose → diff → approve → commit. Should be a ~15-minute commit when picked up.
