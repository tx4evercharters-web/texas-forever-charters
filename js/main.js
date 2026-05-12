/* ============================================================
   TEXAS FOREVER CHARTERS - Main JavaScript
   ============================================================ */

// ── Experience Contact Modal ──
function openContactModal(experience) {
  document.getElementById('expModalTitle').textContent = experience;
  const body = "Hi! I'm interested in the " + experience + " with Texas Forever Charters.";
  document.getElementById('expModalSms').href   = 'sms:+17373681669?body=' + encodeURIComponent(body);
  document.getElementById('expModalEmail').href = 'mailto:tx4evercharters@gmail.com?subject=' + encodeURIComponent('Inquiry: ' + experience) + '&body=' + encodeURIComponent(body);
  document.getElementById('expModal').classList.add('active');
  document.body.style.overflow = 'hidden';
}

function closeContactModal() {
  document.getElementById('expModal').classList.remove('active');
  document.body.style.overflow = '';
}

// ── Boat Gallery ──
const GALLERY_VESSEL_MAP = { carver: 'yacht', bentley: 'pontoon' };
const galleryData = {
  carver: {
    title: '1996 Carver Aft Cabin — Photo Gallery',
    images: [
      { src: 'images/salon.jpg',       alt: 'Salon interior' },
      { src: 'images/guestbed.jpg',    alt: 'Guest bedroom' },
      { src: 'images/kitchenette.jpg', alt: 'Kitchenette' },
      { src: 'images/aftdeck.jpg',     alt: 'Aft deck' },
      { src: 'images/aftdeck2.jpg',    alt: 'Aft deck view' },
      { src: 'images/stern1.jpg',      alt: 'Stern' },
      { src: 'images/stern2.jpg',      alt: 'Stern view' },
    ]
  },
  bentley: {
    title: '24ft Bentley Navigator — Photo Gallery',
    images: [
      { src: 'images/bentley-main-photo.jpeg', alt: 'Bentley Navigator pontoon' },
      { src: 'images/bentley.jpeg',            alt: 'Bentley Navigator on Lake Travis' },
      { src: 'images/bentley2.jpeg',           alt: 'Bentley Navigator' },
      { src: 'images/bentley-drone.jpeg',      alt: 'Bentley Navigator aerial view' },
    ]
  }
};

let currentLightboxImages = [];
let currentLightboxIndex = 0;
let currentGalleryBoat = null;

function openGallery(id) {
  const data = galleryData[id];
  if (!data) return;
  currentGalleryBoat = id;
  document.getElementById('galleryTitle').textContent = data.title;
  const grid = document.getElementById('galleryGrid');
  grid.innerHTML = '';
  data.images.forEach((img, i) => {
    const el = document.createElement('img');
    el.src = img.src;
    el.alt = img.alt;
    el.onclick = () => openLightbox(data.images, i);
    grid.appendChild(el);
  });
  document.getElementById('boatGallery').classList.add('active');
  document.body.style.overflow = 'hidden';
}

function closeGallery() {
  document.getElementById('boatGallery').classList.remove('active');
  closeLightbox();
  document.body.style.overflow = '';
}

function openLightbox(images, index) {
  currentLightboxImages = images;
  currentLightboxIndex = index;
  const img = document.getElementById('lightboxImg');
  img.src = images[index].src;
  img.alt = images[index].alt;
  document.getElementById('galleryLightbox').classList.add('active');
}

function closeLightbox() {
  document.getElementById('galleryLightbox').classList.remove('active');
}

function lightboxNav(dir) {
  currentLightboxIndex = (currentLightboxIndex + dir + currentLightboxImages.length) % currentLightboxImages.length;
  const img = document.getElementById('lightboxImg');
  img.src = currentLightboxImages[currentLightboxIndex].src;
  img.alt = currentLightboxImages[currentLightboxIndex].alt;
}

function bookCurrentBoat() {
  const vessel = GALLERY_VESSEL_MAP[currentGalleryBoat];
  if (!vessel) return;
  window.location.href = 'booking.html?vessel=' + vessel;
}

