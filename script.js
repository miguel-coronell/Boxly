// ===================== Tailwind config =====================
tailwind.config = {
  theme: {
    extend: {
      colors: {
        deep: "#1D4E89",
        dark: "#0F2C4C",
        accent: "#3B82F6",
        soft: "#EAF2FB",
        ink: "#0F172A",
        paper: "#F8FAFC",
        green: "#0FA76F",
        greendark: "#0B7F55",
        kraft: "#B98A5E"
      },
      fontFamily: {
        sans: ['"Plus Jakarta Sans"', "ui-sans-serif", "system-ui", "sans-serif"],
        display: ['"Plus Jakarta Sans"', "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ['"IBM Plex Mono"', "ui-monospace", "monospace"]
      }
    }
  }
};

// ===================== Lucide icons =====================
lucide.createIcons();

const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

document.addEventListener("DOMContentLoaded", () => {
  // ===================== Mobile menu =====================
  const menuToggle = document.getElementById("menuToggle");
  const mobileClose = document.getElementById("mobileClose");
  const mobilePanel = document.getElementById("mobilePanel");
  const mobileBackdrop = document.getElementById("mobileBackdrop");
  const iconMenu = document.getElementById("iconMenu");
  const iconClose = document.getElementById("iconClose");
  const mobileLinks = document.querySelectorAll(".mobile-link");

  function openMenu() {
    mobilePanel.classList.add("is-open");
    mobileBackdrop.classList.add("is-open");
    document.body.classList.add("menu-open");
    menuToggle.setAttribute("aria-expanded", "true");
    iconMenu.classList.add("hidden");
    iconClose.classList.remove("hidden");
  }

  function closeMenu() {
    mobilePanel.classList.remove("is-open");
    mobileBackdrop.classList.remove("is-open");
    document.body.classList.remove("menu-open");
    menuToggle.setAttribute("aria-expanded", "false");
    iconMenu.classList.remove("hidden");
    iconClose.classList.add("hidden");
  }

  menuToggle.addEventListener("click", () => {
    const isOpen = mobilePanel.classList.contains("is-open");
    isOpen ? closeMenu() : openMenu();
  });

  mobileClose.addEventListener("click", closeMenu);
  mobileBackdrop.addEventListener("click", closeMenu);
  mobileLinks.forEach((link) => link.addEventListener("click", closeMenu));

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeMenu();
  });

  // ===================== Sticky header shadow on scroll =====================
  const header = document.getElementById("siteHeader");
  function handleHeaderScroll() {
    if (window.scrollY > 12) {
      header.classList.add("scrolled");
    } else {
      header.classList.remove("scrolled");
    }
  }
  handleHeaderScroll();
  window.addEventListener("scroll", handleHeaderScroll, { passive: true });

  // ===================== Scroll reveal =====================
  const revealEls = document.querySelectorAll("[data-reveal]");

  if (prefersReducedMotion) {
    revealEls.forEach((el) => el.classList.add("in-view"));
  } else {
    const revealObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("in-view");
            revealObserver.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.15, rootMargin: "0px 0px -60px 0px" }
    );
    revealEls.forEach((el) => revealObserver.observe(el));
  }

  // ===================== Scrollspy nav =====================
  const navLinks = document.querySelectorAll("[data-nav]");
  const sections = Array.from(navLinks)
    .map((link) => document.querySelector(link.getAttribute("href")))
    .filter(Boolean);

  function setActiveLink(id) {
    navLinks.forEach((link) => {
      link.classList.toggle("is-active", link.getAttribute("href") === `#${id}`);
    });
  }

  if (sections.length) {
    const sectionObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setActiveLink(entry.target.id);
          }
        });
      },
      { rootMargin: "-45% 0px -50% 0px", threshold: 0 }
    );
    sections.forEach((section) => sectionObserver.observe(section));
  }

  // ===================== Count-up stats =====================
  const counters = document.querySelectorAll("[data-count-to]");

  function animateCount(el) {
    const target = parseInt(el.getAttribute("data-count-to"), 10) || 0;
    const duration = 1400;
    const start = performance.now();

    function tick(now) {
      const progress = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      const value = Math.round(eased * target);
      el.textContent = value.toLocaleString("es-AR");
      if (progress < 1) {
        requestAnimationFrame(tick);
      } else {
        el.textContent = target.toLocaleString("es-AR");
      }
    }

    if (prefersReducedMotion) {
      el.textContent = target.toLocaleString("es-AR");
    } else {
      requestAnimationFrame(tick);
    }
  }

  if (counters.length) {
    const countObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            animateCount(entry.target);
            countObserver.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.4 }
    );
    counters.forEach((el) => countObserver.observe(el));
  }

  // ===================== Mascot mouse parallax =====================
  const heroSection = document.getElementById("inicio");
  const mascot = document.getElementById("mascotParallax");

  if (heroSection && mascot && !prefersReducedMotion && window.matchMedia("(pointer: fine)").matches) {
    heroSection.addEventListener("mousemove", (e) => {
      const rect = heroSection.getBoundingClientRect();
      const relX = (e.clientX - rect.left) / rect.width - 0.5;
      const relY = (e.clientY - rect.top) / rect.height - 0.5;
      const moveX = relX * 16;
      const moveY = relY * 12;
      mascot.style.transform = `translate(${moveX}px, ${moveY}px)`;
    });

    heroSection.addEventListener("mouseleave", () => {
      mascot.style.transform = "translate(0, 0)";
    });
  }
});
