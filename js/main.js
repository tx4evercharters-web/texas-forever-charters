/* ============================================================
   TEXAS FOREVER CHARTERS - Main JavaScript
   ============================================================ */

// ── Experience Contact Modal ──
const expModalMessages = {
  'Sunset Cruise':    "Hi! I'm interested in booking the Sunset Cruise experience with Texas Forever Charters.",
  'Private Party':    "Hi! I'm interested in booking the Private Party experience with Texas Forever Charters.",
  'Full Day Charter': "Hi! I'm interested in booking the Full Day Charter experience with Texas Forever Charters.",
  'Family & Fun':     "Hi! I'm interested in booking the Family & Fun experience with Texas Forever Charters.",
  'Boat Tours':       "Hi! I'm interested in booking a Boat Tour with Texas Forever Charters."
};

function openExpModal(experience) {
  document.getElementById('expModalTitle').textContent = experience;
  const msg = encodeURIComponent(expModalMessages[experience] || `Hi! I'm interested in booking the ${experience} experience with Texas Forever Charters.`);
  document.getElementById('expModalSms').href = `sms:+17373681669?body=${msg}`;
  document.getElementById('expModal').classList.add('active');
  document.body.style.overflow = 'hidden';
}

function closeExpModal() {
  document.getElementById('expModal').classList.remove('active');
  document.body.style.overflow = '';
}

// ── Boat Gallery ──
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

function openGallery(id) {
  const data = galleryData[id];
  if (!data) return;
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

document.addEventListener('keydown', e => {
  const lightbox = document.getElementById('galleryLightbox');
  const modal = document.getElementById('boatGallery');
  const expModal = document.getElementById('expModal');
  if (e.key === 'Escape') {
    if (lightbox && lightbox.classList.contains('active')) closeLightbox();
    else if (modal && modal.classList.contains('active')) closeGallery();
    else if (expModal && expModal.classList.contains('active')) closeExpModal();
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

// ── Newsletter Form ──
function handleSubscribe() {
  const input = document.getElementById('emailInput');
  const email = input.value.trim();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    input.style.outline = '2px solid #C8102E';
    input.placeholder = 'Please enter a valid email';
    setTimeout(() => {
      input.style.outline = '';
      input.placeholder = 'Your email address';
    }, 2500);
    return;
  }

  document.getElementById('nlForm').style.display = 'none';
  document.getElementById('nlSuccess').style.display = 'block';
}

document.addEventListener('DOMContentLoaded', () => {
  const emailInput = document.getElementById('emailInput');
  if (emailInput) {
    emailInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') handleSubscribe();
    });
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
    navToggle.addEventListener('click', () => {
      const isOpen = navLinks.classList.toggle('active');
      navToggle.classList.toggle('active', isOpen);
      navToggle.setAttribute('aria-expanded', String(isOpen));
    });

    navLinks.querySelectorAll('a').forEach(link => {
      link.addEventListener('click', () => {
        if (navLinks.classList.contains('active')) {
          navLinks.classList.remove('active');
          navToggle.classList.remove('active');
          navToggle.setAttribute('aria-expanded', 'false');
        }
      });
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