document.addEventListener('keydown', e => {
  const lightbox = document.getElementById('galleryLightbox');
  const modal = document.getElementById('boatGallery');
  const expModal = document.getElementById('expModal');
  const nlPopup = document.getElementById('nlPopup');
  if (e.key === 'Escape') {
    if (lightbox && lightbox.classList.contains('active')) closeLightbox();
    else if (modal && modal.classList.contains('active')) closeGallery();
    else if (expModal && expModal.classList.contains('active')) closeContactModal();
    else if (nlPopup && nlPopup.classList.contains('active')) closeNewsletterPopup();
  }
  if (lightbox && lightbox.classList.contains('active')) {
    if (e.key === 'ArrowLeft')  lightboxNav(-1);
    if (e.key === 'ArrowRight') lightboxNav(1);
  }
});

// ── Sticky Nav on Scroll ──
window.addEventListener('scroll', () => {
  const nav = document.getElementById('mainNav');
  if (nav) {
    nav.classList.toggle('scrolled', window.scrollY > 60);
  }
});

// ── Newsletter Subscription ──
async function callSubscribeApi(email) {
  const res = await fetch('/api/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  const data = await res.json();
  return res.ok && data.success;
}

function showEmailError(input, placeholder) {
  input.style.outline = '2px solid #C8102E';
  input.placeholder = placeholder;
  setTimeout(() => {
    input.style.outline = '';
    input.placeholder = 'Your email address';
  }, 2500);
}

// ── Bottom newsletter section ──
async function handleSubscribe() {
  const input = document.getElementById('emailInput');
  const email = input.value.trim();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showEmailError(input, 'Please enter a valid email');
    return;
  }

  const btn = document.querySelector('#nlForm .nl-btn');
  if (btn) { btn.textContent = 'Subscribing...'; btn.disabled = true; }

  const ok = await callSubscribeApi(email);

  if (ok) {
    tfcMarkSignedUp();
    document.getElementById('nlForm').style.display = 'none';
    document.getElementById('nlSuccess').style.display = 'block';
  } else {
    if (btn) { btn.textContent = 'Get On The List'; btn.disabled = false; }
    showEmailError(input, 'Something went wrong — try again');
  }
}

// ── Newsletter popup ──
// Exit-intent + engagement-based trigger logic lives below. The historic
// `showNewsletterPopup()` (3-second auto-show) is removed — its job is
// now done by the exit-intent path on desktop and the scroll+time path
// on mobile, both gated by tfcShouldShowPopup() suppression.

// Allowlisted pages where the popup may appear. Booking flow + admin +
// post-conversion pages are intentionally excluded so we don't pester
// people mid-checkout or after they've already converted.
const TFC_EXIT_POPUP_ALLOWED_PAGES = new Set([
  '/index.html',
  '/austin-texas-boat-rentals.html',
  '/lake-travis-boat-rentals.html',
  '/lake-travis-family-boat-tours.html',
  '/lake-travis-sunset-cruises.html',
  '/private-party-boat-austin.html',
  '/discounts.html',
]);
const TFC_EXIT_MIN_AGE_MS         = 10 * 1000;
const TFC_EXIT_MOBILE_TIME_MS     = 60 * 1000;
const TFC_EXIT_MOBILE_SCROLL_PCT  = 0.70;
const TFC_EXIT_DISMISS_TTL_MS     = 30 * 24 * 60 * 60 * 1000;
const TFC_EXIT_MOBILE_BREAKPOINT  = 768;
const TFC_EXIT_SCROLL_THROTTLE_MS = 200;

function tfcIsAllowedPopupPage() {
  let path = (location.pathname || '/').toLowerCase();
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  if (path === '' || path === '/') path = '/index.html';
  if (!path.endsWith('.html')) path = path + '.html';
  return TFC_EXIT_POPUP_ALLOWED_PAGES.has(path);
}

