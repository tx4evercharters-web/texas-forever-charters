# Texas Forever Charters

Official website and booking platform for **Texas Forever Charters** — Austin's premier captained boat charter on Lake Travis.

## 🛥️ About

Texas Forever Charters offers fully captained boat charters on Lake Travis, Austin TX. Departing from Volente Beach Waterpark & Resort.

**Captains:** DJ (Daniel Kilpatrick) & Dane Kilpatrick  
**Phone:** (737) 368-1669  
**Email:** tx4evercharters@gmail.com  
**Website:** texasforevercharters.com  
**Location:** Volente Beach Waterpark & Resort, Lake Travis, Austin TX

**Fleet:** 40ft Carver Aft Cabin yacht (up to 20 guests) · 24ft Bentley Navigator 243 pontoon (up to 13 guests)

---

## 🗂️ Project Structure

```
texas-forever-charters/
├── index.html                      # Homepage
├── booking.html                    # 8-step booking wizard (main customer flow)
├── booking-confirmation.html       # Post-Stripe success page
├── admin.html                      # Password-gated admin dashboard
├── feedback.html                   # Post-charter star rating + Google Reviews redirect
├── waiver.html                     # Liability waiver signing
├── terms.html                      # Charter Agreement / Terms of Service
├── austin-*.html                   # SEO landing pages (boat tours, rentals, lake tour)
├── lake-travis-*.html              # SEO landing pages (sunset cruises, family tours, rentals)
├── private-party-boat-austin.html
│
├── api/                            # Vercel serverless functions (Node 20.x)
│   ├── admin.js                    # Action-routed admin operations (~25 actions, auth-gated)
│   ├── availability.js             # GET availability (date+vessel) and blackouts list
│   ├── chat.js                     # Anthropic chatbot proxy (server-locked system prompt)
│   ├── create-checkout.js          # Stripe Checkout session + duplicate-booking guard
│   ├── cron-reminders.js           # Daily reminders (21/14/13/12 days) + post-charter reviews
│   ├── feedback.js                 # Star rating + comment → email business
│   ├── get-checkout-session.js     # Confirmation page lookup
│   ├── resend-confirmation.js      # Manual confirmation email recovery
│   ├── send-confirmation.js        # Admin-triggered resend by Stripe session
│   ├── stripe-webhook.js           # checkout.session.completed → save booking + $250 hold + emails
│   ├── subscribe.js                # Mailchimp newsletter + Resend welcome
│   └── waiver.js                   # GET pre-fill / POST signed waiver (rate-limited)
│
├── lib/                            # Shared server-side modules
│   ├── auth.js                     # HMAC token gen/verify for admin
│   ├── send-emails.js              # All email templates (Resend)
│   └── storage.js                  # Supabase REST queries (bookings, customers, blackouts, waivers)
│
├── js/                             # Client-side scripts
│   ├── main.js                     # Gallery, lightbox, nav, contact modal
│   └── chatbot.js                  # AI chat widget (powered by /api/chat)
│
├── css/
│   └── styles.css                  # Single shared stylesheet (~2500 lines)
│
├── images/                         # Photos, logo, OG images
├── Videos/                         # Hero video assets
├── robots.txt
├── sitemap.xml
├── package.json                    # Node 20.x · stripe · @vercel/blob
├── vercel.json                     # Cron schedule (daily 14:00 UTC reminders)
└── README.md
```

---

## 🔧 Tech Stack

**Frontend** — Vanilla HTML5, CSS3, JavaScript. No framework, no build step, no bundler. Single shared `css/styles.css`. Brand fonts: Bebas Neue (display), Barlow / Barlow Condensed (UI), Source Serif 4 (accent). Brand colors: Navy `#1B2A6B`, Red `#C8102E`.

**Backend** — Node.js 20.x serverless functions on Vercel. Filesystem-based routing under `api/`.

**Database** — Supabase (Postgres) accessed directly over PostgREST HTTPS. No SDK. Tables: `bookings`, `customers`, `blackouts`, `waivers`.

**Payments** — Stripe (Checkout, payment intents, refunds, payment links, manual-capture damage holds, off-session charges for remaining balances).

**Email** — Resend for transactional (10+ templates: confirmations, reminders, cancellations, refunds, damage charges, waiver receipts, review requests). Mailchimp for newsletter list.

**AI** — Anthropic API for the on-site chatbot (`claude-sonnet-4-6`).

**Storage** — Vercel Blob (reserved for waiver attachments).

**Analytics** — Google Analytics (`G-5K59MVPLE6`).

---

## 🔌 Integrations & Environment Variables

Set in Vercel Project Settings → Environment Variables.

| Service | Env vars |
|---|---|
| Stripe | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` |
| Supabase | `SUPABASE_URL`, `SUPABASE_SECRET_KEY` |
| Resend | `RESEND_API_KEY` |
| Mailchimp | `MAILCHIMP_API_KEY`, `MAILCHIMP_AUDIENCE_ID` |
| Anthropic | `ANTHROPIC_API_KEY` |
| Vercel Cron | `CRON_SECRET` |
| Admin auth | `GOOGLE_CLIENT_ID`, `ADMIN_JWT_SECRET`, `ADMIN_WHITELIST`, `ADMIN_DISPLAY_NAMES` |
| Misc | `SITE_BASE_URL`, `GOOGLE_REVIEW_URL` |

---

## 👥 Team Workflow

**DJ** → Frontend design, content, photos, UI updates, customer-facing copy  
**Dane** → Booking platform, backend, payment integration

### Branch Strategy
- `main` — production, always live (auto-deploys to Vercel on push)
- `feature/your-feature-name` — work here, then merge to main

### Daily Workflow
```bash
# Start of day — get latest code
git pull origin main

# Create a branch for your work
git checkout -b feature/your-feature-name

# Make your changes, then save them
git add .
git commit -m "Description of what you changed"

# Push your branch
git push origin feature/your-feature-name

# When ready — merge to main
git checkout main
git merge feature/your-feature-name
git push origin main
```

---

## 🚀 Deployment

- **Hosting:** Vercel — auto-deploys on push to `main`
- **Domain:** texasforevercharters.com (with `www.` canonical)
- **Booking flow:** Custom 8-step wizard (`booking.html`) → Stripe Checkout
- **Admin:** `/admin.html` (password-gated, HMAC token auth, 7-day TTL)
- **Cron:** Daily 14:00 UTC reminder run (`/api/cron-reminders`, configured in `vercel.json`)

---

## 💰 Pricing Logic Quick Reference

Lives in `booking.html` (`getCharterBaseTotal`, `buildPriceBreakdown`) and mirrored in `admin.html` (`abComputePricing`).

- **Base rates** — Yacht: $250/$300/$350 (Mon-Thu/Fri-Sun/Sat). Pontoon: $100 weekday, $150 weekend.
- **Holiday surcharge** — +$100/hr on any day in the surrounding Fri-Mon bracket of a US federal holiday.
- **Long charter premium** — +$100/hr for 5+ hour charters.
- **Fee stack** — 5% admin fee → 8.5% sales tax → 2.9% credit-card processing.
- **Promo codes** — `LAKELIFE10`, `FOREVER10`, `TXF10` (10% off charter rate).
- **Damage deposit** — $250 refundable manual-capture hold authorized by the Stripe webhook.
- **Payment options** — 10% non-refundable deposit (balance due 14 days before) OR pay-in-full.

---

## 📞 Support

Questions about the codebase or deployments? Reach out in the team chat or open an issue.  
Questions from customers about charters? They'll come through the chatbot, the contact form, the booking flow, or `tx4evercharters@gmail.com`.
