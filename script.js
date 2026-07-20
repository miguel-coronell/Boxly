// ===================== Tailwind config =====================
tailwind.config = {
  theme: {
    extend: {
      colors: {
        deep: "#0E6B4F",
        dark: "#0A2622",
        accent: "#22C55E",
        soft: "#E9F8EE",
        ink: "#0B2B26",
        paper: "#F8FBF9",
        green: "#22C55E",
        greendark: "#15803D",
        lime: "#D7F205",
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

// ===================== Preloader =====================
(function () {
  const preloader = document.getElementById("preloader");
  if (!preloader) return;

  function hidePreloader() {
    document.body.classList.remove("is-loading");
    preloader.classList.add("is-hidden");
    setTimeout(() => preloader.remove(), 700);
  }

  if (prefersReducedMotion) {
    window.addEventListener("load", hidePreloader);
  } else {
    // Tiempo mínimo para que se vea la animación, sin bloquear de más.
    const minDelay = new Promise((resolve) => setTimeout(resolve, 1200));
    const pageLoaded = new Promise((resolve) => {
      if (document.readyState === "complete") resolve();
      else window.addEventListener("load", resolve);
    });
    Promise.all([minDelay, pageLoaded]).then(hidePreloader);
  }

  // Red de seguridad por si algo tarda de más.
  setTimeout(hidePreloader, 4000);
})();

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

  // ===================== Hero cursor glow + flow graphic parallax =====================
  const heroSection = document.getElementById("inicio");
  const heroGlow = document.getElementById("heroGlow");
  const flowGraphic = document.getElementById("flowGraphic");

  if (heroSection && !prefersReducedMotion && window.matchMedia("(pointer: fine)").matches) {
    heroSection.addEventListener("mousemove", (e) => {
      const rect = heroSection.getBoundingClientRect();
      const relX = (e.clientX - rect.left) / rect.width;
      const relY = (e.clientY - rect.top) / rect.height;
      if (heroGlow) {
        heroGlow.style.background = `radial-gradient(600px circle at ${relX * 100}% ${relY * 100}%, rgba(215,242,5,0.10), transparent 60%)`;
      }
      if (flowGraphic) {
        const moveX = (relX - 0.5) * 14;
        const moveY = (relY - 0.5) * 10;
        flowGraphic.style.transform = `translate(${moveX}px, ${moveY}px)`;
      }
    });
    heroSection.addEventListener("mouseleave", () => {
      if (flowGraphic) flowGraphic.style.transform = "translate(0, 0)";
    });
  }

  // ===================== Device switcher (Móvil / Tablet / PC) =====================
  const deviceTabs = document.querySelectorAll("[data-device-tab]");
  const deviceStage = document.getElementById("deviceStage");

  if (deviceTabs.length && deviceStage) {
    deviceTabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        const device = tab.getAttribute("data-device-tab");
        deviceTabs.forEach((t) => t.classList.remove("is-active"));
        tab.classList.add("is-active");
        deviceStage.setAttribute("data-active-device", device);
      });
    });
  }

  // ===================== Tilt-on-hover cards =====================
  const tiltEls = document.querySelectorAll("[data-tilt]");
  if (tiltEls.length && !prefersReducedMotion && window.matchMedia("(pointer: fine)").matches) {
    tiltEls.forEach((el) => {
      el.addEventListener("mousemove", (e) => {
        const rect = el.getBoundingClientRect();
        const relX = (e.clientX - rect.left) / rect.width - 0.5;
        const relY = (e.clientY - rect.top) / rect.height - 0.5;
        el.style.transform = `perspective(700px) rotateX(${relY * -6}deg) rotateY(${relX * 8}deg) translateY(-4px)`;
      });
      el.addEventListener("mouseleave", () => {
        el.style.transform = "";
      });
    });
  }

  // ===================== Boxly Virtual Assistant (chatbot) =====================
  const chatToggle = document.getElementById("chatToggle");
  const chatPanel = document.getElementById("chatPanel");
  const chatClose = document.getElementById("chatClose");
  const chatBody = document.getElementById("chatBody");
  const chatRestart = document.getElementById("chatRestart");
  const chatBadge = document.getElementById("chatBadge");

  if (chatToggle && chatPanel && chatBody) {
    const flows = {
      start: {
        bot: "¡Hola! Soy el asistente virtual de Boxly 👋 ¿En qué te puedo ayudar hoy?",
        options: [
          { label: "🧭 Elegir el mejor plan", next: "plan_q1" },
          { label: "⚙️ Conocer las funciones", next: "features" },
          { label: "🎥 Ver una demo", next: "demo" },
          { label: "💬 Hablar con soporte", next: "support" }
        ]
      },
      plan_q1: {
        bot: "Buenísimo. Para recomendarte el plan ideal: ¿cuántos productos manejás aproximadamente?",
        options: [
          { label: "Menos de 100", next: "plan_q2_small" },
          { label: "Entre 100 y 1000", next: "plan_q2_mid" },
          { label: "Más de 1000", next: "plan_q2_big" }
        ]
      },
      plan_q2_small: {
        bot: "Perfecto, ¿trabajás solo/a o con un equipo?",
        options: [
          { label: "Solo/a", next: "plan_result_mensual" },
          { label: "Con equipo", next: "plan_result_anual" }
        ]
      },
      plan_q2_mid: {
        bot: "Entendido. ¿Necesitás manejar más de un depósito o sucursal?",
        options: [
          { label: "Sí, varios depósitos", next: "plan_result_anual" },
          { label: "No, uno solo", next: "plan_result_mensual" }
        ]
      },
      plan_q2_big: {
        bot: "Con ese volumen, lo mejor es asegurar el acceso a largo plazo. ¿Preferís pagar una suscripción o una sola vez?",
        options: [
          { label: "Suscripción anual", next: "plan_result_anual" },
          { label: "Pago único", next: "plan_result_perpetua" }
        ]
      },
      plan_result_mensual: {
        bot: "Te recomiendo el plan <strong>Mensual (US$13/mes)</strong>: ideal para arrancar, con cotizaciones ilimitadas y panel de KPIs. Te llevo a verlo 👇",
        options: [
          { label: "Ver plan Mensual", action: "scroll:#precios" },
          { label: "🔁 Volver al inicio", next: "start" }
        ]
      },
      plan_result_anual: {
        bot: "Te recomiendo el plan <strong>Anual PRO (US$130/año)</strong>: múltiples rubros, soporte prioritario y 2 meses gratis. Te llevo a verlo 👇",
        options: [
          { label: "Ver plan Anual PRO", action: "scroll:#precios" },
          { label: "🔁 Volver al inicio", next: "start" }
        ]
      },
      plan_result_perpetua: {
        bot: "Te recomiendo la <strong>Licencia Perpetua (US$325 pago único)</strong>: acceso de por vida y todas las actualizaciones futuras incluidas. Te llevo a verla 👇",
        options: [
          { label: "Ver Licencia Perpetua", action: "scroll:#precios" },
          { label: "🔁 Volver al inicio", next: "start" }
        ]
      },
      features: {
        bot: "Boxly incluye control de stock en tiempo real, alertas automáticas, escáner de códigos, reportes y multi-depósito. ¿Qué querés ver primero?",
        options: [
          { label: "📦 Control de inventario", action: "scroll:#funciones" },
          { label: "📊 El panel / dashboard", action: "scroll:#beneficios" },
          { label: "🔁 Volver al inicio", next: "start" }
        ]
      },
      demo: {
        bot: "¡Genial! Podés probar Boxly gratis y sin tarjeta de crédito, o mirar el video de presentación arriba en la portada.",
        options: [
          { label: "🚀 Probar Demo Gratis", action: "scroll:#contacto" },
          { label: "🔁 Volver al inicio", next: "start" }
        ]
      },
      support: {
        bot: "Podés escribirnos y te respondemos a la brevedad, o dejarnos tus datos en el formulario de contacto.",
        options: [
          { label: "✉️ Ir al formulario de contacto", action: "scroll:#contacto" },
          { label: "🔁 Volver al inicio", next: "start" }
        ]
      }
    };

    function renderStep(stepKey) {
      const step = flows[stepKey];
      if (!step) return;

      const msgRow = document.createElement("div");
      msgRow.className = "chat-msg-bot";
      msgRow.innerHTML = `<span class="chat-avatar">B</span><p>${step.bot}</p>`;
      chatBody.appendChild(msgRow);

      const optionsWrap = document.createElement("div");
      optionsWrap.className = "chat-options";
      step.options.forEach((opt) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "chat-option-btn";
        btn.textContent = opt.label;
        btn.addEventListener("click", () => {
          const pickRow = document.createElement("div");
          pickRow.className = "chat-msg-user";
          pickRow.innerHTML = `<p>${opt.label}</p>`;
          chatBody.appendChild(pickRow);
          optionsWrap.querySelectorAll("button").forEach((b) => (b.disabled = true));

          if (opt.action && opt.action.startsWith("scroll:")) {
            const targetId = opt.action.replace("scroll:", "");
            setTimeout(() => {
              const target = document.querySelector(targetId);
              if (target) target.scrollIntoView({ behavior: prefersReducedMotion ? "auto" : "smooth", block: "start" });
              closeChat();
            }, 350);
          } else if (opt.next) {
            setTimeout(() => renderStep(opt.next), 300);
          }
          chatBody.scrollTop = chatBody.scrollHeight;
        });
        optionsWrap.appendChild(btn);
      });
      chatBody.appendChild(optionsWrap);
      chatBody.scrollTop = chatBody.scrollHeight;
    }

    let started = false;
    function openChat() {
      chatPanel.classList.add("is-open");
      chatToggle.setAttribute("aria-expanded", "true");
      if (chatBadge) chatBadge.classList.add("hidden");
      if (!started) {
        started = true;
        renderStep("start");
      }
    }
    function closeChat() {
      chatPanel.classList.remove("is-open");
      chatToggle.setAttribute("aria-expanded", "false");
    }

    chatToggle.addEventListener("click", () => {
      const isOpen = chatPanel.classList.contains("is-open");
      isOpen ? closeChat() : openChat();
    });
    if (chatClose) chatClose.addEventListener("click", closeChat);
    if (chatRestart) {
      chatRestart.addEventListener("click", () => {
        chatBody.innerHTML = "";
        renderStep("start");
      });
    }
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeChat();
    });
  }
});