// Dual-flag readers (new + legacy back-compat — booking.html reads
// nl_subscribed to auto-apply LAKELIFE10, so we must keep setting it).
function tfcUserSignedUp() {
  try {
    return localStorage.getItem('nl_subscribed') === '1'
        || localStorage.getItem('tfc_newsletter_signed_up') === 'true';
  } catch (_) { return false; }
}
function tfcUserDismissed() {
  try {
    if (localStorage.getItem('nl_dismissed') === '1') return true;
    const until = parseInt(localStorage.getItem('tfc_exit_popup_dismissed_until') || '0', 10);
    return Number.isFinite(until) && until > Date.now();
  } catch (_) { return false; }
}
function tfcSessionAlreadyShown() {
  try { return sessionStorage.getItem('tfc_exit_popup_shown') === 'true'; }
  catch (_) { return false; }
}

// Returns true when another blocking surface is already on screen, so
// we don't stack the popup on top of a lightbox / gallery / menu.
function tfcOtherUIOpen() {
  const blockers = ['galleryLightbox', 'boatGallery', 'expModal'];
  for (const id of blockers) {
    const el = document.getElementById(id);
    if (el && el.classList.contains('active')) return true;
  }
  const nlPopup = document.getElementById('nlPopup');
  if (nlPopup && nlPopup.classList.contains('active')) return true;
  const navLinks = document.querySelector('.nav-links');
  if (navLinks && navLinks.classList.contains('active')) return true;
  return false;
}

const TFC_PAGE_LOAD_TIME = Date.now();
function tfcShouldShowPopup() {
  if (!tfcIsAllowedPopupPage()) return false;
  if (Date.now() - TFC_PAGE_LOAD_TIME < TFC_EXIT_MIN_AGE_MS) return false;
  if (tfcUserSignedUp()) return false;
  if (tfcUserDismissed()) return false;
  if (tfcSessionAlreadyShown()) return false;
  if (tfcOtherUIOpen()) return false;
  return true;
}

// Mark the session "shown" the moment we fire so a fast second trigger
// (e.g. mouseleave fires twice) doesn't try to re-open.
function tfcMarkShown() {
  try { sessionStorage.setItem('tfc_exit_popup_shown', 'true'); } catch (_) {}
}

// Persist signup state to BOTH the new flag (for fresh suppression
// checks) and the legacy nl_subscribed flag (which booking.html still
// reads to auto-apply the LAKELIFE10 code on returning visitors).
function tfcMarkSignedUp() {
  try {
    localStorage.setItem('nl_subscribed', '1');
    localStorage.setItem('tfc_newsletter_signed_up', 'true');
    sessionStorage.setItem('tfc_exit_popup_shown', 'true');
  } catch (_) {}
}

// Persist dismissal to BOTH the new 30-day TTL flag and the legacy
// permanent nl_dismissed flag (so users who already dismissed before
// this change stay un-pestered).
function tfcMarkDismissed() {
  try {
    localStorage.setItem('nl_dismissed', '1');
    localStorage.setItem('tfc_exit_popup_dismissed_until',
      String(Date.now() + TFC_EXIT_DISMISS_TTL_MS));
    sessionStorage.setItem('tfc_exit_popup_shown', 'true');
  } catch (_) {}
}

