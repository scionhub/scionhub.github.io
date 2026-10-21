/* Minimal interactivity (no dependencies) */
(function () {
  const year = document.getElementById('year');
  if (year) year.textContent = String(new Date().getFullYear());

  const toggle = document.querySelector('.nav-toggle');
  const nav = document.getElementById('site-nav');
  if (toggle && nav) {
    const setOpen = (open) => {
      toggle.setAttribute('aria-expanded', String(open));
      nav.classList.toggle('open', open);
      nav.setAttribute('aria-hidden', String(!open));
    };
    setOpen(false);
    toggle.addEventListener('click', () => {
      const nowOpen = toggle.getAttribute('aria-expanded') !== 'true';
      setOpen(nowOpen);
    });
    // Close on escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') setOpen(false);
    });
    // Close when clicking outside
    document.addEventListener('click', (e) => {
      if (!nav.contains(e.target) && !toggle.contains(e.target)) setOpen(false);
    });
  }
})();

