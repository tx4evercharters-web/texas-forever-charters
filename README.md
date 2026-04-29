# Texas Forever Charters

Official website for **Texas Forever Charters** — Austin's premier captained boat charter experience on Lake Travis.

## 🛥️ About

Texas Forever Charters offers fully captained boat charters on Lake Travis, Austin TX. Based at Hudson Bend Marina, we operate a 1996 Carver Aft Cabin (up to 20 guests) and a 24ft Bentley Navigator Pontoon (up to 13 guests).

**Captains:** DJ (The Lake Cowboy) & Dane  
**Phone:** (737) 368-1669  
**Email:** tx4evercharters@gmail.com  
**Location:** Hudson Bend Marina, Lake Travis, Austin TX

---

## 🗂️ Project Structure

```
texas-forever-charters/
├── index.html          # Main HTML - structure only
├── css/
│   └── styles.css      # All styling
├── js/
│   └── main.js         # All JavaScript
├── images/             # All photos and logo
│   ├── New_Tx4Ever_Logo.png
│   ├── hero.jpeg
│   ├── dj.jpeg
│   ├── dane.jpeg
│   └── ... (all other images)
└── README.md
```

---

## 👥 Team Workflow

**DJ** → Frontend design, content, photos, UI updates  
**Dane** → Booking platform, backend, payment integration

### Branch Strategy
- `main` — production, always live
- `feature/your-feature-name` — work here, then merge to main

### Daily Workflow
```bash
# Start of day - get latest code
git pull origin main

# Create a branch for your work
git checkout -b feature/your-feature-name

# Make your changes, then save them
git add .
git commit -m "Description of what you changed"

# Push your branch
git push origin feature/your-feature-name

# When ready - merge to main
git checkout main
git merge feature/your-feature-name
git push origin main
```

---

## 🚀 Deployment

- **Hosting:** Vercel (auto-deploys on push to main)
- **Domain:** texasforevercharters.com
- **Booking:** FareHarbor

---

## 🔧 Tech Stack

- HTML5
- CSS3 (no frameworks)
- Vanilla JavaScript
- Google Fonts (Bebas Neue, Barlow, Source Serif 4)