// Popup HTML for pages that don't have it inline. Kept in sync with
// the markup in index.html — both render the same X button, subhead,
// form, and success state. Single source of truth for trigger logic
// in this file; two sources for markup (acceptable trade — see top
// comment on this section).
function tfcBuildPopupHTML() {
  return ''
    + '<div id="nlPopup" class="nl-popup-overlay" role="dialog" aria-modal="true" aria-label="Newsletter signup">'
    +   '<div class="nl-popup-box" style="position:relative;">'
    +     '<button id="nlPopupX" aria-label="Close" onclick="closeNewsletterPopup()" style="position:absolute;top:10px;right:12px;width:34px;height:34px;border:none;background:rgba(255,255,255,0.08);color:rgba(255,255,255,0.85);font-size:20px;line-height:1;border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;z-index:2;">✕</button>'
    +     '<div class="nl-popup-anchor">⚓</div>'
    +     '<h2 class="nl-popup-title">Get 10% Off<br><span class="nl-popup-red">Your Charter Rate</span></h2>'
    +     '<p class="nl-popup-desc">Join our insider list for your LAKELIFE10 code plus future deals.</p>'
    +     '<div class="nl-popup-form" id="nlPopupForm">'
    +       '<input class="nl-popup-input" type="email" id="nlPopupEmail" placeholder="Your email address" aria-label="Email address">'
    +       '<button class="nl-popup-btn" id="nlPopupBtn" onclick="handlePopupSubscribe()">Claim My Discount</button>'
    +     '</div>'
    +     '<div class="nl-success" id="nlPopupSuccess">'
    +       '<div class="nl-success-title">⚓ You\'re on the crew list.</div>'
    +       '<div class="nl-success-sub">Use this code at checkout for 10% off your charter rate:</div>'
    +       '<div style="font-family:\'Bebas Neue\',sans-serif;font-size:32px;color:#C8102E;letter-spacing:4px;margin:12px 0;">LAKELIFE10</div>'
    +       '<div class="nl-success-sub">Check your email (including Promotions &amp; Spam tabs) — we sent it there too.</div>'
    +     '</div>'
    +     '<button class="nl-popup-nothanks" id="nlPopupClose" onclick="closeNewsletterPopup()">No thanks</button>'
    +   '</div>'
    + '</div>';
}

function tfcEnsurePopupInDOM() {
  if (document.getElementById('nlPopup')) return;
  document.body.insertAdjacentHTML('beforeend', tfcBuildPopupHTML());
  // Wire up the listeners that index.html's inline DOMContentLoaded
  // handler attaches to the same elements. Backdrop-click, Enter key.
  const popup = document.getElementById('nlPopup');
  if (popup) {
    popup.addEventListener('click', e => { if (e.target === popup) closeNewsletterPopup(); });
  }
  const emailInput = document.getElementById('nlPopupEmail');
  if (emailInput) {
    emailInput.addEventListener('keydown', e => { if (e.key === 'Enter') handlePopupSubscribe(); });
  }
}

// The single entry point that anything (mouseleave, scroll+time
// engagement, future triggers) calls to actually show the popup.
function tfcMaybeFirePopup() {
  if (!tfcShouldShowPopup()) return;
  tfcEnsurePopupInDOM();
  const popup = document.getElementById('nlPopup');
  if (!popup) return;
  tfcMarkShown();
  popup.classList.add('active');
  document.body.style.overflow = 'hidden';
}

// Kept for any external/legacy callers but now respects the full
// suppression chain instead of just the two legacy flags.
function showNewsletterPopup() { tfcMaybeFirePopup(); }

function closeNewsletterPopup() {
  const popup = document.getElementById('nlPopup');
  if (popup) popup.classList.remove('active');
  document.body.style.overflow = '';
  tfcMarkDismissed();
}

