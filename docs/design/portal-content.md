# Customer Portal — Content & Design Spec

**Status:** Design source-of-truth for Phase 4 implementation.
**Last updated:** 2026-05-15.
**Author:** DJ (specification); Claude (transcription + draft copy for sections flagged below).

This document defines what the customer portal renders, how it adapts to booking state, and what the supporting backend must provide. Phase 4 (the build) implements against this spec. No code in this commit — pure design doc.

---

## Overview

Single URL per booking: `texasforevercharters.com/booking/<portal_token>`

The portal is the customer's self-service home for everything about their charter. It eliminates the most common pre-charter questions: where do I park, what should I bring, where is the dock, do I need to sign a waiver, when do I pay the balance.

Token is the 32-char hex value from `bookings.portal_token` (already provisioned by the Phase 2 migration for future-date bookings; commit `ce62913`). Token-only auth — anyone with the URL can view, no login. Treat the URL like a password: customers should not post it publicly but can freely share it with their party.

---

## Layout Philosophy

- Single scrolling page on a single URL.
- Critical info immediate at top, detail accessible without leaving the page.
- Accordion sections for content that doesn't need to be always-visible (rules, policies, FAQ).
- No subpages within the portal — legal documents (waiver, terms, privacy) link out to the existing standalone pages.
- Mobile-first design (most customers will open on phone, most often the morning of the charter).
- Brand consistency: same colors (`#1B2A6B` navy, `#C8102E` red, `#FFFFFF` white, `#C8D0E8` silver), same fonts (Bebas Neue, Barlow Condensed, Barlow, Source Serif 4).

---

## Section Order

1. Hero (vessel image + charter date)
2. At a glance (booking summary)
3. Waiver status block
4. Before your charter (waterpark perk + arrival timing)
5. Where to go (annotated map + arrival logistics)
6. Day-of captain contact
7. What to bring
8. Game plan
9. Vessel-specific onboard info
10. Accordion: Lake & Boat Rules
11. Accordion: Alcohol Policy
12. Accordion: Weather Policy
13. Accordion: Cancellation & Refund Policy
14. Accordion: Damage Deposit
15. Accordion: Gratuity
16. Accordion: FAQ
17. Contact footer

---

## State-Aware Rendering

Some sections adapt based on:

**Vessel (`bookings.vessel`):**
- Hero image (`images/yacht-main-photo.JPG` vs `images/bentley-main-photo.jpeg`).
- What to bring (pontoon adds "no restroom on board" heads-up; yacht adds marine-toilet rules).
- Vessel-specific onboard info section (different amenities lists).
- Pontoon section includes tubing upsell ($200 add-on) — yacht section does not (yacht has its 14ft jump platform instead).

**Payment status:**
- If `paid_in_full = true`: At-a-glance shows "Payment: Paid in full ✓".
- If balance owed: At-a-glance shows Total / Deposit Paid / Balance Due + "Pay Balance Now" button generating a fresh Stripe Checkout Session.

**Booking lifecycle:**
- If `status = 'cancelled'`: replace normal layout with a cancellation message (charter cancelled; if a refund was issued show the refund amount; contact info for questions).
- If `charter_date < today`: show "Past charter" header; hide Pay Balance / Sign Waiver / Share Waiver action buttons; keep informational sections visible for record/reference.
- If `deleted_at IS NOT NULL`: backend returns 404 (portal route shows "Booking not found" — see Backend Requirements).

