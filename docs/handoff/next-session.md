# TEXAS FOREVER CHARTERS — SESSION HANDOFF (next session, updated end of May 13, 2026 night session (G11 + G18 shipped))

> Updated end of May 13, 2026 night session (G11 + G18 shipped). Next Claude session reads this first
> before doing anything else. If a fact is in here, do not re-ask DJ. If it's
> NOT in here and not in `docs/content/marketing-angles.md`, ask before assuming.

---

## ⚠️ CRITICAL — READ FIRST

- **Payment architecture redesign is still #1 priority.** Foundational Level 4 audit DONE (commit `5b0c5ea`). **Phase 1 in progress** — 2 of the originally-planned Phase 1 gaps shipped tonight (G11 partial-refund auto-cancel, commit `e754b8b`; G18 incomplete `original_session_id` patch hotfix, commit `38f8a03`).
- **Audit gap count is now 19** (G1-G17 at audit shipping + G18 regression hotfix + G19 new discovery during G18 verification). **Next priority: G19** (booking-confirmation.html shows error page after admin-flow payment — customer-facing UI bug). After G19, G12 (kebab clip), then the rest of Phase 1.
- **The $10 test charge cleanup + Jaida booking are RESOLVED** (DJ handled it daytime). A NEW $10 test booking from G18 verification is still in the DB in fully-correct state (no broken-row evidence remaining; safe to delete or leave).
- **Logan Terrel + Senad customer comms** — pull current status from "OPEN THREADS" section, don't restate here.

---

## BUSINESS CONTEXT (rarely changes)

**Operator:** DJ Kilpatrick, co-owner with brother Dane Kilpatrick (co-captain/co-owner)
**Business:** Texas Forever Charters, Lake Travis, Austin TX
**Contact:** tx4evercharters@gmail.com, (737) 368-1669
**Website:** texasforevercharters.com (Vercel Pro)
**Supabase project:** qniznivgpwjhqruzeafh
**Domain registrar/DNS:** Squarespace
**GitHub:** github.com/tx4evercharters-web/texas-forever-charters
**Local repo:** `C:\Users\djkil\OneDrive\Desktop\Boat photos website file`
**Pickup location:** Volente Beach Waterpark (TFC is on their COI as additional insured — legitimate commercial partnership, free waterpark wristbands for every charter customer)

### Fleet
- **1996 40ft Carver Aft Cabin yacht** — $250/$300/$350 Mon-Thu / Fri+Sun / Sat
- **24ft Bentley Navigator 243 pontoon** — $100/$150 weekday/weekend
- **+$100/hr holiday flat surcharge** (e.g., MDW, July 4, Labor Day weekend)
- **+$100/hr 5+ hour premium flat**

### Carver onboard amenities (as of May 12 2026)
- 14 ft jump platform
- 2 floating docks
- Sun chill float
- Full interior cabin (kitchen, bedroom, bathroom)
- BYOB friendly
- Up to 20 guests
- **Paddle board IS physically on the boat but is NOT marketed** (yacht-tier positioning decision — keep for guests, do not lead in copy)

### Bentley onboard amenities (as of May 12 2026)
- Lily pad
- Premium sound system
- BYOB friendly
- Up to 13 guests
- Family friendly
- **Tubing** — DECISION END OF MAY 12: was always supposed to be a paid add-on at $200 flat, not a free included amenity. Currently still shows on Bentley fleet card as a free `<span class="spec">Tubing</span>` tag — that's a known mistake to be corrected in queue item #21. Until that ships, the site is internally inconsistent on this point.

### Pricing/booking rules baked into platform
- Deposit is non-refundable
- Full balance due 14 days before charter
- 20% tip REQUIRED day-of, cash/Zelle/Venmo
- $250 damage deposit pre-auth hold at checkout
- Vaping allowed on deck; ash-producing smoking is NOT
- Booking channels: FareHarbor, GetMyBoat, Boatsetter, moving toward direct via own site

### CRITICAL credential note
**TFC captains are Texas state PBO-licensed (Texas Parks & Wildlife Passenger Boats for Hire), NOT USCG-licensed.** Never claim USCG / Coast Guard licensure anywhere. PBO = Party Boat Operator credential. Brand-facing line is "PBO Certified Captain" (as of commit 9aef67f, May 12 2026).

### Trust signals (verified, homepage-eligible)
- PBO Certified Captains (Texas state credential)
- Commercially insured
- Owner-operated by brothers Captain DJ + Captain Dane
- Volente Beach Waterpark partnership (free wristbands)
- **63 verified 5-star reviews on Google** (as of May 12 2026; reflected in schema commit 549f489)
- Direct booking (no marketplace fees)

### Things to AVOID claiming
- USCG licensure (FALSE — DJ confirmed)
- Hippie Hollow (brand mismatch with premium positioning)
- Specific celebrity-home owners (privacy + most Austin celebs on Lake AUSTIN, not Lake Travis)
- "Largest house in Austin" for Villa Del Lago (not verifiable)
- Lake traversal / 65-mile coverage (operationally unrealistic — routes radiate from Volente Beach)
- "Luxury yacht" (oversells the 30-year-old Carver — use "premium" or "private" instead)

### Operational reality (marketing must respect)
- Carver is 30 years old — DJ calls her "ole lady I'm nursing back to health constantly." Position as classic/curated, not workhorse.
- Routes radiate from Volente Beach. Don't claim full lake traversal.
- Charter sweet spot is 4-5 hours; past 5 hours, customers tire.

---

## TECH STACK (no changes from prior handoff)

- **Frontend:** HTML5/CSS3/Vanilla JS + Node.js serverless on Vercel (Node 20.x)
- **Brand colors:** #1B2A6B navy, #C8102E red, #FFFFFF white, #C8D0E8 silver
- **Fonts:** Bebas Neue, Barlow Condensed, Barlow, Source Serif 4
- **Backend integrations:** Supabase REST, Stripe LIVE mode, Resend email, Mailchimp newsletter, Anthropic chatbot, Vercel Blob, Vercel Cron, Google Analytics G-5K59MVPLE6, Google Search Console

### Working pattern
- **This Claude instance** = strategy, planning, spec generation, decision-making, debugging interpretation
- **Claude Code (VSCode terminal)** = actual file edits and implementation
- DJ deploys directly to production main branch
- **Strict triple-gate cadence on all UI/customer-facing commits:** audit → propose → diff → approve → commit
- Show diff before commit (always)
- SQL migrations before code deploy
- Single-commit-per-concern, tightly scoped
- "Never force push to main" — strictly enforced