async function handlePopupSubscribe() {
  const input = document.getElementById('nlPopupEmail');
  const email = input.value.trim();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showEmailError(input, 'Please enter a valid email');
    return;
  }

  const btn = document.getElementById('nlPopupBtn');
  btn.textContent = 'Subscribing...';
  btn.disabled = true;

  const ok = await callSubscribeApi(email);

  if (ok) {
    tfcMarkSignedUp();
    document.getElementById('nlPopupForm').style.display = 'none';
    document.getElementById('nlPopupSuccess').style.display = 'block';
  } else {
    btn.textContent = 'Claim My Discount';
    btn.disabled = false;
    showEmailError(input, 'Something went wrong — try again');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const emailInput = document.getElementById('emailInput');
  if (emailInput) {
    emailInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') handleSubscribe();
    });
  }

  /* ── Newsletter popup wiring ───────────────────────────────────
     Auto-fire trigger logic depends on viewport: desktop watches
     mouseleave to the top of the viewport (true exit-intent toward
     URL bar / tabs); mobile waits for 60s on page AND 70% scroll
     depth (no reliable cursor). Both are gated by the suppression
     chain in tfcShouldShowPopup() — 10-second floor, signed-up
     check, dismiss-in-last-30d check, session-already-shown,
     and other-UI-open. */
  const popupClose = document.getElementById('nlPopupClose');
  if (popupClose) popupClose.addEventListener('click', closeNewsletterPopup);

  const nlPopup = document.getElementById('nlPopup');
  if (nlPopup) {
    nlPopup.addEventListener('click', e => {
      if (e.target === nlPopup) closeNewsletterPopup();
    });
  }

  const nlPopupEmail = document.getElementById('nlPopupEmail');
  if (nlPopupEmail) {
    nlPopupEmail.addEventListener('keydown', e => {
      if (e.key === 'Enter') handlePopupSubscribe();
    });
  }

  /* Only register triggers on allowlisted pages. On booking.html,
     admin.html, etc. we never even attach the listeners. */
  if (tfcIsAllowedPopupPage()) {
    const isMobile = window.innerWidth <= TFC_EXIT_MOBILE_BREAKPOINT;

    if (isMobile) {
      /* Mobile path — engagement-based. Two thresholds must BOTH
         be crossed before the popup fires: ≥60s on page AND scroll
         depth ≥70%. Scroll listener is passive + throttled. */
      let mobileTimeReached = false;
      let maxScrollPct      = 0;
      let scrollPending     = false;

      function mobileCheck() {
        if (mobileTimeReached && maxScrollPct >= TFC_EXIT_MOBILE_SCROLL_PCT) {
          tfcMaybeFirePopup();
        }
      }

      setTimeout(() => {
        mobileTimeReached = true;
        mobileCheck();
      }, TFC_EXIT_MOBILE_TIME_MS);

      window.addEventListener('scroll', () => {
        if (scrollPending) return;
        scrollPending = true;
        setTimeout(() => {
          scrollPending = false;
          const docHeight = document.documentElement.scrollHeight - window.innerHeight;
          if (docHeight <= 0) return;
          const pct = Math.min(1, Math.max(0, window.scrollY / docHeight));
          if (pct > maxScrollPct) maxScrollPct = pct;
          mobileCheck();
        }, TFC_EXIT_SCROLL_THROTTLE_MS);
      }, { passive: true });

    } else {
      /* Desktop path — true exit-intent. mouseleave fires when the
         cursor crosses any edge of the document; we filter to
         clientY < 0 so only "upward exit" (toward URL bar / tabs /
         close-tab button) counts. The shared suppression chain
         handles the rest. */
      document.documentElement.addEventListener('mouseleave', (e) => {
        if (e.clientY <= 0) tfcMaybeFirePopup();
      });
    }
  }

  // ── FAQ Accordion ──
  function toggleFaq(btn) {
    const item = btn.parentElement;
    const isOpen = item.classList.contains('open');
    document.querySelectorAll('.faq-item.open').forEach(i => i.classList.remove('open'));
    if (!isOpen) item.classList.add('open');
  }

  // Expose toggleFaq globally for inline onclick
  window.toggleFaq = toggleFaq;

  // ── Mobile Navigation Toggle ──
  const navToggle = document.querySelector('.nav-toggle');
  const navLinks = document.querySelector('.nav-links');

  if (navToggle && navLinks) {
    /* Centralized open/close so toggle, nav links, outside taps, and
       Escape all converge on one place. No body scroll lock — the
       menu is a 220px dropdown anchored to the nav, not a full-screen
       sheet, so locking page scroll would feel wrong. */
    function closeNavMenu() {
      if (!navLinks.classList.contains('active')) return;
      navLinks.classList.remove('active');
      navToggle.classList.remove('active');
      navToggle.setAttribute('aria-expanded', 'false');
    }
    function openNavMenu() {
      navLinks.classList.add('active');
      navToggle.classList.add('active');
      navToggle.setAttribute('aria-expanded', 'true');
    }

    navToggle.addEventListener('click', (e) => {
      /* Stop propagation so the same click doesn't bubble to the
         document outside-tap listener below and immediately reverse
         what we just toggled. */
      e.stopPropagation();
      if (navLinks.classList.contains('active')) closeNavMenu();
      else openNavMenu();
    });

    navLinks.querySelectorAll('a').forEach(link => {
      link.addEventListener('click', closeNavMenu);
    });

    /* Outside-tap close — any click that isn't on the toggle and
       isn't inside the menu dismisses it. Registered once globally
       since the menu shares a single instance per page. Skips when
       menu is already closed (fast no-op). */
    document.addEventListener('click', (e) => {
      if (!navLinks.classList.contains('active')) return;
      if (navToggle.contains(e.target)) return; // handled by toggle's own listener
      if (navLinks.contains(e.target))  return; // taps inside the menu shouldn't close (links handle their own close)
      closeNavMenu();
    });

    /* Escape closes the menu (desktop keyboard users + screen readers). */
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && navLinks.classList.contains('active')) {
        closeNavMenu();
      }
    });
  }

  // ── Desktop "Call Now" tooltip ──
  // On phones the tel: link works fine, but on desktop browsers it pops the
  // OS app picker — annoying when the user just wants to see the number.
  // Suppress the navigation on wide viewports and toggle a tooltip instead.
  const callBtn = document.querySelector('.nav-call');
  const callWrap = callBtn && callBtn.closest('.nav-call-wrap');
  if (callBtn && callWrap) {
    callBtn.addEventListener('click', (e) => {
      if (window.matchMedia('(min-width: 769px)').matches) {
        e.preventDefault();
        const open = callWrap.classList.toggle('show-tip');
        clearTimeout(callWrap._tipTimer);
        if (open) {
          callWrap._tipTimer = setTimeout(() => callWrap.classList.remove('show-tip'), 5000);
        }
      }
    });
    document.addEventListener('click', (e) => {
      if (!callWrap.contains(e.target)) callWrap.classList.remove('show-tip');
    });
  }

  // ── Mobile hamburger Contact submenu ──
  const contactItem = document.querySelector('.nav-contact-item');
  const contactToggle = contactItem && contactItem.querySelector('.nav-contact-toggle');
  if (contactItem && contactToggle) {
    contactToggle.addEventListener('click', () => {
      const open = contactItem.classList.toggle('open');
      contactToggle.setAttribute('aria-expanded', String(open));
    });
  }

  // ── Trust Bar Ticker ──
  const trustBar = document.querySelector('.trust-bar');
  if (trustBar) {
    const extraItems = [
      { icon: '🎬', text: 'ADD-ON: Drone Footage — $200' },
      { icon: '🏖️', text: 'ADD-ON: Towels — $8' },
      { icon: '🧊', text: 'ADD-ON: Ice — $25' },
      { icon: '💧', text: 'ADD-ON: Water Bottles — $25' },
    ];
    extraItems.forEach(({ icon, text }) => {
      const div = document.createElement('div');
      div.className = 'trust-item';
      div.innerHTML = `<span class='trust-icon'>${icon}</span>${text}`;
      trustBar.appendChild(div);
    });
    const items = Array.from(trustBar.querySelectorAll('.trust-item'));
    const track = document.createElement('div');
    track.className = 'trust-track';
    items.forEach(item => track.appendChild(item));
    items.forEach(item => track.appendChild(item.cloneNode(true)));
    trustBar.appendChild(track);
  }

  // ── Scroll Reveal ──
  const observer = new IntersectionObserver(entries => {
    entries.forEach(el => {
      if (el.isIntersecting) {
        el.target.style.opacity = '1';
        el.target.style.transform = 'translateY(0)';
      }
    });
  }, { threshold: 0.08 });

  document.querySelectorAll(
    '.exp-card, .fleet-card, .interior-img, .crew-card, .review-card'
  ).forEach(el => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(22px)';
    el.style.transition = 'opacity 0.55s ease, transform 0.55s ease';
    observer.observe(el);
  });
});
