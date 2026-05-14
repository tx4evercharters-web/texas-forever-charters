# G17 follow-up: handleSendWaiverLink lacks defensive alert path

**Status:** queued. Starter doc only. Not implemented.
**Parent fix:** "Admin waiver: defensive alert on email failure + surface terms_agreed_at in booking detail panel (G17)" (this session's commit).
**Related audit refs:** `docs/audits/admin-audit-2026-05-14.md` §10 row P2.13.

After the primary G17 fix, the **customer-side** waiver-confirmation email failure path is wired into the G15 defensive-alert infrastructure. The **admin-side** waiver-link delivery path (`handleSendWaiverLink`, `api/admin.js:786-802`) is the symmetric gap and remains uncovered. This doc captures it as a follow-up so the surface area is documented for whoever picks it up next.

## The bug

`handleSendWaiverLink` (`api/admin.js:786-802`) currently does:

```js
try {
  const booking = await findBookingBySessionId(session_id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (!booking.customer_email) return res.status(400).json({ error: 'No customer email on this booking — cannot send.' });

  await sendWaiverLinkEmail(booking);
  return res.status(200).json({ ok: true });
} catch (err) {
  console.error('send-waiver-link error:', err.message);
  return res.status(500).json({ error: err.message });
}
```

If `sendWaiverLinkEmail` throws (Resend outage, malformed Booking, anything), the handler returns 500. The admin sees the failure as a frontend error toast. There is no defensive alert path: nothing in the business inbox, no `email_warning` in a 200 response, no separate paper trail.

## Why this is lower-urgency than G17 Part 1

The two failure modes have different visibility profiles:

- **G17 Part 1** (waiver-confirmation, customer-triggered): silent. Customer signs, server records the row, email fails, **nobody sees anything**. The admin only learns about it when the customer eventually complains they didn't get a copy. That's what made the defensive alert load-bearing.
- **This case** (waiver-link send, admin-triggered): loud. Admin clicks Send Waiver Link, function returns 500, frontend surfaces the error toast immediately. Admin sees the failure in real time and can retry.

So this case is NOT silent the way G17 Part 1 was. It's lower urgency.

## Why it is still worth fixing

Two reasons:

1. **Pattern consistency with G15 + G8.** The other admin-action handlers that send a customer-facing email all return 200 with `email_warning` on email failure (rather than 500), and fire the defensive alert. The waiver-link handler is the odd one out. A future refactor that systematizes admin-action email handling will trip over this asymmetry; cleaning it up now keeps the surface uniform.
2. **Retry-and-tab-close edge case.** If the admin clicks Send Waiver Link, sees the error toast, refreshes or closes the tab, and walks away thinking "I'll come back to it" but never does, the customer never gets the link. The defensive alert in the business inbox would catch this slow-leak case where the admin's loud error gets dropped on the floor by their own attention shift.

## Fix direction

Restructure `handleSendWaiverLink` similar to `handleSendPaymentLink` (the precedent set by the parent commit of "Admin Send Payment Link: separate Stripe-create from email-send failure"). Specifically:

- The current `try { ... } catch (err) { 500 }` block conflates lookup/validation failures (which SHOULD be 4xx/5xx) with email-send failures (which should be 200 + `email_warning`).
- Split: lookup + validation throws → 5xx (existing behavior). Email send fails → wrap in inner try/catch, capture `email_warning`, fire `sendAdminActionEmailFailureAlert('send-waiver-link', booking, booking.customer_email, err.message)`, return `200 { ok: true, email_warning }`.
- Add a new entry to `ADMIN_ACTION_LABELS` in `lib/send-emails.js` for `'send-waiver-link'` matching the existing 6-entry tone.
- Frontend (admin.html `bkSendWaiverLink`) should already surface `email_warning` via the existing `bkShowEmailWarning` helper, matching the Send Payment Link path (see admin.html:6283 area). One-line wiring confirmation needed.

Net change: ~20 lines across `api/admin.js`, `lib/send-emails.js`, and a one-line check in `admin.html`. Small, focused, can ship as part of any future defensive-comms cleanup pass or as a standalone commit.

## Suggested commit shape for the fix

Three-file commit:
- `api/admin.js`: restructure `handleSendWaiverLink` into the lookup-vs-send split.
- `lib/send-emails.js`: add `'send-waiver-link'` entry to `ADMIN_ACTION_LABELS`.
- `admin.html`: confirm `bkSendWaiverLink` calls `bkShowEmailWarning(result, 'Send Waiver Link')` after success (likely already does; verify).

Triple-gate cadence: audit → propose → diff → approve → commit. Should be a ~15-minute commit when picked up.