### DJ's working style (memorize these)
- Catches issues through hands-on testing, not spec review
- Pushes hard for polished UX
- Prefers auto-advance interactions over button clicks
- Honest about operational reality
- **Em-dashes: AVOID in all DJ-reviewed copy AND in DJ's own writing** (rule applies beyond customer-facing — Claude Code memorized this May 12)
- Bullet characters (•, ●): AVOID in customer-facing messages
- Will catch overclaiming immediately (caught USCG license claim May 12 before it shipped)
- Sleep matters — DJ has flagged when he's been on low sleep, output quality reflects it

---

## TODAY'S WORK (May 13, 2026 night)

### Commits shipped (2 commits)
- `e754b8b` — **G11 fix: partial refund no longer auto-cancels booking.** Hunk in `handleRefundBooking` (`api/admin.js`). Compute `isFullRefund` BEFORE the `patchBooking` call; gate `status: 'cancelled'` + `cancelled_at` on `isFullRefund`. Mirrors the webhook's `charge.refunded` handler pattern at `stripe-webhook.js:129`. Live smoke-tested with $1 partial refund against the test booking: booking stayed active, customer email fired with "Partial Refund Processed" subject, refund_amount column displayed correctly, slot stayed held in availability. Full refund of the remainder still flipped status to cancelled as expected.
- `38f8a03` — **G18 hotfix: complete `original_session_id` webhook patch.** Discovered as a regression from last night's `f10c429` commit. The original_session_id branch only patched 3 of the 7 fields a paid booking needs — leaving `amount_total`, `payment_intent_id`, `stripe_customer_id`, and `payment_method_id` stale. Bookings-tab pill rendered UNPAID (reads `amount_total`) while Edit modal correctly showed Paid in Full (reads `paid_in_full`) — same row, contradictory states. Refund actions also disabled because gated on `payment_intent_id`. Fix: pre-patch read via `findBookingBySessionId`; PI retrieve mirroring legacy path; write the 4 transaction-data fields only when current column is empty (`0` for amount_total, null for IDs). State flags still flip unconditionally. Conditional gating preserves deposit-flow data; interim until G7 (Phase 2 schema) lands. Verified live on a fresh test booking — pill flipped to PAID IN FULL, refund options active, partial refund completed successfully.

### Two new gaps surfaced (G18, G19)
- **G18** added to audit doc §10.1 Architectural — incomplete original_session_id patch (regression from `f10c429`). Severity HIGH. Status ✅ FIXED in `38f8a03`. Cross-referenced in §10.7.
- **G19** added to audit doc §10.5 UI — `booking-confirmation.html` shows "something went wrong" error page after admin-flow Stripe Payment Link redirect. Severity MEDIUM (cosmetic — DB state correct, customer sees failure UI despite successful charge). Suspected cause: page expects `cs_*` session id from customer-wizard flow, but the admin Payment Link redirect either omits or passes a different shape. Phase 1, next priority.

### Diagnostic methodology
- Symptoms surfaced when DJ was smoke-testing G11 — the same test booking exposed the G18 regression. Caught the bug before it reached a real customer.
- Phase 2-style live-DB/Stripe verification was attempted via `vercel env pull`, but Stripe + Supabase secrets are flagged Sensitive in Vercel and come back as empty placeholders. Diagnosis locked via code-level analysis of the f10c429 branch's patch fields vs. the legacy path's bookingRow construction. Symptoms (UNPAID pill + Paid-in-Full modal + disabled refunds) had only one possible column-state explanation.

### Gmail thread-collapse rabbit hole (~30 min, no fix needed)
- Initially appeared the admin-link delivery email was arriving with subject but empty body. Methodical diagnostic ("Show original" in Gmail, sending fresh test to a different address) proved the raw email source had full HTML content — Gmail was thread-collapsing the body display because multiple emails with similar subjects had clustered. Not a code bug, a Gmail UX quirk.
- **Future smoke tests:** use different email addresses or unique subject suffixes (timestamps work) to avoid thread-collapse confusion.

---

## TODAY'S WORK (May 13, 2026 daytime)

### Commit shipped (1 commit)
- `5b0c5ea` — **Comprehensive admin audit (read-only, docs only).** Single new file at `docs/audits/admin-comprehensive-audit-2026-05-13.md` (1,074 lines at audit shipping; grew to ~1,100 lines after G18 + G19 were added during the night session). No code touched. Maps every admin action, webhook event, cron pass, booking creation path, payment state transition, schema column, email send, and silent-failure surface. Identifies 17 gaps at audit time (now 19 with G18/G19 added during the night session), organizes them into 5 phases for the redesign, and bundles all 15 unresolved questions as Appendix B. DJ answered all 15 inline in the same session; answers preserved verbatim as Appendix E with the 3 new gaps that surfaced (G15, G16, G17) cross-referenced.

### Post-deploy verification of May 12-13 evening work
- DJ confirmed all clear: homepage Crew section (PBO Certified Captain credential), fleet card onboard amenities (Carver floating docks + sun chill float, Bentley lily pad + premium sound system), schema `reviewCount: 63`, admin kebab dropdown layering on Bookings tab.

### Search Console + structured data
- **Google Search Console indexing requests submitted** for: homepage, `/austin-texas-boat-rentals.html`, `/discounts.html`, `/lake-travis-family-boat-tours.html`.
- **Rich Results Test** run on homepage to validate the `reviewCount: 63` + `openingHours` schema fix from commit 549f489.

### Incident cleanup
- $10 Stripe test charge refunded.
- Test booking deleted from admin.
- Jaida Matthews's May 20 charter confirmed showing PAID IN FULL in admin (verified post-cleanup).

---

## WHAT WORKED THIS SESSION (May 13 night)

Pattern reinforcement for next session. Keep doing these.

- **Conditional-overwrite semantics on G18 was the right call — DJ caught the deposit-flow regression concern in real time before shipping.** Initial proposal would have overwritten `amount_total` / `payment_intent_id` / `stripe_customer_id` / `payment_method_id` unconditionally. DJ surfaced the deposit-then-balance-payment data-loss case mid-review. Conditional gating (`if (!existing.column) patchObj.column = newValue`) landed cleanly; the deposit-flow regression that would have shipped silently was prevented. Pre-patch read via `findBookingBySessionId` is the load-bearing primitive there.
- **Gmail thread-collapse diagnosis: pursued the empty-email hypothesis methodically.** Sent fresh test to a different address, opened "Show original" to read raw email source, confirmed body content was intact at the wire — not a code bug, a Gmail UX quirk. Resisted shipping a fix to a non-bug.
- **"Show original" / raw-email-source read proved the email pipeline was fine.** Saved unknown hours of false-positive debugging on the inline payment-link delivery template that was actually never broken.
- **Letting the broken-state test booking stay in the DB as evidence was the right call.** Instead of "fixing" the row manually to make the symptom go away, leaving it intact let me confirm G18 diagnosis (column state matched code-level prediction exactly) without contaminating data. Once the code fix shipped and was verified on a fresh test booking, the broken row could safely be deleted.