**Waiver state:**
- Compare `bookings.party_size` against count of signed waivers (rows in `waivers` matching this booking's `session_id` OR `booking_id`).
- 0 signed: "Waiver not signed yet" + Sign + Share buttons.
- Some signed: "X of Y guests have signed" + Sign + Share buttons.
- All signed: "Waiver complete" + Share button only.

---

## Section Content

### 1. Hero

Full-width image of the booked vessel with text overlay.

- Yacht image: `images/yacht-main-photo.JPG`
- Pontoon image: `images/bentley-main-photo.jpeg`

Overlay content (centered, light-on-dark gradient):

- Eyebrow: `TEXAS FOREVER CHARTERS` (Bebas Neue, letter-spaced 3px, small caps, white at 70% opacity)
- Title: `Your Charter` (Bebas Neue, ~64px desktop / 44px mobile, white)
- Subtitle: formatted date and start time (Barlow Condensed, e.g. `Saturday, June 6, 2026 · 3:30pm`)

If the charter is in the past, append a small chip below the subtitle: `Past Charter` (muted gray).

### 2. At a Glance

Card with key/value rows for:

- **Vessel** — rendered as the full vessel name. Map `bookings.vessel`:
  - `yacht` → `40ft Carver Aft Cabin Yacht`
  - `pontoon` → `24ft Bentley Navigator 243 Pontoon`
- **Experience** — `bookings.experience` (e.g. "Lake Day", "Sunset Cruise", "Private Party")
- **Duration** — `bookings.duration` formatted as `X hours` (e.g. "4 hours")
- **Party Size** — `bookings.party_size` formatted as `N guests`
- **Charter Name** — `bookings.charter_name` (the customer-chosen title for their trip, e.g. "Fun in the Sun")
- **Organizer** — first name only. Split `bookings.full_name` on whitespace, take the first token. Same redaction pattern used in `api/get-checkout-session.js` (see `firstName()` helper from commit `5e264f3`).

#### Payment row (conditional)

If `paid_in_full = true`:
> Payment: **Paid in full ✓**

Else (balance owed):

| Label | Value |
|---|---|
| Total | `$<grand_total>` |
| Deposit Paid | `$<deposit_amount>` (or computed from amount_total/100 when explicit deposit_amount is null) |
| Balance Due | `$<remaining_balance>` |
| Due By | computed as 14 days before `bookings.date` |

Below the table: a prominent red "Pay Balance Now" button.

#### Pay Balance Now button behavior

- Calls a new endpoint (Phase 4): `POST /api/portal/<portal_token>/create-balance-session`.
- Generates a fresh Stripe Checkout Session for the balance amount on every click (or reuses an unpaid pending session, see Open Items #3).
- NOT a Stripe Payment Link — Payment Links are immutable per-amount, which bit us in G14. Stripe Checkout Sessions are regeneratable.
- Stores the new session id in `bookings.balance_payment_intent_id` (column already added in Phase 2 migration).
- Updates `bookings.payment_link_status` to `'pending'` (column already added; CHECK constraint allows `'none' | 'pending' | 'paid' | 'expired'`).
- Customer redirects to Stripe Checkout, pays, webhook fires on `checkout.session.completed` with `metadata.original_session_id` pointing at the original booking. Webhook patches the original booking row to `paid_in_full = true` per the existing G19-fixed flow in `api/stripe-webhook.js:352-503`.

### 3. Waiver Status Block

Counts signed waivers for the booking by looking up the `waivers` table by `session_id` OR fallback `booking_id` (mirroring `listAllWaiversEnriched` pattern in `lib/storage.js:661`).

Three states:

#### State A — 0 signed

> **Liability Waiver: Required Before Boarding**
>
> Every guest on board must sign a digital liability waiver before your charter. None of your party of `<party_size>` has signed yet. The booking organizer is responsible for getting everyone signed before charter day. Guests who arrive unsigned cannot board.

Two buttons (side by side on desktop, stacked on mobile):
- **Sign Your Waiver** (red, primary) → `/waiver.html?session_id=<booking.session_id>` (existing waiver flow uses `session_id`, not `portal_token`; the waiver page pre-fills charter info from the session_id).
- **Share With Guests** (navy outline, secondary) → copies the waiver URL to clipboard. On mobile, opens native share sheet via Web Share API when available.

#### State B — partial signed (1 to party_size-1)

> **Liability Waiver: `<signed_count>` of `<party_size>` Have Signed**
>
> The remaining `<party_size - signed_count>` guest(s) need to sign before charter day. The booking organizer is responsible for following up.

Same two buttons as State A.

#### State C — all signed (signed_count >= party_size)

> **✓ Waiver Complete**
>
> All `<party_size>` guests in your party have signed. You're cleared to board.

One button:
- **Share With Guests** (navy outline) — kept in case the party grows or an additional guest joins. Same clipboard / Web Share API behavior.

#### Share button mechanics

- **Copy:** writes `https://texasforevercharters.com/waiver.html?session_id=<booking.session_id>` to clipboard via `navigator.clipboard.writeText`.
- **Toast on success:** `Waiver link copied. Send it to your guests.`
- **Web Share API (mobile):** when `navigator.share` is available, presents the native share sheet with text `Sign your Texas Forever Charters waiver before our trip:` and the URL.
- **Fallback:** if both clipboard API and Web Share API are unavailable (rare — old browser), show a modal with the URL pre-selected for manual copy.

### 4. Before Your Charter

Two practical heads-ups for the day of: the included waterpark access perk and the arrival-timing rule.

#### 4a. Volente Beach Waterpark Access

> Your charter includes complimentary Volente Beach Waterpark access, before and after your trip. Mention Texas Forever Charters at the gate. Bring a swimsuit, hit the slides, grab food at Beachside Billy's. The park is right there at the property.

#### 4b. Arrive 15 Minutes Early

> Plan to be at the dock **15 minutes before your departure time**. Your captain runs a quick 10-minute safety briefing before you push off, covering the boat layout, the rules, and where everything is. The earlier you're aboard, the more lake time you get.

### 5. Where to Go

Address line (large, copyable): **16107 FM 2769, Leander, TX 78641**

Landmark callout (highlighted card):
> When you arrive at the property, you'll see **Beachside Billy's** and **Volente Beach Waterpark & Resort** on your left. That's the right place.

Buttons row:
- **Open in Google Maps** (red primary) → `https://www.google.com/maps/search/?api=1&query=16107+FM+2769+Leander+TX+78641`
- **Open in Apple Maps** (navy outline) → `https://maps.apple.com/?address=16107+FM+2769,+Leander,+TX+78641` (iOS-only consideration; render only on Apple devices via UA sniff OR show universally with a note that it opens the user's default maps app)

Embedded map: `images/drawn-map.png` — the annotated map with park-here / Uber-dropoff / boat-pickup pins and the green walking path. Display at a comfortable size on both desktop (max-width 720px) and mobile (full bleed with rounded corners).

Four sub-sections of copy follow the map.

#### 5a. Driving Yourself

> When you turn onto the property, drive past Beachside Billy's and continue toward the back. There's a **dirt lot at the end of the drive. That's where you park**. Parking is **$10 per vehicle**, paid at the lot.
>
> Once parked, follow the **green-highlighted path** on the map above. It walks you down to the tan plastic floating dock where your captain will be waiting.
>
> ⚠ Don't park in the marked private slots or along the access road. **Vehicles get towed.** We can't get them released for you.

#### 5b. Getting Dropped Off

> If you're taking an Uber, Lyft, or having a friend drop you off: have them **drop you at the parking pull-off just off Wharf Cove** (marked on the map). From there, walk the same **green-highlighted path** down to the tan dock.
>
> Tell your driver "Volente Beach Waterpark" if they need a destination they'll recognize. The dropoff is in the same area.

#### 5c. At the Dock

> Your captain will meet you at the **tan plastic floating dock** at the bottom of the green path. Both the yacht and the pontoon depart from this same dock.
>
> **Important:** this is NOT the **VIP Marina** dock further along the property. If you find yourself on a wood-and-aluminum dock with covered slips, you've walked too far. Head back toward the tan plastic dock.

#### 5d. Lost or Confused?

> Call or text your captain at **(737) 368-1669** the moment something doesn't look right. We'd rather walk you in over the phone than have you wandering the property.

### 6. Day-of Captain Contact

Per DJ's design call, captain identity is a day-of surprise. **The portal does NOT pre-assign DJ or Dane.** Both are PBO-certified and either runs your trip.

Copy:

> **Your Captain**
>
> Your captain will reach out the day of your charter to confirm final details. Both **DJ** and **Dane** are PBO-certified captains, and either one might be running your trip.
>
> Need to reach us before then?
> 📞 Call or text **(737) 368-1669**
> ✉ Email **tx4evercharters@gmail.com**

**CRITICAL CONSTRAINT (memory rule):** Use **PBO-certified** only. **Never** use "USCG", "Coast Guard", or any federal-credential terminology. TFC captains are Texas state-licensed Party Boat Operators. This applies to every customer-facing surface, this portal included.

### 7. What to Bring

Universal list (all charters):

- Food and drinks (no glass on the pontoon; glass allowed in the yacht cabin only)
- Ice for your drinks, or add it as a charter add-on
- Plenty of water. Lake Travis sun is no joke
- Sunscreen (lots of it)
- Swimwear and a change of clothes
- Towels (bring your own, or add them to your order)
- Cash, Zelle, or Venmo for your captain's tip (20% required, paid day-of)
- A valid ID for anyone planning to drink
- Phone charger (yacht has outlets on board; pontoon does not)

#### Pontoon-only callout (render only if `vessel = 'pontoon'`)

> ⚠ **No restroom on board.** The pontoon doesn't have a head, so plan accordingly. Use the facilities at Volente Beach before departure, and let your captain know if you need a shore break during the charter.

#### Yacht-only callout (render only if `vessel = 'yacht'`)

> ⚠ **Marine toilet rules.** The yacht has two restrooms with marine toilets. They handle human waste and a small amount of marine-safe TP only. **No feminine products, no paper towels, no large amounts of toilet paper.** Clogged marine toilets are a damage event. There's a trash bin in each restroom for everything else.

### 8. Game Plan

> **Where We Go**
>
> Lake Travis is big and your captain knows it well. Most charters follow a flexible plan. You've got opinions, the captain has alternatives, and the lake decides the rest. Here's what shows up on most trips.
>
> **Devil's Cove** is the default destination on the majority of our charters. It's the iconic Lake Travis anchor spot, a wide, shallow cove where boats raft up, music plays, and float mats stretch from boat to boat. Most groups want at least an hour here, sometimes the whole charter. Saturday afternoons in summer it gets packed; weekdays and shoulder season it's almost private.
>
> **Arkansas Bend** is a captain favorite for groups who want a longer cruise. It's a quieter cove down the lake with a chill, family-and-kids vibe: calmer water, fewer boats, easy swimming. Tell your captain at the start of the trip if you'd like to head that way.
>
> **Hippie Hollow** is visible from the water and worth knowing about: it's Texas's only legally clothing-optional public park, run by Travis County. **Adults-only vibe.** Boats cruise past for the views, but it's not where you'd anchor with kids on board. Tell your captain if your group prefers to skip that stretch.
>
> Other stops your captain can suggest: **Mansfield Dam**, where the captain can cruise past for the impressive concrete face, and the **Sandy Creek arm** for quieter swimming.
>
> Once you're aboard, tell your captain what you're after (relaxed swim cove, party scene, scenic tour, sunset spot), and they'll route the day accordingly.

### 9. Vessel-Specific Onboard Info

Render exactly one of the two blocks below based on `bookings.vessel`.

#### 9a. Yacht (`vessel = 'yacht'`)

> **On Board the 40ft Carver Aft Cabin**
>
> Your yacht charter comes loaded:
>
> - **14ft jump platform** off the stern. The iconic Carver feature, perfect for big leaps into the water.
> - **3 floating dock floats / mats.** Raft up off the back, lounge with drinks.
> - **Paddleboards** available when conditions allow (weather and cove traffic dependent). Captain's call on the day.
> - **Bluetooth speaker system.** Pair your phone, run the playlist.
> - **Large cooler** stocked with ice (when ice add-on selected). Keep your drinks cold.
> - **2 private bedrooms** below deck.
> - **2 marine restrooms** with sinks.
> - **Refrigerator** in the cabin.
> - **Phone charger outlets** on board.
> - **Full interior cabin** with salon and kitchenette. Shade, seating, escape from the sun.
>
> 🚫 **No personal coolers**, please. Our cooler is large and on board for a reason: extra coolers crowd the deck and risk damage. Bring your drinks, we'll keep them cold.

#### 9b. Pontoon (`vessel = 'pontoon'`)

> **On Board the 24ft Bentley Navigator 243**
>
> Your pontoon charter includes:
>
> - **Bimini top.** Shade across the seating area.
> - **1 lilypad.** Floating mat off the back for swimming and lounging.
> - **Bluetooth speaker system.** Pair your phone, run the playlist.
> - **Large cooler** stocked with ice (when ice add-on selected). Keep your drinks cold.
>
> 🚫 **No personal coolers**, please. Our cooler is large and on board for a reason: extra coolers crowd the deck and risk damage. Bring your drinks, we'll keep them cold.
>
> ❗ **No restroom on board** (see What to Bring above).
>
> #### Upgrade your trip: Tubing
>
> Want to pull tubes behind the pontoon? Add tubing to your charter for **$200**. Call **(737) 368-1669** to upgrade. Captain handles the rig and the runs.

Implementation note (out of scope for this commit): a future Phase 4 follow-up commit may replace the call-to-add flow with a self-serve Stripe Checkout Session for the tubing add-on; for now, the rendered HTML is plain text + a `tel:` link, no button.

### 10. Accordion: Lake & Boat Rules

When expanded:

> **Lake Travis Rules**
>
> - Children under 13 must wear a USCG-approved life jacket while on deck. Life jackets are provided for everyone on board. PFDs not required when guests are seated inside the cabin or under seats.
> - Texas state law requires all boaters to follow Texas Parks & Wildlife regulations. Your captain handles compliance.
> - Lake Travis is a natural body of water with bacteria, pollutants, and environmental factors outside our control. Swim at your own risk.
>
> **Boat Rules (the canonical list)**
>
> - No glass containers on deck or pontoon. Glass allowed in yacht cabin only (NEVER on pontoon).
> - No standing while vessel is underway.
> - No limbs outside the railings while underway.
> - No littering, please.
> - No smoking anything that produces ash on either vessel. Vaping is permitted on deck. If you want to smoke something that ashes, do it in the water or on a float mat while anchored.
> - No nudity. No sexual activity on board.
> - No illegal drugs or unauthorized substances. Immediate removal and possible legal action.
> - Reckless or unsafe behavior is grounds for removal without refund.
> - Capacity is strictly enforced: 20 guests on the yacht, 13 on the pontoon. No exceptions.
> - Shoes off on the yacht (especially black soles, which damage the deck). Pontoon is fine with shoes on.
> - Guests are responsible for damage they cause. See Damage Deposit section below.

**Note on language:** "USCG-approved" here is correct because it refers to the **life jacket equipment specification** (the standard for the gear), NOT to the captain's credentials. The captain rule is PBO-only. Equipment standard ≠ captain credential.

### 11. Accordion: Alcohol Policy

When expanded:

> BYOB is fully welcome. Bring whatever you'd like.
>
> Rules:
>
> - The **booking organizer must be 21 or older** and is legally responsible for ensuring no one under 21 consumes alcohol.
> - Anyone under 18 must be accompanied by a parent or guardian.
> - **Glass is allowed only inside the yacht cabin.** Never on the deck or anywhere on the pontoon.
> - **Catering is available** through Beachside Billy's at Volente Beach Waterpark if you want it.
> - Texas Forever Charters reserves the right to end the charter without refund if alcohol policies are violated or if guests appear unsafe.

### 12. Accordion: Weather Policy

When expanded:

> Texas Forever Charters decides on the day of your charter whether weather makes the trip unsafe.
>
> - **Light rain doesn't cancel us.** Lake Travis often stays clear even when downtown Austin is wet.
> - **Storms, lightning, or unsafe wind:** your captain has the final call.
> - **If we cancel for weather:** full refund (including your booking fee) OR free reschedule, your choice.
> - **If a storm cuts your charter short mid-trip:** you get a pro-rated refund for the time lost on the water.
> - **If you want to cancel because of weather but we're still going out:** standard cancellation policy applies.
>
> Questions about weather day-of? Call **(737) 368-1669**. We'll be honest with you.

### 13. Accordion: Cancellation & Refund Policy

When expanded:

> **Booking Fee (10% of total)**
>
> - Non-refundable under all circumstances. This holds your date.
>
> **Balance refunds (the remaining 90%):**
>
> - 14+ days before charter: **full balance refund**
> - 7–13 days before: **50% balance refund**
> - Less than 7 days: **no refund**
>
> **Texas Forever cancels for weather:**
>
> - Full refund (including the booking fee) OR free reschedule
>
> **Rescheduling:**
>
> - Call (737) 368-1669
> - 7+ days out: case-by-case, usually no problem
> - Within 7 days: requires documented emergency
>
> **Other refunded items** (proportional to the refund amount):
>
> - 5% admin fee
> - 8.5% Texas sales tax
> - 2.9% credit card processing fee may or may not be refunded depending on Stripe's policy

### 14. Accordion: Damage Deposit

When expanded:

> **How the $250 hold works:**
>
> - When you book, we place a **$250 pre-authorization hold** on your card.
> - A pre-authorization is **NOT a charge**. The funds are held but not withdrawn.
> - **If no damage occurs:** the hold is released within 48 hours of your charter ending.
> - **If damage occurs:** we charge the actual cost of repair or replacement, with a $250 minimum.
>
> **What counts as damage:**
>
> - Physical damage to the vessel
> - Stains, spills, or messes that require professional cleaning
> - Anything that makes the boat unusable for the next charter
>
> If damage exceeds $250, the additional cost is charged to your card.

### 15. Accordion: Gratuity

When expanded:

> A **20% gratuity is required**, and it's paid directly to your captain on the day of the charter.
>
> **How to pay:**
>
> - Cash
> - Zelle
> - Venmo
>
> The captain will give you their handle on the day of the charter. This is **not collected through the website**.
>
> **Why 20%?** Captains do the prep work, the safety briefing, the navigation, the anchoring, the cleanup, and they make sure your trip is great. It's industry standard for captained charters.

### 16. Accordion: FAQ

Mirror the existing website FAQ from `index.html` (lines 333-456), with the following corrections applied per DJ's confirmed answers:

- **Life jacket question:** "Under-13s must wear life jackets while on deck. PFDs not required inside the cabin or under seats." (Corrects the index FAQ's "at all times" wording.)
- **Damage policy:** remove the specific $200 toilet-incident figures. State the $250 minimum and "guests are responsible for the actual cost of damage." (Aligns with `terms.html:191-220`.)
- **Weather:** align with the pro-rated mid-charter refund policy above (matches what the AI chatbot already says).
- **Organizer 21+ rule:** explicitly stated as a hard requirement (currently only in the chatbot system prompt, not in any customer-facing legal copy).

Plus add these portal-specific FAQs at the end:

- **How much do add-ons cost?** → "Add-on pricing: drone footage $200 per charter, towels $8 each, water bottles $25 per pack, ice $25 per bag, beer pong $50. Drone footage and beer pong are per-charter flat fees. Towels are per-towel. Add these at booking time, or call (737) 368-1669 to add them later."
- **Can I share this portal link?** → "Yes, share with your party. Treat the URL like a password. Don't post it publicly. Anyone with the link can see your charter details."
- **Can I edit my booking from the portal?** → "Not yet. Call **(737) 368-1669** to make changes: dates, party size, vessel, anything."
- **What if I'm running late on charter day?** → "Call your captain immediately at **(737) 368-1669**. We try to wait, but other charters depend on our schedule. If you're more than 15 minutes late and we can't reach you, your captain may have to leave."
- **Why am I being asked to pay a balance?** → "If you booked with a 10% deposit, the remaining 90% is due 14 days before your charter. Pay it from the top of this page. It's a fresh Stripe checkout, takes 30 seconds."
- **What if I lose this link?** → "Call or text **(737) 368-1669** and we'll re-send it. Same booking, same URL. We don't issue new portal tokens unless something's wrong."

### 17. Contact Footer

Always-visible footer (no accordion):

> **Questions? We're here.**
>
> 📞 (737) 368-1669
> ✉ tx4evercharters@gmail.com

Plus links to existing legal pages:

- Charter Agreement & Terms of Service (`/terms.html`)
- Privacy Policy (`/privacy.html`)
- Liability Waiver (`/waiver.html`)

---

## Admin Integration

### Wizard-flow bookings (customer self-served via `/booking.html`)

**Trigger:** Stripe webhook fires after successful payment.

**Existing behavior:** `sendConfirmationEmails()` called from `api/stripe-webhook.js:674` (and again from the remaining-balance branch at line 473).

**Phase 4 change:** Modify the customer confirmation email template in `lib/send-emails.js` (`buildCustomerEmail()` at line 175) to include a **Your Charter Portal** link button pointing to `https://texasforevercharters.com/booking/<portal_token>`.

The `portal_token` must already be on the booking row by the time the email fires. This requires Phase 2.5 application code:

1. **On wizard-flow insert** (`saveBooking` in `lib/storage.js:70`): generate `portal_token` via `crypto.randomBytes(16).toString('hex')` if the field is null. Persist with the booking.
2. **On admin-flow insert** (`addManualBooking` in `lib/storage.js:504`): same — generate at insert time.
3. **For historical bookings without tokens**: the Phase 2 migration already backfilled future-date bookings. No additional work.

### Admin-flow bookings (created via admin panel)

**Existing behavior** (confirmed from audit of `api/admin.js:829-893`):

- "Save Booking" button → silent save, **no email sent**
- "Save & Send Confirmation" button → calls `sendConfirmationEmails()`, customer email sent

**Phase 4 change:** when "Save & Send Confirmation" is clicked, the same modified email template includes the portal link (identical to wizard flow).

When "Save Booking" (silent) is clicked: no email sent. Booking is saved with `portal_token`. Admin can later send the portal link via a NEW button.

### New admin functionality: Portal Link actions

For every saved booking row, add to the kebab menu / row actions in `admin.html`:

- **📋 Copy Portal Link** — copies the URL `https://texasforevercharters.com/booking/<portal_token>` to clipboard, shows toast "Portal link copied".
- **📧 Send Portal Link** — sends a new transactional email (separate from the confirmation email).

#### The "Send Portal Link" email

New template in `lib/send-emails.js` (e.g. `sendPortalLinkEmail()` modeled after `sendWaiverLinkEmail()` at line 1045):

- **Subject:** `Your Charter With Texas Forever Charters`
- **Body:** brief intro identifying the customer + charter date / time / vessel; big red button to the portal URL; contact info footer; same brand styling as other customer emails.
- **Recipient:** `booking.customer_email` (the existing-on-file address; never accept an override per `api/resend-confirmation.js` lockdown pattern from commit `5e264f3`).
- **Logged to `booking_events`** with `event_type = 'portal_link_email_sent'`, `event_data = { sent_to: <masked customer_email>, source: 'admin_action' }`, `created_by = 'admin'`.

#### The "Copy Portal Link" action

Client-side only (no API call):

- Reads `bookings.portal_token` from the in-memory admin booking list.
- Constructs the URL.
- Uses `navigator.clipboard.writeText`.
- Shows confirmation toast.

---

## Backend Requirements

### New endpoints (Phase 4)

#### `GET /api/portal/<portal_token>`

- Path parameter: 32-char hex `portal_token`.
- Looks up booking by `portal_token` field.
- Returns 404 if `portal_token` not found OR `booking.deleted_at IS NOT NULL`.
- Returns whitelisted booking data needed for portal render:

```json
{
  "ok": true,
  "booking": {
    "vessel": "yacht",
    "experience": "Lake Day",
    "charter_name": "Fun in the Sun",
    "date": "2026-06-06",
    "time_slot": "3:30pm",
    "duration": 4,
    "party_size": 18,
    "status": "upcoming",
    "is_past": false,
    "session_id": "cs_live_...",
    "customer_first_name": "Kendrina",
    "customer_email_masked": "k*****@gmail.com",
    "customer_phone_masked": "***-***-5124",
    "payment": {
      "paid_in_full": false,
      "grand_total": 1484.9,
      "deposit_amount": 148.49,
      "remaining_balance": 1336.41,
      "balance_due_date": "2026-05-23",
      "payment_link_status": "none"
    },
    "waiver": {
      "signed_count": 0,
      "party_size": 18,
      "all_signed": false
    }
  }
}
```

- **Public endpoint, no auth.** The token IS the auth. Treat the URL like a password.
- **Redaction:** apply the same `maskEmail` / `firstName` / `maskPhone` helpers from `api/get-checkout-session.js` (commit `5e264f3`). Never return raw `customer_email`, `full_name`, or `phone`.
- **`session_id` is included** because the Waiver Sign button needs to construct `/waiver.html?session_id=<X>` (the waiver flow has its own auth model — anyone can sign a waiver against a session id; that's by design).

#### `POST /api/portal/<portal_token>/create-balance-session`

- Generates a fresh Stripe Checkout Session for the remaining balance.
- Body: empty (the token is the auth; balance amount is computed server-side from the booking row).
- Server reads `booking.remaining_balance`, validates it's > 0, builds the Stripe Checkout Session with `metadata.original_session_id = booking.session_id` (so the webhook can patch the right row per the existing G19-fixed logic in `api/stripe-webhook.js:352`).
- Stores the new Stripe checkout session id in `bookings.balance_payment_intent_id`.
- Updates `bookings.payment_link_status` to `'pending'`, sets `bookings.payment_link_created_at = now()`.
- Logs a `booking_events` row: `event_type = 'balance_session_created'`, `event_data = { stripe_session_id: <id>, amount_cents: <X> }`.
- Returns `{ ok: true, url: <stripe_checkout_url> }`.
- **Public endpoint, token-gated.** Rate-limit per portal_token (e.g. max 5 sessions created per token per hour) to prevent abuse.

#### `GET /api/portal/<portal_token>/waiver-status`

- Returns count of signed waivers for this booking.
- Server reads `waivers` where `session_id = booking.session_id` OR `booking_id = booking.id` (mirroring `listAllWaiversEnriched` pattern).
- Returns `{ ok: true, signed_count: <N>, party_size: <M>, all_signed: <bool> }`.
- **Public endpoint, token-gated.**
- Used by the portal frontend to refresh the Waiver Status block without a full page reload (poll-on-focus or refresh-button).

### New admin endpoint

#### `POST /api/admin/send-portal-link`

- Admin-only (Bearer token, like other admin actions — routed via the existing `api/admin.js` dispatcher with action `send-portal-link`).
- Body: `{ session_id: <booking session_id> }`.
- Looks up booking, validates `customer_email` is on file, sends the portal-link email via the new `sendPortalLinkEmail()` template.
- Logs to `booking_events` as `event_type = 'portal_link_email_sent'`.
- Response: `{ ok: true, email: <masked> }` on success; structured error on failure (mirrors `api/resend-confirmation.js` post-hardening shape from commit `5e264f3`).

### Schema columns used (all already exist from Phase 2 migration `ce62913`)

- `bookings.portal_token` (the URL identifier; 32-char hex)
- `bookings.payment_link_url`, `.payment_link_id`, `.payment_link_status`, `.payment_link_amount_cents`, `.payment_link_created_at` (balance payment state)
- `bookings.balance_payment_intent_id` (the actual balance checkout session id)
- `bookings.deleted_at` (soft delete — portal returns 404 if not null)
- `booking_events` (audit log — Phase 2.5 wiring will write to this on state changes; the portal endpoints also write here)

### Phase 2.5 application code (separate commit, NOT this commit, NOT Phase 4)

Required before Phase 4 portal launch:

1. **Token generation at booking creation:** modify `lib/storage.js`'s `saveBooking` (line 70) and `addManualBooking` (line 504) to generate `portal_token` via `crypto.randomBytes(16).toString('hex')` when the field is null.
2. **Event logging:** add a helper `lib/booking-events.js` exporting `logBookingEvent(session_id, event_type, event_data, created_by)`. Call it from:
   - `saveBooking` → `booking_created` (replace the synthetic backfilled flag with a real event after Phase 2.5 ships).
   - `patchBooking` → `booking_updated` (with the fields-changed diff in `event_data`).
   - `markBookingPaid` → `booking_paid_in_full`.
   - Webhook `charge.refunded` handler → `refund_processed`.
   - Webhook `charge.dispute.created` handler → `chargeback_filed`.
   - Admin send-payment-link → `payment_link_created` (replaces the planned `balance_session_created` event for legacy payment-link flow if kept).
   - Admin cancel-booking → `booking_cancelled`.
   - Admin send-portal-link → `portal_link_email_sent`.

The `booking_events` table already exists, has the synthetic `booking_created` backfill rows, and has RLS enabled. Phase 2.5 = the application-side writes.

---

## Visual & UX Notes

- Match existing site fonts: **Bebas Neue** (headings), **Barlow Condensed** (eyebrows / labels), **Barlow** (body), **Source Serif 4** (rare display text).
- Match existing site colors:
  - Navy primary: `#1B2A6B`
  - Navy dark: `#0F1A45`
  - Red accent: `#C8102E`
  - White: `#FFFFFF`
  - Silver: `#C8D0E8`
  - Gold (callouts): `#FBBF24` / `#F59E0B` / `#FCD34D` (see existing email-fail banner pattern)
- Mobile-first; design assuming most opens happen on phones.
- Accordion sections: smooth expand/collapse, no jarring page jumps. Default closed.
- Buttons follow existing site conventions:
  - **Primary** (red): high-impact actions (Pay Balance Now, Sign Your Waiver).
  - **Secondary** (navy outline): supporting actions (Open in Google Maps, Copy Link).
  - **Tertiary** (ghost): destructive or low-impact (close modals, dismiss toasts).
- **"Pay Balance Now" button** gets prominent treatment — large, red, top-of-page if balance owed. Not buried in an accordion.
- **Sticky header on scroll** (similar to `admin.html` pattern) showing "Your Charter — June 6, 2026" so customer always knows what they're looking at. Collapses to a thinner bar on scroll.
- **Toast notifications** for actions like "Waiver link copied" — same toast pattern used elsewhere on the site (see `booking.html` showToast / `admin.html` showSuccess).
- **No login flow, no password prompts** — the URL IS the auth.
- **Loading state** — while the portal fetches `/api/portal/<token>`, show a centered loading state with the TFC logo and "Loading your charter…" text. If 404, show a clear "We couldn't find that booking. Check the link or call (737) 368-1669."
- **Error state** — network errors should be retryable with a "Try again" button; auth-style 404s should NOT offer retry (it'd be misleading).

---

## Out of Scope for This Spec

- The actual frontend implementation (HTML/CSS/JS files for the portal page itself) — that's Phase 4.
- The Phase 2.5 application code that writes `portal_token`s on new bookings + writes to `booking_events` on state changes — separate commit before Phase 4.
- Existing-site contradiction fixes (life jacket scope in index FAQ, $200 toilet figures, etc.) — separate small commit; tracked in the portal content audit document.
- Auto-send of portal link in confirmation email — implemented in Phase 4 via `lib/send-emails.js` modifications.
- Customer ability to edit their own booking via portal (call captain for changes).
- Customer self-cancel via portal (call captain for cancellations).
- Booking history per customer (this is per-booking, not per-customer; future "My Account" feature if ever scoped).
- Push notifications, email-based portal reminders, day-of automated check-in emails (all future feature work).

---

## Open Items for Phase 4 Decisions

1. **Vessel hero image**
   - Yacht: `images/yacht-main-photo.JPG` is confirmed.
   - Pontoon: `images/bentley-main-photo.jpeg` is the current `booking.html` choice. Phase 4 implementer should verify this is the right hero shot vs alternatives in `images/` (`bentley-bow.jpeg`, `bentley-side.jpeg`, etc.).

2. **Stripe Checkout Session expiration for balance payments**
   - Recommend 7-day expiration on each generated session.
   - Stripe Checkout sessions default to 24 hours; can be configured up to 30 days via `expires_at`.
   - 7 days balances "enough time for the customer to remember to pay" against "stale unpaid sessions don't accumulate."

3. **"Pay Balance Now" button behavior if a session is already pending**
   - Option A: regenerate fresh on every click (simplest; potential for duplicate sessions; Stripe handles dedup on customer side).
   - Option B: reuse the existing `bookings.balance_payment_intent_id` if status is still `pending` and not expired; only regenerate if expired or paid-but-webhook-late.
   - **Recommendation:** Option B. Cleaner state machine; matches the spirit of `bookings.payment_link_status` having a `pending` value.

4. **Mobile share-sheet integration**
   - Use Web Share API (`navigator.share`) when available — gives native iOS / Android share sheet.
   - Fall back to clipboard copy on desktop / unsupported browsers.
   - Test on iOS Safari + Android Chrome before Phase 4 ships.

5. **Tubing add-on button on pontoon**
   - Self-serve checkout add (generate a new Stripe Checkout Session for $200 against the existing booking)?
   - OR a "Call to add" prompt that opens `tel:+17373681669`?
   - Self-serve is more polished but adds complexity; call-to-add is simpler and matches existing site philosophy of "for changes, call us."
   - **Recommendation:** start with call-to-add for Phase 4 launch; revisit self-serve after the portal is in customer hands and we see real demand.

6. **Past-charter view**
   - When `charter_date < today`, the portal still loads. What does it show?
   - **Recommendation:** keep all informational sections visible (where to go, rules, FAQ — useful for someone reviewing the trip after the fact); hide action buttons (Pay Balance, Sign Waiver, Share); show a "Past Charter" chip in the hero; show post-charter actions instead — link to `/feedback.html?session_id=<X>` for the review request flow.

7. **Cancelled booking view**
   - When `status = 'cancelled'`, replace normal layout with a cancellation message.
   - Should it show the refund amount (`refund_amount`, `refunded_at`)?
   - Should it allow re-booking (link to `/booking.html`)?
   - **Recommendation:** yes to both. Customer might come back to the URL after a cancellation and want to see what was refunded + book again.

8. **Sticky header content on scroll**
   - Show `Your Charter — Saturday, June 6` (date, no time)?
   - Or `Your Charter` only?
   - **Recommendation:** date included. Helps customers who have multiple portal tabs open distinguish them.

9. **Token regeneration**
   - If a customer suspects their portal URL has leaked, can admin regenerate the token?
   - **Recommendation:** yes; add a "Regenerate Portal Token" admin action that:
     - Writes a fresh `portal_token` via `crypto.randomBytes(16).toString('hex')`.
     - Old token immediately 404s.
     - Logs to `booking_events` as `event_type = 'portal_token_rotated'`.
     - Admin can re-send the new portal link via the existing Send Portal Link action.
   - Out of scope for Phase 4 initial launch; add to Phase 4.1 backlog.

10. **Portal link CTAs in existing customer emails**
    - Currently the customer confirmation email has a single "View Booking Details" link to `/booking-confirmation.html?session_id=<X>`. After portal launch, should that email link change to point at the portal instead?
    - **Recommendation:** yes — portal supersedes the static confirmation page for customer reference. The confirmation page becomes the "right after payment" landing only; the portal becomes the persistent reference URL. Email template update in `lib/send-emails.js` is a Phase 4 deliverable.

---

## Drafted Copy Verification

The following sections contain copy I (Claude) drafted based on DJ's bullet-point descriptions during the spec conversation, since canonical Part 1 / Part 2 spec text wasn't pasted in this session:

- **Section 3 (Waiver Status Block)** — three state copy variants drafted from DJ's "0 / partial / all signed" outline.
- **Section 5 (Where to Go)** — four sub-sections (Driving / Drop-off / Dock / Lost) drafted from DJ's brief descriptions ($10 dirt lot, tan plastic dock not VIP Marina, etc.).
- **Section 8 (Game Plan)** — Devil's Cove + Arkansas Bend + Hippie Hollow adults-only note, plus Mansfield Dam and Sandy Creek arm as captain-suggested alternatives.
- **Section 9 (Vessel-Specific Onboard Info)** — yacht and pontoon amenity lists drafted from DJ's brief enumeration of features.
- **Section 16 (Portal-specific FAQs)** — the portal-specific FAQ items.

DJ should review and revise this copy before Phase 4 implementation begins. Final copy lands in Phase 4 HTML; this doc is the canonical reference Phase 4 implements against.
