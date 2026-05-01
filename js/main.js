/* ============================================================
   TEXAS FOREVER CHARTERS - Main JavaScript
   ============================================================ */

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

  // ── Arrow Pierce ──
  const btnWrapper = document.querySelector('.btn-arrow-wrapper');
  if (btnWrapper) {
    const arrow = document.createElement('span');
    arrow.className = 'arrow-pierce';
    arrow.textContent = '➤';
    btnWrapper.appendChild(arrow);
  }

  // ── Trust Bar Ticker ──
  const trustBar = document.querySelector('.trust-bar');
  if (trustBar) {
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