---

## WHAT WORKED THIS SESSION (May 13 daytime)

Pattern reinforcement for next session. Keep doing these.

- **Triple-gate cadence on the audit held cleanly.** outline → approval → investigation/draft → diff → approval → commit. No scope creep. Investigation took ~45 min as estimated; output landed at 985 lines on first pass, plus another 90 lines on the second pass after DJ's Appendix B answers reframed three gaps. Final commit `5b0c5ea` shipped exactly what was approved.
- **DJ answered all 15 Appendix B questions in one batch instead of scattered through later implementation sessions.** Surfaced 3 new gaps (G15 email_warning surface, G16 blackout conflict alert, G17 waiver email + terms_agreed UI) and reframed G6 (terms_agreed compliance, not deadwood) before any of these became Phase 1 implementation surprises. Big-bang Q&A is faster than streaming questions through code reviews.
- **Claude Code grep'd `admin.html` for the Customers-tab wrap ID instead of leaving it as REQUIRES DJ INPUT.** Found the asymmetry that explains G12: Bookings tab has `<div class="table-wrap" id="bookings-wrap">` (admin.html:1902), Customers tab has class-only `<div class="table-wrap">` (admin.html:2377) wrapping `<table id="cust-table">` (admin.html:2378). The scoped CSS rule in commit 1678e56 never matched anything in the Customers context. Code-resolvable questions should be code-resolved, not deferred.
- **Stopping at the audit instead of pushing into Phase 1 fixes in the same session preserved decision quality.** The redesign is multi-session by design. Pacing the work day-by-day at one focused commit per session is the cadence that survives DJ's hands-on testing. Tomorrow's session opens fresh with Phase 1 starting on G11 (live customer-impact bug) and G12 (smallest scope, CSS confidence-builder on the asymmetry finding).

---

## TODAY'S WORK (May 12-13, 2026) — WHAT CHANGED

### Tonight (May 13 evening) — 1 commit, then incident response
- `f10c429` — Admin payment-link metadata fix + webhook patches original row on completion. **Architecturally insufficient per the incident analysis above. Replaced by the redesign work, but commit remains in main as a step in the right direction.**
- Live testing revealed the fix doesn't address the immutability problem with payment links. Diagnosis led to architectural redesign decision.

### Commits shipped May 12 (11 total across two sessions)

**Morning session (pre-fresh-head context):**
1. SEO audit report saved to `docs/audits/seo-landing-page-audit-2026-05-12.md`
2. `052ea52` — Consolidate Austin tours into Austin rentals (deleted `austin-texas-boat-tours.html`, 1,290-word consolidated page, 6-item FAQ with FAQPage JSON-LD)
3. `daf4854` — Absorb Austin lake-tour into consolidated rentals page (deleted `austin-lake-tour.html`, expanded to 1,505 words)

**Afternoon/evening session (this session — 8 commits):**
4. `bf28cb7` — Marketing angles doc: PBO Certified Captains framing established
5. `9aef67f` — Homepage Crew section: PBO Certified Captain credential under DJ + Dane. ALSO removed paddle board tag from Carver fleet card + fleet description.
6. `ecbb7d3` — Homepage trust strip: removed "Paddle Board Included" item
7. *(commit between ecbb7d3 and the marketing-angles amenities commit — SHA not surfaced in chat, likely the fleet-card amenities commit)* — Added "2 FLOATING DOCKS / SUN CHILL FLOAT" to Carver tags, "LILY PAD / PREMIUM SOUND SYSTEM" to Bentley tags
8. *(marketing-angles amenities doc commit — SHA not surfaced)* — Added per-vessel onboard amenities section to `docs/content/marketing-angles.md`
9. `549f489` — Homepage JSON-LD schema accuracy: `reviewCount: "3"` → `"63"`, removed misleading `openingHours` field, `ratingValue` kept at `"5"` (all 63 Google reviews are 5-star)
10. `1678e56` — Admin Bookings tab: kebab dropdown z-index fix (correctly diagnosed the prior commit 0cde4a7 as a half-fix using wrong CSS mental model — `position: fixed` escapes containing block, not stacking context; new fix promotes open row's sticky `<td>` to z-index 190)
11. *(starter doc for lead delete feature — to be the last commit of session if shipped)*

### What materially changed for prospects + Google today
- Homepage Crew section now shows "PBO CERTIFIED CAPTAIN" under both captains
- Carver fleet card shows 2 floating docks + sun chill float as included amenities
- Bentley fleet card shows lily pad + premium sound system as included amenities
- Paddle board removed from public marketing site-wide (still physically on Carver)
- Google rich snippet will recrawl and display "5.0 · 63 reviews" instead of "5.0 · 3 reviews" over the next 1-4 weeks
- Stale `openingHours` field removed from schema
- Admin kebab dropdown on Bookings tab now layers correctly above subsequent rows

### Customer comms shipped today
- **Logan Terrel (Sun May 24 2026 charter, $2,441.25 holiday rate adjustment):** Text sent re: website missed the +$100/hr holiday surcharge. Asked for $492.75 balance via Stripe link. Reference to phone-call conversation, warm tone, two-topic structure (waivers reminder + pricing). **STATUS: SENT, AWAITING LOGAN'S RESPONSE.**
- **Senad (Jun 6 charter time change):** Sent prior session (May 11). DJ confirmed today: Senad had not yet responded as of evening May 12.

---

## OPEN THREADS REQUIRING DJ ACTION (start tomorrow with these)

### Customer comms
1. **Did Logan respond to the holiday rate text?** Owes $492.75. If he pushes back, hold firm — DJ already decided. Fallback line: "Holiday rate is standard across all holiday weekends, sorry the site didn't catch it."
2. **Did Senad respond to the June 6 charter change message?**

### Indexing follow-up still pending
3. **Verify both deprecated URLs** (`austin-texas-boat-tours.html`, `austin-lake-tour.html`) 301 properly in incognito.
4. **Monitor 2-4 weeks in GSC Coverage** for unexpected 404s + recrawl confirmation on the consolidated pages.

---

## PAYMENT ARCHITECTURE REDESIGN — TOP PRIORITY

### What happened (May 13, 2026 evening)

**Sequence of events:**

1. **6:37 PM** — Customer Jaida Matthews (existing booking, Wed May 20 charter, $828.98 total, deposit-only status with $746.08 remaining balance) hit "Something went wrong" error page after paying her balance via a payment link DJ had sent her from the admin.

2. **~6:40 PM** — Defensive alert email "ACTION NEEDED: Confirmation email FAILED — unknown customer" fired to tx4evercharters@gmail.com. Email contained the Stripe session ID (`cs_live_a1ry9KI9XleRsz5cLnw1UpZ8GjSfxDJHcssqWqaINz2AuHzS5iPdRN0uCt`) but every customer/booking field was blank. The defensive system caught the failure.

3. **~7:00 PM** — DJ investigated. Stripe confirmed $746.08 was successfully charged. Booking still showed DEPOSIT ONLY in admin. Defensive alert showed customer email "(missing)" and all booking fields as dashes.

4. **~7:00 PM** — DJ reached out to Jaida (she had already contacted DJ via the defensive alert email's CTA). Manually marked her booking PAID IN FULL in admin.

5. **~7:15 PM** — Phase 1 Audit of `handleSendPaymentLink` revealed root cause: the admin "Send Payment Link" code path creates Stripe payment links via `stripe.paymentLinks.create()` WITHOUT attaching metadata. Stripe captured payment but the auto-generated checkout session had empty metadata, so the webhook couldn't find/update the booking row or send a proper confirmation email.

6. **~7:37 PM** — Commit `f10c429` shipped — added metadata block to `handleSendPaymentLink` in `api/admin.js` + new branch in `api/stripe-webhook.js` to patch the original booking row when `meta.original_session_id` is present.

7. **~7:48 PM** — Live test: DJ created test booking ($10) with payment mode "Send Stripe payment link via email," received link, paid through it. Result:
   - Stripe captured $10 ✅
   - Customer confirmation email arrived ✅
   - Business notification email arrived ✅
   - **But the admin booking row STILL showed UNPAID** ❌
   - **Stripe payment metadata STILL empty** ❌

8. **~8:30 PM** — Re-audit revealed the deeper issue: **Stripe payment links are immutable. Metadata is frozen at link-creation time, not at payment time.** If the test booking's link was created before the f10c429 deploy completed (~30-90 sec after push), the link had no metadata baked in regardless of when payment occurred.

9. **DJ correctly identified the bigger problem:** Customers don't pay immediately. They may pay days or weeks after receiving the link. The entire payment-link architecture has a class of latent bugs around the gap between link-send and link-payment:
   - Frozen metadata means the link can't reflect current booking state
   - If booking pricing/details change between link-send and payment, customer pays old amount but booking thinks it's now PAID IN FULL
   - No drift detection
   - No way to invalidate stale links
   - No persistence of the link URL on the booking row (cron reminder code references `b.payment_link` field but nothing ever writes it)

### What we committed tonight (commit f10c429)

**Files modified:** `api/admin.js`, `api/stripe-webhook.js`

**Change 1:** Added metadata block to `stripe.paymentLinks.create({...})` in `handleSendPaymentLink`. 26 keys mirroring what the booking wizard's `create-checkout.js` attaches, plus `original_session_id` as a back-link to the admin-created booking row, plus `customer_email` as an audit-trail fallback. String-coerced + truncated to 500 chars per key (490 for free-text).

**Change 2:** Added a new branch in the webhook's `checkout.session.completed` handler that, when `meta.original_session_id` is present, patches the original booking row to `paid_in_full: true, remaining_balance: 0, payment_type: 'full'`. Sends confirmation email from the patched row. Returns 5xx on patch failure to trigger Stripe retry. Falls through to legacy insert if original row not found.

**Status of this fix:**
- ✅ Architecturally sound for the simple case (customer pays immediately after link is sent, booking hasn't changed)
- ❌ Does NOT solve the customer-doesn't-pay-immediately reality
- ❌ Does NOT detect or handle drift between link send and link payment
- ❌ Does NOT persist the link URL anywhere so we can revoke/track it
- ⚠️ The live test we did failed to verify the fix end-to-end — possibly because the payment link was created pre-deploy (immutable metadata), possibly because of something else we didn't diagnose

**This commit is NOT being reverted.** Even though it doesn't solve the full problem, it's a step in the right direction and removing it would just leave us with the original silent-failure bug. The redesign will build on top of this.

### Level 4 comprehensive admin audit — ✅ DONE

Shipped May 13, 2026 daytime session. Commit `5b0c5ea`, doc at `docs/audits/admin-comprehensive-audit-2026-05-13.md` (1,074 lines, read-only).

The audit maps every admin action (19 handlers), every webhook event (7 branches), every cron pass (5 sequential passes in `api/cron-reminders.js`), every booking creation path (5 distinct paths with session_id shapes + idempotency analysis), every payment state transition with side-effect coverage, every column on the `bookings` table with writer/reader cross-tab, every Resend send across the codebase (23-row table), the Customers-tab kebab clip diagnosis, and a 20-row silent-failure inventory. DJ answered all 15 unresolved questions inline; answers preserved as Appendix E.

**Output: 17 gaps identified at audit shipping (G1-G17); 2 more (G18 + G19) added during May 13 night session for 19 total.** Summary table below. Full content lives in the audit doc; don't restate.

| Gap | Description | Severity | Phase / Status |
|---|---|---|---|
| **G1** | No persisted payment-link state (URL, ID, amount, created_at, status) | HIGH | Phase 2 (schema) |
| **G2** | Single-funnel payment-state machine doesn't exist; transitions scattered | HIGH | Phase 4 (refactor) |
| **G3** | `handleChargeRemaining` charges card but sends no customer confirmation email | HIGH | Phase 1 |
| **G4** | No audit trail for state transitions; no `booking_events` table | MEDIUM | Phase 4 (refactor) |
| **G5** | `payment_type` semantics overloaded (intent vs state) | LOW | Phase 5 (cleanup) |
| **G6** | `terms_agreed`/`terms_agreed_at` written but never read (narrowed by G17) | LOW | Phase 5 (cleanup) |
| **G7** | No back-link from secondary PaymentIntents to the booking row | MEDIUM | Phase 2 (schema) |
| **G8** | `email_warning` returned in JSON but admin UI never surfaces it | MEDIUM | Phase 1 |
| **G9** | Cron reminders read `b.payment_link` which is never written; emails ship no Pay button | HIGH | Phase 3 (depends on G1) |
| **G10** | Confirmation email not idempotent against Stripe webhook retry | LOW | Phase 1 |
| **G11** | `handleRefundBooking` auto-cancels booking on partial refunds | MEDIUM | ✅ shipped `e754b8b` |
| **G12** | Customers-tab kebab dropdown clip (CSS scope asymmetry) | LOW | Phase 1 (next-next priority) |
| **G13** | `handleDeleteBooking` hard-deletes; no soft-delete or audit | LOW-MEDIUM | Phase 2 (schema: `deleted_at`) |
| **G14** | Send Payment Link has no de-dup; clicking twice creates two active links | MEDIUM | Phase 5 (depends on G1) |
| **G15** | `email_warning` never surfaced anywhere in admin UI (DJ confirmed) | MEDIUM | Phase 1 |
| **G16** | `handleAddBlackout` doesn't alert on conflict with existing bookings | MEDIUM | Phase 1 |
| **G17** | Waiver-signed email best-effort + `terms_agreed` not in admin UI | MEDIUM | Phase 1 |
| **G18** | Incomplete `original_session_id` webhook patch (regression from `f10c429`) | HIGH | ✅ shipped `38f8a03` |
| **G19** | `booking-confirmation.html` shows error page after admin-flow Stripe Payment Link redirect | MEDIUM | Phase 1 (next priority) |

### Updated implementation sequence (replaces prior 4-step plan)

Per the audit's §10.7 and DJ's approval, the sequence is:

**Phase 1 (code-only, no migrations):** Originally G3, G8, G10, G11, G12, G15, G16, G17 — now with G18 (hotfix) ✅ shipped and G19 (regression discovery) added.
- ✅ **G11 shipped** in `e754b8b` (partial-refund no auto-cancel) — verified live with $1 partial refund test.
- ✅ **G18 shipped** in `38f8a03` (incomplete original_session_id patch hotfix) — verified live; fresh test booking flips to PAID IN FULL correctly.
- **Next priority: G19** (booking-confirmation.html error page after admin-flow payment). Customer-facing UI bug. See audit doc §10.5 for full description.
- **After G19: G12** (kebab clip — smallest scope, CSS confidence-builder on the wrap-ID asymmetry from audit §8.2).
- Then proceed through G3, G8, G10, G15, G16, G17 in whatever order DJ's customer queue prioritizes.

**Phase 2 (schema migration):** Design schema for G1, G7, G13 columns. Write migration SQL. Single commit, SQL-only. This is the only Phase that touches Supabase schema directly; everything downstream depends on it.

**Phase 3 (code on top of schema):**
- Rewrite `handleSendPaymentLink` to use Stripe Checkout Sessions instead of Payment Links (eliminates the immutable-metadata problem entirely).
- Rewrite `handleChargeRemaining` to send the customer confirmation email (deeper rewrite than the Phase 1 G3 quick-fix, may route through the webhook for architectural consistency).
- Fix `cron-reminders` payment_link URL gap (G9) now that the columns from Phase 2 exist and are populated.
- Multiple focused commits, smoke-tested between each.

**Phase 4 (refactor):** G2 single payment-state machine, G4 `booking_events` audit table. These are bigger refactors that benefit from Phase 1-3 being landed first so the redesign builds on stable foundations.

**Phase 5 (cleanup):** G5 (`payment_type` decision), G6 (narrowed — keep or drop the column), G14 (link de-dup; requires G1 from Phase 2).

### What the audit revealed about adjacent code paths

Multiple admin actions touch payment state. Tonight's audit only deeply examined `handleSendPaymentLink`. Other identified-but-not-fully-audited paths:

1. **`handleChargeRemaining` (Charge Card action)** — Charges saved card directly via `paymentIntents.create`, bypasses the webhook entirely, calls `markBookingPaid()` directly. Customer receives NO confirmation email when this fires. Silent success pattern.

2. **`handleCaptureDamageCharge`** — Damage hold overflow path, creates a paymentIntent with metadata `{ purpose: 'damage_overflow', booking_session_id }`. Webhook doesn't read these.

3. **`bkFullRefund` / `bkPartialRefund`** — Refund kebab actions. Not audited. Unknown if they correctly update booking status, send customer email, restore availability.

4. **`charge.refunded` webhook handler** — Listed in webhook code but not audited. Unknown if it handles refunds correctly.

5. **`charge.dispute.created` webhook handler** — Listed but not audited.

6. **`checkout.session.expired` webhook handler** — Listed but not audited.

7. **`payment_intent.payment_failed` webhook handler** — Listed but not audited.

8. **`bkReleaseDamageHold` / `bkCaptureDamageOpen`** — Damage hold lifecycle actions. Not audited.

9. **`bkMarkPaid`** — Manual mark paid action. Not audited.

10. **`bkMarkConcluded`** — Manual mark concluded. Not audited.

11. **`bkCancel`** — Cancel booking. Not audited. Unknown if it refunds, releases holds, notifies customer, restores availability.

12. **`bkDelete`** — Delete booking. Not audited. Same questions as cancel.

13. **Customers tab booking history dropdown** — Same `bkActionMenu` function as Bookings tab (per audit), but the dropdown is being visually clipped — DJ couldn't access "Send Payment Link" from there due to overflow.

### Cron-reminder gotcha (flagged by Phase 1 audit, not yet fixed)

`api/cron-reminders.js:168` reads `b.payment_link` or `b.balance_payment_link` from the booking row to include the URL in 21/14/12-day reminder emails. **But nothing in the codebase WRITES those fields.** `handleSendPaymentLink` returns the URL to the frontend but doesn't persist it. This means:

- Reminder emails never actually include a payment link URL
- Customers receive reminders but no way to pay from the email
- Admin has to manually re-send payment links each time

This is a real customer-impacting bug that's been silent. Goes into the redesign scope.

### Things DJ explicitly said (capture for context)

- "I want my booking platform and system to be full proof. even if we have to completely redesign"
- "I can't expect people to pay NOW as soon as I press send payment.... That shit needs to be 100% capture no matter what"
- The defensive alert email system DID catch tonight's incident — customer was protected, not harmed. That pattern is correct and should expand to cover every silent-failure mode.

---



### Queued tonight, picks up next session
1. **Payment Architecture Redesign — continue Phase 1.** ✅ G11 + G18 shipped tonight (`e754b8b` + `38f8a03`), both verified live. **Next priority: G19** (booking-confirmation.html shows error page after admin-flow Stripe Payment Link redirect — customer-facing UI bug; see audit doc §10.5 for full description and suspected cause). **After G19: G12** (kebab clip — CSS scope asymmetry, see audit §8.2). Then the rest of Phase 1: G3, G8, G10, G15, G16, G17. Each its own session block, strict triple-gate cadence, **do not bundle**. See "PAYMENT ARCHITECTURE REDESIGN" section above for the full 19-gap summary table and 5-phase implementation sequence.

2. **Lead delete feature design** — starter doc confirmed at `docs/specs/lead-delete-feature.md` (verified May 13 daytime; note the source-handoff path `docs/queue/lead-delete-feature.md` was incorrect, actual location is `docs/specs/`). Six open product questions for DJ to answer before any code. Use cases: spam, duplicates, test entries, PII removal. Estimated effort 30 min to full afternoon depending on scope.

### Housekeeping (low priority, tiny commits)
2a. **Add `node_modules/` to `.gitignore`.** Currently `.gitignore` only lists `.vercel` and large video files. `node_modules/` was created during the May 13 night G18 credential-diagnostic when `npm install` was run locally; it's untracked but unignored, meaning a future accidental `git add .` could pull in the entire dependency tree. Single-line edit. Do as its own commit (`chore: gitignore node_modules`).

### Existing queue (rolled forward)
3. **Email delivery tracking** (Resend webhook integration + Email Timeline UI in admin + daily digest bounce summary). Spec already written from prior session. New `email_events` table, captures `resend_email_id` on every send, webhook at `/api/resend-webhook` validates `RESEND_WEBHOOK_SECRET`. Critical defensive feature given prior silent-failure webhook double-charge incident. **Multi-step build, needs fresh-head morning. NOTE: this may be partially absorbed by the Payment Architecture Redesign audit log work — re-scope after the audit.**
4. **Payment method visibility** (Stripe `payment_method_type` + last4 + holder, new columns captured at webhook, displayed in admin booking detail). **Multi-step build. NOTE: also likely absorbed into the Payment Architecture Redesign.**
5. **Strengthen 4 remaining SEO landing pages** to 1,000+ words each with FAQPage schema. Pull facts from `docs/content/marketing-angles.md`. Order:
   - `lake-travis-boat-rentals.html` (65-mile destination framing, NOT traversal claim) — ~90 min Claude Code work
   - `lake-travis-sunset-cruises.html` (sunset time table, proposals subsection — The Oasis from water is huge for this page)
   - `private-party-boat-austin.html` (yacht-vs-party-bus framing)
   - `lake-travis-family-boat-tours.html` (family FAQs, kids-love-most)
5. **Per-boat landing pages** (`/40ft-carver-yacht-charter/` and `/24ft-bentley-pontoon-charter/`) — defer until #4 ships
6. **Yacht-charter cornerstone page** (`/lake-travis-yacht-charter/`) — defer until #4 + 30 days data on consolidated page. Folds waterpark angle as a section, not separate page.
7. **Schema accuracy follow-up (NEW — surfaced by audit May 12):**
   - `streetAddress` is currently "Volente Beach Waterpark and Resort" (venue name, not real street address)
   - `postalCode: "78641"` — Leander ZIP, may not match Volente boundary
   - `@type: ["LocalBusiness", "BoatTour"]` — BoatTour is nonstandard at operator-entity level; conventional pattern is LocalBusiness alone with `makesOffer` → per-charter Service/Product entities
   - Description mentions only "Up to 20 guests" (yacht-only, doesn't reflect pontoon's 13)
   - Thin `sameAs` array (only Instagram) — should add Google Business Profile, FareHarbor, GetMyBoat, Boatsetter, Facebook (if applicable)
   - Missing `image` and `logo` fields (Google Business panels render better with these)
   - **Per-vessel Product/Vehicle JSON-LD** — the right home for amenity tags in structured data, if/when surfaced
8. **Activity timeline / audit log** — parked behind #2 & #3
9. **Re-book Kendrina Walker** — manual customer outreach
10. **Production booking flow smoke test end-to-end with real card** — verification not dev work, requires Stripe charge + refund
11. **Apex vs www strategic decision** — one decision to make, then implementation follows
12. **admin.html line 3253** — JS string building customer-facing waiver URL still uses www; depends on #11 outcome
13. **Kebab dropdown clipping fix on Bookings tab** — ✅ DONE May 12 (commit 1678e56)
14. **PWA / proper app icon**
15. **Google Business Profile audit + resolve duplicate listing** (case 2-3228000041087)
16. **Charter length sweet spot honesty** — 4-hour default in booking wizard, tooltip on 5+ hours saying "most groups find 5 hours is plenty" (prevent Senad-type situations)
17. **Google Ads launch** — parked until "firing on all cylinders" + conversion tracking
18. **Waiver/terms lawyer review** (Volente Beach indemnification language, ~$200 consult)
19. **External listings update** (FareHarbor, GetMyBoat, Boatsetter, GBP) — manual DJ task
20. **Privacy policy + Tier 2 cookie banner (NEW — added end of May 12 session).** TFC is not legally required to do this — as a small business under SBA thresholds with mostly Texas-resident customers, both TDPSA (small business exemption) and CCPA-style laws (revenue thresholds not met) leave TFC out of scope. BUT adding a privacy policy page and a small dismissible cookie banner is recommended for three reasons: (1) future-proofs against tightening privacy law, (2) trust/polish signal that matches the yacht-tier positioning shipped today, (3) Google Analytics G-5K59MVPLE6 currently runs without any disclosure. Scope: a privacy policy page covering cookies/analytics/contact data + a small dismissible banner ("We use cookies to improve your booking experience. By using this site, you agree to our privacy policy") with link to policy and OK button. NO granular opt-in/opt-out controls (Tier 3 CMP would add friction at the worst moment — when a prospect is deciding to book). Estimated effort: 1-2 hours Claude Code work for the banner widget + policy copy drafting. Should ship as TWO commits: (a) privacy policy page first, (b) banner widget second, with strict triple-gate cadence given this touches the booking-funnel UX. Reference: search history saved in tonight's conversation for the legal reasoning.

21. **Inner Tube Towing as $200 pontoon-only paid add-on (NEW — added end of May 12 session).** Decision made by DJ: tubing was always supposed to be a paid add-on, the existing free "TUBING" tag on the Bentley fleet card is a mistake that needs to come off. **This is multi-surface and revenue-touching — do NOT ship as a single quick commit. Audit-first to map blast radius.**

    **Pricing:** $200 flat, regardless of charter length. Pontoon-only (Carver doesn't get this add-on).

    **Surfaces to coordinate (at minimum):**
    - **Bentley fleet card on homepage (index.html)** — `<span class="spec">Tubing</span>` was added to the Bentley card in the amenities commit shipped earlier in this session (look for the commit between ecbb7d3 and the marketing-angles amenities doc commit). Decide: remove entirely, replace with "Tube Towing Available," or leave a note like "TUBE PULLS ($200 ADD-ON)."
    - **docs/content/marketing-angles.md** — the per-vessel onboard amenities section currently lists "Tubing setup" as a free Bentley amenity. Needs to be moved from amenities to paid add-ons section, with the $200 price.
    - **Booking flow / wizard** — add "Inner Tube Towing $200" as a selectable add-on, pontoon-only restriction. Already has add-ons step (drone footage, ice, water, towels per the trust strip marquee items at js/main.js:551-563). Verify the new add-on integrates cleanly.
    - **Trust strip marquee (js/main.js:551-563)** — JS-injected items currently show "ADD-ON: TOWELS, ADD-ON: ICE, ADD-ON: WATER BOTTLES, ADD-ON: DRONE FOOTAGE — $200." Inner tube towing should be added here at $200, pontoon-only contextual restriction (the marquee shows all add-ons regardless of vessel — that's already the convention).
    - **SEO landing pages** — `lake-travis-family-boat-tours.html` especially, possibly others, may mention tubing as included. Grep for "tubing" and "tube" across all HTML files.
    - **Booking confirmation emails (lib/send-emails.js)** — if templates mention tubing as included for pontoon bookings, those need updating. New bookings get the new add-on; existing bookings stay on old terms (see grandfathering below).
    - **Admin Bookings tab UI** — if add-ons are displayed per booking, the new add-on needs to be selectable there too for manual edits.
    - **Backend pricing engine** — needs to handle the new add-on with its pontoon-only restriction. Could be data-driven from Supabase or hardcoded — audit to determine.
    - **Stripe checkout** — needs to charge the $200 correctly via add-on metadata or line items.

    **Open questions to resolve before code:**
    1. **Customer-facing label.** "Inner Tube Towing $200," "Tube Pulls $200," "Active Tubing $200," "Tube Tow $200" — pick one. DJ used "inner tube towing" colloquially; could be shorter for UI.
    2. **Existing booking grandfathering.** Are there any existing pontoon bookings that booked under the old "tubing included" framing? If yes, those customers should be honored at the old terms — cannot retroactively charge them $200. DJ should check Bookings tab before the audit.
    3. **Replacement on the Bentley card.** What does the Bentley card tag row look like AFTER tubing is removed? Currently 7 tags (Up to 13 Guests / Pontoon / Tubing / Family Friendly / Boat Tours / Lily Pad / Premium Sound System). After removal: 6 tags. Is that visually balanced, or do we need to add another amenity in its place?

    **Recommended commit structure (3 sequential commits, NOT one):**
    - Commit 1 (UI + content): remove TUBING tag from Bentley card, update fleet description if it mentions tubing, update marketing-angles.md to move tubing to paid add-ons section. Single triple-gate audit/propose/diff/commit cadence.
    - Commit 2 (booking flow): add the new $200 paid add-on to the booking wizard with pontoon-only restriction. Backend pricing engine + Stripe integration. Triple-gate plus extra care given Stripe is LIVE mode.
    - Commit 3 (collateral): update trust strip marquee, any SEO landing pages that mention tubing, booking confirmation email templates if needed. Last because it depends on the canonical label being locked in commits 1-2.

    **Estimated effort:** 90 min to half a day depending on how data-driven the pricing engine is.

    **Why this isn't a quick commit:** UI + content + business logic + email templates + Stripe LIVE mode all touching one feature is exactly where regressions hide. Worth full audit-first treatment.

22. **Supabase Data API GRANT policy change (NEW — added end of May 12 session, advance warning from Supabase).** Supabase is changing the default behavior for new tables in the `public` schema. Starting **May 30, 2026**, new Supabase projects will NOT auto-expose `public` schema tables to the Data API (supabase-js, PostgREST `/rest/v1/`, GraphQL `/graphql/v1/`) without an explicit `GRANT` statement. Existing projects (TFC's project `qniznivgpwjhqruzeafh` is one) are grandfathered until **October 30, 2026**.

    **TFC IS affected** because the entire serverless stack uses supabase-js → Data API. Booking flow, admin panel, `/api/availability`, lead capture, everything routes through it.

    **TFC is NOT broken right now and won't be for 5.5 months.** Existing tables keep their grants. The change ONLY affects NEW tables created after October 30 in TFC's project.

    **What this means in practice:**
    - Today through Oct 30: nothing changes. No code to write, no migrations to run.
    - After Oct 30: any new table you create in `public` schema needs an explicit `GRANT` statement in its migration to be reachable via the Data API. Without the GRANT, supabase-js calls to that table will return 404 / unauthorized.

    **Action item for tomorrow's session (or whenever the next migration is written):**
    - Audit existing migration files for the `GRANT` pattern TFC already uses (Claude Code: `grep -r "GRANT" supabase/migrations/` or wherever migrations live)
    - Update the migration template / mental checklist so every new-table migration includes explicit `GRANT SELECT, INSERT, UPDATE, DELETE ON public.<table> TO anon, authenticated;` (or whatever role pattern matches existing tables)
    - Apply this proactively to in-flight features with new tables:
      - `email_events` table for queue item #2 (email delivery tracking)
      - Potential `deletion_log` table for queue item #1 (lead delete feature, if soft-delete or audit-log path chosen)
      - Any other new table any future feature introduces
    - 15-minute habit change, not a feature build

    **Why we're capturing this 5.5 months ahead of time:** It's the kind of thing that bites silently. Create a new table after October 30, deploy, smoke test passes (table exists in Postgres), feature ships, days later you discover supabase-js calls 404 because the GRANT wasn't there. Catching it preemptively in the migration template costs 15 min once; catching it after a silent prod regression costs hours of debugging plus customer impact.

    **Reference:** the Supabase notification email DJ received May 12 2026 — full context preserved in tonight's session log.

### Doc-pass items (low priority, batch later)
20. **Em-dash sweep on `docs/content/marketing-angles.md`** — legacy lines 12, 28, 88, 101, etc.
21. **"14ft" vs "14 ft" stylistic unification** in same doc
22. **Trust strip waterpark redundancy** — line 119 ("Free Waterpark Access") + js/main.js:552 ("Free Volente Beach Waterpark Access") show as two near-identical items in the loop (this is the actual outstanding redundancy; the audit summary erroneously claimed this was resolved by ecbb7d3 — it wasn't)

### Site-wide content sweeps
23. **Paddle-board sweep on other landing pages** (lake-travis-*, sunset-cruises, etc.) — verify removed from copy site-wide where appropriate. Some pages may still mention it.

### Parked indefinitely
- `/lake-travis-yacht-and-waterpark/` as separate page (audit RED LIGHT — fold waterpark angle into cornerstone yacht-charter page instead)
- Anti-positioning page (Tier 3, only after data validates)
- Phase 2 lead recovery promo codes (LAKE50, DRONE200)
- HOA SaaS pivot (Phase 0 customer validation = 20 discovery calls before any code)
- Hoistr (charter operator SaaS — far future)

---

## KEY MARKETING ANGLES (verified facts — also lives in marketing-angles.md)

### Sightseeing waypoints (only use verified ones)
- **Villa Del Lago** — 15,400 sq ft Mediterranean estate, listed $45M in 2022 as Texas's most expensive home. South shore. DO NOT claim "largest house in Austin."
- **The Oasis** — Established 1982 by Beau Theriot. 450 feet above the lake. Largest outdoor restaurant in Texas (in 2019, 4th largest in world). Sunset Capital of Texas. Bell rung at sunset. Lightning-strike fire June 2005, reopened 2009.
- **Mansfield Dam** — Originally Marshall Ford Dam (1937-1942), renamed 1941 after Rep. J.J. Mansfield. 266 feet high, 7,098 feet long. LBJ instrumental in securing federal funding. Stores 256 billion gallons of floodwater.

### Strategic positioning shift in progress
Moving from "boat rental" framing → "yacht charter" framing for Carver. KAW + most competitors own "boat rental" keywords. Yacht-tier crowded but premium small-group experience sub-niche is under-served. Most competitors lean bachelor/bachelorette/party.

**TFC's defensible angle:** small groups, families, couples, scenic/sunset, premium experience over party intensity. Plus Volente Beach Waterpark integration is genuinely unique among yacht-tier operators.

### Competitive landscape (Lake Travis yacht-tier — more crowded than first assumed)
1. Lake Travis Yacht Rentals — 6 yachts + 13 pontoons, 12+ years, 13,900+ events (largest, party-positioned)
2. Lake Travis Yacht Charters — 5-cove flexibility, captain + deckhand
3. Lake Travis Boat Rental — single Sundancer 470, $450-650/hr
4. Big Tex Boat Rentals — multi-lake, Mansfield Dam pickup
5. Anchor Yacht Rental — 75+ boats network
6. Fathom Yacht Charters — closest competitor to TFC's anti-party sub-segment ("relaxing serene")
7. Sail Austin Charters — sailing-specific
8. Travis Yacht Charter — 20-guest yacht
9. Boats & Coves — decade-plus

KAW (Keep Austin Wet): 3,200+ reviews, 4 boat types, pickup at Volente Beach Waterpark too.

---

## KNOWN ISSUES / GOTCHAS (memorize)

### Recurring infrastructure friction
- **Supabase env vars drop from Vercel Production during deploys** — verify after every deploy via `/api/availability?vessel=yacht` round-trip
- **Vercel Hobby plan 100-deploys/day limit** — hit before
- **OneDrive occasionally locks `.git/objects` mid-push** — known friction
- **Vercel CLI not installed on Claude Code's machine** — env var checks have to go through endpoint round-trip rather than `vercel env ls`. DJ has not yet OK'd `npm i -g vercel`.
- **Edge cache lag on Vercel production:** first curl after a deploy may show stale content. Bypass with `?bust=$RANDOM` and `Cache-Control: no-cache` headers, OR wait ~30 seconds.

### Future-dated infrastructure dates to remember
- **October 30, 2026 — Supabase Data API GRANT policy change** applies to TFC's project. After this date, any new table created in `public` schema needs an explicit `GRANT ... TO anon, authenticated` statement in its migration, or supabase-js / PostgREST calls to that table will 404. See queue item #22 for full context and the action item (update migration template). Nothing breaks before this date.

### Code-level gotchas
- **Silent webhook handler failures are high-risk** — lesson from double-charge incident. Handler must: validate first, parse second, write third, return last. Any exception before the Supabase write aborts the entire flow.
- **Browser cache:** hard refresh (Ctrl+Shift+R) required after JS changes
- **`position: fixed` escapes containing block, NOT stacking context** — see commit 1678e56 audit for why prior commit 0cde4a7 was a half-fix. Future CSS work involving sticky/fixed positioning needs this mental model.

### Claude Code approval-gate gotcha (operationalized today)
**"Show diff before commit. Commit message: X" is AMBIGUOUS.** Claude Code may interpret as approval-to-commit. Always pair with explicit "wait for my approval after showing diff" if a true approval gate is needed. This caused commit 052ea52 to ship before scope was expanded. Strict triple-gate cadence (audit → propose → diff → commit, each with explicit approval) prevents this. Used cleanly across 7 commits in May 12 session, zero scope creep.

---

## CLAUDE CODE'S MEMORIZED PREFERENCES (as of May 12)

Claude Code wrote these to its persistent memory during May 12 session:
- DJ's no-em-dash preference applies to ALL writing, not just customer-facing copy
- `(at least one more memorized — exact content not captured in this session log; check Claude Code memory at start of next session)`

If a new Claude Code instance is started on a different machine and doesn't have these memorized, surface the preferences early.

---

## CONVERSATION RHYTHM NOTES (for tomorrow's Claude session)

### What worked well in May 12 session
- **Audit-first cadence on EVERY commit** — caught the half-fix in 0cde4a7, caught the false USCG claim, caught the phantom lead-delete feature
- **Mental-model walkthroughs in Step 2 proposals** — Claude Code's kebab dropdown proposal walked through 6 interaction scenarios with actual z-index math, defended the design choice
- **Surface non-scoped issues without acting on them** — Claude Code flagged 5 schema accuracy items while doing the reviewCount fix, queued them rather than expanding scope
- **Explicit "this is not approval-to-commit" language** in all replies — prevented scope creep
- **Pause moments at end-of-session** — caught the phantom lead delete feature before shipping bad code at 11pm

### What DJ flagged as friction (don't repeat)
- Em-dashes in DJ's writing — now Claude Code memorized this preference
- "Show diff before commit" wording without explicit approval gate — caused 052ea52
- Vague specs that let Claude Code interpret scope — caused unauthorized text changes in prior sessions
- Re-asking questions DJ has already answered (which is why this handoff exists)

### Conversation style DJ prefers
- Concise, direct, no fluff
- Bullet-style structure when reasoning through options
- Explicit recommendations with reasoning, not just "here are the choices"
- Honest pushback when DJ asks for something risky (e.g., shipping at end-of-session)
- Recognize fatigue signals; don't rubber-stamp big features at midnight
- Tap-to-answer interactive questions are preferred over typing responses

---

## EXPECTED FIRST QUESTIONS FROM DJ TOMORROW

Prepare for these by having context ready:

1. **"Did Logan respond?"** → Check tonight's text status. Likely DJ will know before asking.
2. **"What's left to do?"** → Refer to Active Queue, surface top 3 priorities
3. **"What did we ship yesterday?"** → 11 commits, list highlights from "Today's Work" section
4. **"Where were we on lead delete?"** → Pull `docs/queue/lead-delete-feature.md` (committed end of May 12 session if it shipped), six open product questions ready to answer

---

## END OF HANDOFF

Total length: long. Read time: ~5 min. This is the price of "no more catching Claude up." Tomorrow's session reads this first, references it throughout, and updates it at end-of-session. If you (future Claude) skip this doc and ask DJ to repeat context, that's on you.
