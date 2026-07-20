/* =========================================================================
   BOXLY — Panel de control
   Estado persistido en localStorage. Sin backend: todo corre en el navegador.
   (ver firebase-config.js / login.html para la integración de autenticación)
   ========================================================================= */

const STORAGE_KEY = "boxly_app_data_v1";
const AUTH_KEY = "boxly_auth_user";
const NEW_USER_FLAG = "boxly_new_user";
const TOUR_DONE_FLAG = "boxly_onboarding_done";

/* ---------------------------- Autenticación (guard) ----------------------------
   Si no hay sesión iniciada, se redirige a login.html. Cuando integres Firebase,
   reemplazá esta verificación por el listener real: firebase.auth().onAuthStateChanged(). */
function getAuthUser() {
  try {
    const raw = localStorage.getItem(AUTH_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    return null;
  }
}

const CURRENT_USER = getAuthUser();
if (!CURRENT_USER) {
  window.location.replace("login.html");
}
const CATEGORY_COLORS = ["#0E6B4F", "#22C55E", "#15803D", "#D7F205", "#B98A5E", "#94A3B8"];

/* Mapea el valor en español del <select> de estado (inventario) al estado interno
   devuelto por productStatus() ("ok" | "low" | "critical"). Este mapeo es lo que
   faltaba y provocaba que solo funcionara el filtro "OK". */
const STATUS_FILTER_MAP = { ok: "ok", bajo: "low", critico: "critical" };

const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ---------------------------- Preloader ---------------------------- */
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
    const minDelay = new Promise((resolve) => setTimeout(resolve, 900));
    const pageLoaded = new Promise((resolve) => {
      if (document.readyState === "complete") resolve();
      else window.addEventListener("load", resolve);
    });
    Promise.all([minDelay, pageLoaded]).then(hidePreloader);
  }

  setTimeout(hidePreloader, 4000);
})();

/* ---------------------------- Íconos base64 (encabezado PDF) ---------------------------- */
const PDF_ICONS = {
  phone: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAABI0lEQVR4nO2bwQ0CMQwEA6INWqIdaqAdWqIQeCGdouRQTl4Pknfe4GxGicPDtGaMMaYup6yFrrfHe/U7r+ddnk++wJGN9yhFnFWFW4vZfGSdETIB0aFVEiQCVGEVdS/RBfdYucvKY78l/ATMgq82stnno8VIm+CXo1084xlMEfDPWAAdgMYC6AA0FkAHoLEAOgCNBdABaCyADkBjAXQAGgugA9BYAB2AxgLoADQWQAegsQA6AI0F0AFoLIAOQGMBdACa8gJSR2R6ttMeGcMQI7AT0I+6ZM0E9SACZpslJJTvARZALDpreEQjTBEwutv9Zkebz+gJEuMRw5JRA5e/SP0dQD11e0iugOouK+rKekB0WJVUaROMCq18Hcr/Z8gYY0rzAXwMVmDaM0ziAAAAAElFTkSuQmCC",
  mail: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAABYUlEQVR4nO2ZyxHCMAxEF4Y2aIl2qIF2aIlC4MBoyGRwLMf6xMm+EwfG1tsIEScAIYQQQgghhJDjcdJ+8Xp7vD0L8eD1vFf9zpqFRpQHdHVXAxhVXqjVvxjA6PLCkkcxgL3ICyWfS8+imiETxdoLphqC1pta01NHVwdMN8/oBosL0NUBU6K7wWq/pgBqVzkqhNo+Ld3Y3AHZIVjKAytngGxSKsZjLliLC10zIKobvOQBgyHoHYKnPGD0L+AVgrc8YHAfIFjOhQhxwew+QOjthkh5wCEAYH0I0fKAUwBAewgZ8oDhDPiHdi5o1vDCrQOmrJWIOGCFBAC0y0SdLsMCAPRSkUfr0ACAr9xUcP45+rlCeADCXDTr8VpaAMBPOvPZYmoAW4ABZBeQDQPILiCbwwfQdBjaypsgS4odsKX3fhaUfBZ/AnsJYcmjOgNGD6FWv2oIjhrCqHUTQgghhBBCiDsf5Wy2y2ca2isAAAAASUVORK5CYII=",
  location: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAB0ElEQVR4nO1ay7HCMAw0zGuDlmiHGmiHliiEd8pMxpM4trS7MkR7heizlmxZcimJRCKROC8uaoW3+/Nz9J/36yGzS6Kox+k9sMmgCvc4XoNFBEUo0vEaaCKuSGGlcJ1nyIey2WtcaxURMkYAI+DIcIvBDJk1IAS0DEUYyZTv3gPYzh/J8e4JLgP3lDPPbrRO+CnwbTCvlHcltr73fDvy/RrQCOgx4HZ/fvYcaP02qqcXJkHW42lkw7LKGCWHQsAai0GW3dry7XQEtLA2liGzB2GnQG0oIq8tMqhVWg/er8clsl8QchlCYLrLUA0GGYwKk94SQ6QIypYtyJqPnmOQidPfBWQEjK6mqjUujYBep35uLrAFz20wMSOURRBSH7wUVoQxUucfyohILLZIO0KIpocFX9EUZZHAkOsiYJZjy2OHOwJUqcCaQVArQRQJzH0FQkBUKiD0wiKAlQrs8ZvkMmQlQVFryCdDs+mBRwAqFVSTZ2k/oJcEZZlNIYCVCgy5tAiwpoL60UVIU7Q1HlfbQiVA8UbIC3oE9KZCxHujUoLnAovTkc0VCQHWVVQUVtJLDPOlhxU5GlMqm3EyJI+AI+fUvYXTp0AYeuuARCKRYOIfQm0gfs7KUh4AAAAASUVORK5CYII=",
  nit: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAA10lEQVR4nO2awRHCMAwEFYY20hLtUEPaoSUKSToA4hw+e273b/myI9t6pAoAAABSWVoXro9tVwZR8H49T3/P7R9BZgIB7gBu4gXclcVaLqFWVJdwfAfEC5AegarfWvPTUbm6/izxHYAAdwA3CHAHcBMvQP4MXn2iek6TVXQAApgEVYVmBQHuAG4Q4A7gJl4Ak2DPzUYkXgCToKrQrCDAHcANAtwB3MQLYBLsudmIxAtgElQVmhUEuAO4QYA7gJt4AfGToFTAiH+QfyP+CCDAHcBNvAAAgGgOIWI61a1PKjkAAAAASUVORK5CYII="
};

/* ---------------------------- Datos de demo ---------------------------- */
function seedData() {
  const today = new Date();
  const daysAgo = (n) => {
    const d = new Date(today);
    d.setDate(d.getDate() - n);
    return d.toISOString();
  };

  const products = [
    { id: "p1", sku: "STK-001", codigoBarras: "7791234560017", nombre: "Cables HDMI 2m", categoria: "Electrónicos", stock: 5, stockMinimo: 10, precio: 2500 },
    { id: "p2", sku: "STK-002", codigoBarras: "7791234560024", nombre: "Toner HP 85A", categoria: "Oficina", stock: 8, stockMinimo: 15, precio: 18000 },
    { id: "p3", sku: "STK-003", codigoBarras: "7791234560031", nombre: "Mouse inalámbrico", categoria: "Electrónicos", stock: 7, stockMinimo: 10, precio: 6500 },
    { id: "p4", sku: "STK-004", codigoBarras: "7791234560048", nombre: "Teclado mecánico", categoria: "Electrónicos", stock: 24, stockMinimo: 8, precio: 15000 },
    { id: "p5", sku: "STK-005", codigoBarras: "7791234560055", nombre: "Resma papel A4", categoria: "Oficina", stock: 40, stockMinimo: 20, precio: 3200 },
    { id: "p6", sku: "STK-006", codigoBarras: "7791234560062", nombre: "Detergente 750ml", categoria: "Hogar", stock: 60, stockMinimo: 15, precio: 1800 },
    { id: "p7", sku: "STK-007", codigoBarras: "7791234560079", nombre: "Yerba mate 1kg", categoria: "Hogar", stock: 3, stockMinimo: 10, precio: 2900 },
    { id: "p8", sku: "STK-008", codigoBarras: "7791234560086", nombre: "Auriculares bluetooth", categoria: "Electrónicos", stock: 18, stockMinimo: 6, precio: 12000 },
    { id: "p9", sku: "STK-009", codigoBarras: "7791234560093", nombre: "Cuaderno A5", categoria: "Oficina", stock: 55, stockMinimo: 20, precio: 950 },
    { id: "p10", sku: "STK-010", codigoBarras: "7791234560109", nombre: "Lámpara LED escritorio", categoria: "Hogar", stock: 12, stockMinimo: 5, precio: 8500 },
    { id: "p11", sku: "STK-011", codigoBarras: "7791234560116", nombre: "Cargador USB-C", categoria: "Electrónicos", stock: 30, stockMinimo: 10, precio: 4200 },
    { id: "p12", sku: "STK-012", codigoBarras: "7791234560123", nombre: "Silla de oficina", categoria: "Otros", stock: 4, stockMinimo: 3, precio: 45000 }
  ];

  const movements = [
    { id: "m1", tipo: "entrada", productId: "p1", cantidad: 20, nota: "Compra a proveedor", fecha: daysAgo(6) },
    { id: "m2", tipo: "salida", productId: "p1", cantidad: 15, nota: "Venta mostrador", fecha: daysAgo(5) },
    { id: "m3", tipo: "entrada", productId: "p4", cantidad: 30, nota: "Reposición mensual", fecha: daysAgo(4) },
    { id: "m4", tipo: "salida", productId: "p9", cantidad: 12, nota: "Venta online", fecha: daysAgo(3) },
    { id: "m5", tipo: "entrada", productId: "p6", cantidad: 40, nota: "Compra a proveedor", fecha: daysAgo(2) },
    { id: "m6", tipo: "salida", productId: "p7", cantidad: 18, nota: "Venta mostrador", fecha: daysAgo(1) },
    { id: "m7", tipo: "salida", productId: "p3", cantidad: 5, nota: "Venta online", fecha: daysAgo(1) },
    { id: "m8", tipo: "entrada", productId: "p11", cantidad: 25, nota: "Compra a proveedor", fecha: daysAgo(0) }
  ];

  const users = [
    { id: "u1", nombre: "Admin", email: "admin@boxlyapp.com", rol: "Administrador" },
    { id: "u2", nombre: "Lucía Pérez", email: "lucia@boxlyapp.com", rol: "Editor" },
    { id: "u3", nombre: "Diego Ramos", email: "diego@boxlyapp.com", rol: "Visualizador" }
  ];

  const settings = {
    nombreNegocio: "Mi negocio",
    moneda: "ARS",
    stockMinimoDefault: 10,
    notificaciones: true,
    logoBase64: null,
    direccion: "",
    telefono: "",
    email: "",
    fiscal: ""
  };

  return { products, movements, users, settings };
}

/* ---------------------------- Persistencia ---------------------------- */
let STORE = loadStore();

function loadStore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      const seeded = seedData();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded));
      return seeded;
    }
    return migrateStore(JSON.parse(raw));
  } catch (err) {
    console.error("No se pudo cargar el almacenamiento local, usando datos de demo.", err);
    return seedData();
  }
}

/* Asegura que datos guardados con versiones anteriores tengan los campos nuevos
   (codigoBarras en productos, datos de empresa/logo en settings) sin perder
   la información ya cargada por el usuario. */
function migrateStore(store) {
  store.products = (store.products || []).map((p) => ({ codigoBarras: "", ...p }));
  store.settings = {
    nombreNegocio: "Mi negocio",
    moneda: "ARS",
    stockMinimoDefault: 10,
    notificaciones: true,
    logoBase64: null,
    direccion: "",
    telefono: "",
    email: "",
    fiscal: "",
    ...(store.settings || {})
  };
  store.movements = store.movements || [];
  store.users = store.users || [];
  return store;
}

function saveStore() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(STORE));
  } catch (err) {
    console.error("No se pudo guardar en el almacenamiento local.", err);
    showToast("No se pudo guardar. Verificá el espacio del navegador.", "error");
  }
}

function uid(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/* ---------------------------- Utilidades ---------------------------- */
function formatMoney(n) {
  const symbol = { ARS: "$", USD: "US$", MXN: "MX$", COP: "COL$" }[STORE.settings.moneda] || "$";
  return `${symbol}${Math.round(n).toLocaleString("es-AR")}`;
}

function formatDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function productStatus(p) {
  if (p.stock <= p.stockMinimo / 2) return "critical";
  if (p.stock <= p.stockMinimo) return "low";
  return "ok";
}

function statusLabel(status) {
  return { ok: "OK", low: "Bajo", critical: "Crítico" }[status];
}

function statusTagHtml(status) {
  return `<span class="status-tag status-${status}">${statusLabel(status)}</span>`;
}

function getProduct(id) {
  return STORE.products.find((p) => p.id === id);
}

/* Busca un producto por coincidencia EXACTA (sin importar mayúsculas/espacios)
   de SKU o código de barras. Se usa en el buscador/escáner de Entradas y Salidas. */
function findProductByCode(code) {
  const normalized = (code || "").trim().toLowerCase();
  if (!normalized) return null;
  return STORE.products.find((p) => {
    const sku = (p.sku || "").trim().toLowerCase();
    const barcode = (p.codigoBarras || "").trim().toLowerCase();
    return sku === normalized || (barcode && barcode === normalized);
  });
}

function refreshIcons() {
  lucide.createIcons();
}

function animateValue(el, to) {
  if (!el) return;
  const from = parseInt(el.textContent.replace(/\D/g, ""), 10) || 0;
  if (prefersReducedMotion || from === to) {
    el.textContent = to.toLocaleString("es-AR");
    return;
  }
  const duration = 600;
  const start = performance.now();
  function tick(now) {
    const progress = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    const value = Math.round(from + (to - from) * eased);
    el.textContent = value.toLocaleString("es-AR");
    if (progress < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

/* ---------------------------- Toasts ---------------------------- */
function showToast(message, type = "success") {
  const container = document.getElementById("toastContainer");
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  const icon = type === "error" ? "alert-circle" : type === "success" ? "check-circle-2" : "info";
  toast.innerHTML = `<i data-lucide="${icon}" class="h-4 w-4"></i><span>${message}</span>`;
  container.appendChild(toast);
  refreshIcons();
  setTimeout(() => {
    toast.classList.add("leaving");
    setTimeout(() => toast.remove(), 250);
  }, 2800);
}

/* ---------------------------- Modal genérico ---------------------------- */
const modalBackdrop = document.getElementById("modalBackdrop");
const modalTitle = document.getElementById("modalTitle");
const modalBody = document.getElementById("modalBody");
const modalClose = document.getElementById("modalClose");

/* Escáner de cámara activo (si hay uno abierto). Se detiene automáticamente
   al cerrar el modal, sin importar cómo se haya cerrado (X, backdrop, Escape). */
let activeCameraScanner = null;
function stopActiveCameraScanner() {
  if (activeCameraScanner) {
    activeCameraScanner
      .stop()
      .then(() => activeCameraScanner && activeCameraScanner.clear())
      .catch(() => {});
    activeCameraScanner = null;
  }
}

function openModal(title, bodyHtml, onMount) {
  modalTitle.textContent = title;
  modalBody.innerHTML = bodyHtml;
  modalBackdrop.classList.add("is-open");
  document.body.style.overflow = "hidden";
  refreshIcons();
  if (typeof onMount === "function") onMount(modalBody);
}

function closeModal() {
  stopActiveCameraScanner();
  modalBackdrop.classList.remove("is-open");
  document.body.style.overflow = "";
  modalBody.innerHTML = "";
}

modalClose.addEventListener("click", closeModal);
modalBackdrop.addEventListener("click", (e) => {
  if (e.target === modalBackdrop) closeModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeModal();
});

function openConfirmModal(title, message, confirmLabel, onConfirm) {
  openModal(
    title,
    `<p class="text-sm text-slate-500 leading-relaxed">${message}</p>
     <div class="flex justify-end gap-3 mt-6">
       <button id="confirmCancel" class="btn-secondary">Cancelar</button>
       <button id="confirmOk" class="btn-danger">${confirmLabel}</button>
     </div>`,
    (body) => {
      body.querySelector("#confirmCancel").addEventListener("click", closeModal);
      body.querySelector("#confirmOk").addEventListener("click", () => {
        onConfirm();
        closeModal();
      });
    }
  );
}

/* ---------------------------- Navegación ---------------------------- */
const appShell = document.querySelector(".app-shell");
const sidebarLinks = document.querySelectorAll(".sidebar-link");
const sections = document.querySelectorAll(".app-section");

const SECTION_META = {
  dashboard: { title: "Dashboard", subtitle: "Bienvenido de nuevo, acá está el resumen de tu inventario." },
  productos: { title: "Productos", subtitle: "Gestioná el catálogo completo de tu negocio." },
  entradas: { title: "Entradas", subtitle: "Registrá el ingreso de mercadería a tu inventario." },
  salidas: { title: "Salidas", subtitle: "Registrá ventas y salidas de stock." },
  inventario: { title: "Inventario", subtitle: "Vista completa del estado de tu stock." },
  reportes: { title: "Reportes", subtitle: "Métricas clave de tu inventario." },
  alertas: { title: "Alertas", subtitle: "Productos que necesitan tu atención." },
  usuarios: { title: "Usuarios", subtitle: "Administrá quién accede a tu cuenta." },
  configuracion: { title: "Configuración", subtitle: "Ajustá los datos de tu negocio." },
  ayuda: { title: "Ayuda y soporte", subtitle: "Estamos para ayudarte con Boxly." }
};

function switchSection(target, opts = {}) {
  sections.forEach((s) => s.classList.toggle("active", s.id === `section-${target}`));
  sidebarLinks.forEach((l) => l.classList.toggle("active", l.getAttribute("data-target") === target));
  const meta = SECTION_META[target];
  if (meta) {
    document.getElementById("pageTitle").textContent = meta.title;
    document.getElementById("pageSubtitle").textContent = meta.subtitle;
  }
  renderSection(target);
  appShell.classList.remove("mobile-open");
  if (!opts.keepScroll) {
    document.querySelector(".app-content").scrollTo({ top: 0, behavior: prefersReducedMotion ? "auto" : "smooth" });
  }
}

function renderSection(target) {
  switch (target) {
    case "dashboard": renderDashboard(); break;
    case "productos": renderProductos(); break;
    case "entradas": renderEntradas(); break;
    case "salidas": renderSalidas(); break;
    case "inventario": renderInventario(); break;
    case "reportes": renderReportes(); break;
    case "alertas": renderAlertas(); break;
    case "usuarios": renderUsuarios(); break;
    case "configuracion": renderConfiguracion(); break;
    case "ayuda": break; // sección estática, no requiere render dinámico
  }
}

sidebarLinks.forEach((link) => {
  link.addEventListener("click", () => switchSection(link.getAttribute("data-target")));
});

document.querySelectorAll("[data-target].panel-link").forEach((btn) => {
  btn.addEventListener("click", () => switchSection(btn.getAttribute("data-target")));
});

/* Sidebar collapse (desktop) & mobile toggle */
document.getElementById("collapseToggle").addEventListener("click", () => {
  appShell.classList.toggle("collapsed");
});
document.getElementById("mobileSidebarToggle").addEventListener("click", () => {
  appShell.classList.add("mobile-open");
});
document.getElementById("sidebarBackdrop").addEventListener("click", () => {
  appShell.classList.remove("mobile-open");
});

/* ---------------------------- Usuario logueado (sidebar) ---------------------------- */
function renderAuthUser() {
  if (!CURRENT_USER) return;
  const nombre = CURRENT_USER.nombre || CURRENT_USER.email || "Usuario";
  const inicial = nombre.trim().charAt(0).toUpperCase() || "U";
  document.getElementById("footerAvatar").textContent = inicial;
  document.getElementById("footerUserName").textContent = nombre;
  document.getElementById("footerUserRole").textContent = CURRENT_USER.email || "";
}

/* Cierra la sesión local. Al integrar Firebase, llamar además a firebase.auth().signOut(). */
document.getElementById("logoutBtn").addEventListener("click", () => {
  openConfirmModal(
    "Cerrar sesión",
    "¿Seguro que querés cerrar sesión en Boxly?",
    "Cerrar sesión",
    () => {
      if (typeof firebaseAuthInstance !== "undefined" && firebaseAuthInstance && firebaseAuthInstance.signOut) {
        firebaseAuthInstance.signOut().catch(() => {});
      }
      localStorage.removeItem(AUTH_KEY);
      window.location.replace("login.html");
    }
  );
});

/* Notification bell -> Alertas */
document.getElementById("notifBtn").addEventListener("click", () => switchSection("alertas"));

/* Quick add product from topbar */
document.getElementById("addProductQuick").addEventListener("click", () => openProductModal());

/* Global search -> jumps to Productos and filters */
document.getElementById("globalSearch").addEventListener("input", (e) => {
  const value = e.target.value;
  if (value.trim() === "") return;
  switchSection("productos", { keepScroll: true });
  const input = document.getElementById("productSearch");
  input.value = value;
  renderProductos();
});

/* =========================================================================
   DASHBOARD
   ========================================================================= */
function computeStats() {
  const totalProducts = STORE.products.length;
  const totalStock = STORE.products.reduce((sum, p) => sum + p.stock, 0);
  const totalValue = STORE.products.reduce((sum, p) => sum + p.stock * p.precio, 0);
  const activeAlerts = STORE.products.filter((p) => productStatus(p) !== "ok").length;
  return { totalProducts, totalStock, totalValue, activeAlerts };
}

function categoryBreakdown() {
  const map = {};
  STORE.products.forEach((p) => {
    map[p.categoria] = (map[p.categoria] || 0) + p.stock;
  });
  const total = Object.values(map).reduce((a, b) => a + b, 0) || 1;
  return Object.entries(map)
    .map(([categoria, stock]) => ({ categoria, stock, pct: Math.round((stock / total) * 100) }))
    .sort((a, b) => b.stock - a.stock);
}

function renderDonut(svgEl, legendEl) {
  const data = categoryBreakdown();
  svgEl.innerHTML = `<circle cx="21" cy="21" r="15.9" fill="none" stroke="#E9F8EE" stroke-width="6"></circle>`;
  let offset = 0;
  data.forEach((item, i) => {
    const color = CATEGORY_COLORS[i % CATEGORY_COLORS.length];
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("cx", "21");
    circle.setAttribute("cy", "21");
    circle.setAttribute("r", "15.9");
    circle.setAttribute("fill", "none");
    circle.setAttribute("stroke", color);
    circle.setAttribute("stroke-width", "6");
    circle.setAttribute("stroke-linecap", "round");
    circle.setAttribute("stroke-dasharray", `${item.pct} ${100 - item.pct}`);
    circle.setAttribute("stroke-dashoffset", `${-offset}`);
    svgEl.appendChild(circle);
    offset += item.pct;
  });

  legendEl.innerHTML = data.length
    ? data
        .map(
          (item, i) =>
            `<li class="flex items-center gap-2"><span class="h-2 w-2 rounded-full" style="background:${CATEGORY_COLORS[i % CATEGORY_COLORS.length]}"></span>${item.categoria} ${item.pct}%</li>`
        )
        .join("")
    : `<li class="text-slate-400">Sin productos cargados</li>`;
}

function renderDashboard() {
  const stats = computeStats();
  animateValue(document.getElementById("statTotalProducts"), stats.totalProducts);
  animateValue(document.getElementById("statTotalStock"), stats.totalStock);
  animateValue(document.getElementById("statTotalValue"), Math.round(stats.totalValue));
  animateValue(document.getElementById("statActiveAlerts"), stats.activeAlerts);

  renderDonut(document.getElementById("donutChart"), document.getElementById("donutLegend"));

  // Recent movements (last 5)
  const recent = [...STORE.movements].sort((a, b) => new Date(b.fecha) - new Date(a.fecha)).slice(0, 5);
  const list = document.getElementById("recentMovements");
  list.innerHTML = recent.length
    ? recent
        .map((m) => {
          const product = getProduct(m.productId);
          const isIn = m.tipo === "entrada";
          return `<li class="move-row">
            <span class="flex items-center text-slate-600">
              <span class="move-icon ${isIn ? "move-icon-in" : "move-icon-out"}">
                <i data-lucide="${isIn ? "arrow-down-to-line" : "arrow-up-from-line"}" class="h-3.5 w-3.5"></i>
              </span>
              ${product ? product.nombre : "Producto eliminado"}
            </span>
            <span class="font-mono text-xs ${isIn ? "text-greendark" : "text-red-500"}">${isIn ? "+" : "−"}${m.cantidad}</span>
          </li>`;
        })
        .join("")
    : `<li class="text-sm text-slate-400 px-1">Todavía no hay movimientos registrados.</li>`;

  // Low stock table
  const lowStock = STORE.products.filter((p) => productStatus(p) !== "ok").sort((a, b) => a.stock - b.stock);
  const tbody = document.getElementById("lowStockTableBody");
  tbody.innerHTML = lowStock.length
    ? lowStock
        .map(
          (p) => `<tr>
            <td class="font-medium text-ink">${p.nombre}</td>
            <td class="text-slate-400">${p.categoria}</td>
            <td class="font-mono">${p.stock}</td>
            <td class="font-mono">${p.stockMinimo}</td>
            <td>${statusTagHtml(productStatus(p))}</td>
          </tr>`
        )
        .join("")
    : `<tr><td colspan="5" class="empty-state">No hay productos con stock bajo. ¡Buen trabajo!</td></tr>`;

  refreshIcons();
  updateAlertBadges();
}

function updateAlertBadges() {
  const count = STORE.products.filter((p) => productStatus(p) !== "ok").length;
  document.getElementById("sidebarAlertBadge").textContent = count;
  document.getElementById("notifBadge").textContent = count;
  document.getElementById("sidebarAlertBadge").style.display = count ? "inline-flex" : "none";
  document.getElementById("notifBadge").style.display = count ? "inline-flex" : "none";
}

/* =========================================================================
   PRODUCTOS
   ========================================================================= */
function populateCategoryFilter() {
  const select = document.getElementById("productCategoryFilter");
  const current = select.value;
  const categories = [...new Set(STORE.products.map((p) => p.categoria))].sort();
  select.innerHTML = `<option value="">Todas las categorías</option>` + categories.map((c) => `<option value="${c}">${c}</option>`).join("");
  select.value = current;
}

function renderProductos() {
  populateCategoryFilter();
  const search = document.getElementById("productSearch").value.trim().toLowerCase();
  const category = document.getElementById("productCategoryFilter").value;

  const filtered = STORE.products.filter((p) => {
    const matchesSearch = !search || p.nombre.toLowerCase().includes(search) || p.sku.toLowerCase().includes(search);
    const matchesCategory = !category || p.categoria === category;
    return matchesSearch && matchesCategory;
  });

  const tbody = document.getElementById("productsTableBody");
  const emptyState = document.getElementById("productsEmptyState");

  tbody.innerHTML = filtered
    .map(
      (p) => `<tr>
        <td class="font-mono text-xs text-slate-400">${p.sku}</td>
        <td class="font-medium text-ink">${p.nombre}</td>
        <td class="text-slate-400">${p.categoria}</td>
        <td class="font-mono">${p.stock}</td>
        <td class="font-mono">${p.stockMinimo}</td>
        <td class="font-mono">${formatMoney(p.precio)}</td>
        <td>${statusTagHtml(productStatus(p))}</td>
        <td class="text-right whitespace-nowrap">
          <button class="icon-btn" data-edit="${p.id}" aria-label="Editar"><i data-lucide="pencil" class="h-4 w-4"></i></button>
          <button class="icon-btn danger" data-delete="${p.id}" aria-label="Eliminar"><i data-lucide="trash-2" class="h-4 w-4"></i></button>
        </td>
      </tr>`
    )
    .join("");

  emptyState.classList.toggle("hidden", filtered.length > 0);
  refreshIcons();

  tbody.querySelectorAll("[data-edit]").forEach((btn) => {
    btn.addEventListener("click", () => openProductModal(getProduct(btn.getAttribute("data-edit"))));
  });
  tbody.querySelectorAll("[data-delete]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const product = getProduct(btn.getAttribute("data-delete"));
      openConfirmModal(
        "Eliminar producto",
        `¿Seguro que querés eliminar <strong>${product.nombre}</strong>? Esta acción no se puede deshacer.`,
        "Eliminar",
        () => {
          STORE.products = STORE.products.filter((p) => p.id !== product.id);
          saveStore();
          renderProductos();
          renderDashboard();
          showToast("Producto eliminado.", "success");
        }
      );
    });
  });
}

document.getElementById("productSearch").addEventListener("input", renderProductos);
document.getElementById("productCategoryFilter").addEventListener("change", renderProductos);
document.getElementById("openAddProduct").addEventListener("click", () => openProductModal());

function openProductModal(existing, options = {}) {
  const isEdit = Boolean(existing);
  const categories = [...new Set(STORE.products.map((p) => p.categoria))].sort();
  const prefillSku = options.prefillSku || "";
  const prefillBarcode = options.prefillBarcode || prefillSku || "";

  openModal(
    isEdit ? "Editar producto" : "Nuevo producto",
    `<form id="productForm" class="movement-form">
      <label class="form-label">SKU</label>
      <input id="pfSku" type="text" class="form-input" value="${isEdit ? existing.sku : prefillSku}" placeholder="Ej: STK-013" required>

      <label class="form-label">Código de barras (opcional)</label>
      <input id="pfCodigoBarras" type="text" class="form-input" value="${isEdit ? existing.codigoBarras || "" : prefillBarcode}" placeholder="Ej: 7791234567890">

      <label class="form-label">Nombre del producto</label>
      <input id="pfNombre" type="text" class="form-input" value="${isEdit ? existing.nombre : ""}" placeholder="Ej: Auriculares con cable" required>

      <label class="form-label">Categoría</label>
      <input id="pfCategoria" list="categoryOptions" type="text" class="form-input" value="${isEdit ? existing.categoria : ""}" placeholder="Ej: Electrónicos" required>
      <datalist id="categoryOptions">${categories.map((c) => `<option value="${c}">`).join("")}</datalist>

      <div class="form-row">
        <div>
          <label class="form-label">Stock actual</label>
          <input id="pfStock" type="number" min="0" step="1" class="form-input" value="${isEdit ? existing.stock : 0}" required>
        </div>
        <div>
          <label class="form-label">Stock mínimo</label>
          <input id="pfStockMinimo" type="number" min="0" step="1" class="form-input" value="${isEdit ? existing.stockMinimo : STORE.settings.stockMinimoDefault}" required>
        </div>
      </div>

      <label class="form-label">Precio unitario</label>
      <input id="pfPrecio" type="number" min="0" step="0.01" class="form-input" value="${isEdit ? existing.precio : 0}" required>

      <button type="submit" class="btn-primary w-full justify-center mt-4">
        <i data-lucide="${isEdit ? "save" : "plus"}" class="h-4 w-4"></i>
        ${isEdit ? "Guardar cambios" : "Crear producto"}
      </button>
    </form>`,
    (body) => {
      body.querySelector("#productForm").addEventListener("submit", (e) => {
        e.preventDefault();
        const payload = {
          sku: body.querySelector("#pfSku").value.trim(),
          codigoBarras: body.querySelector("#pfCodigoBarras").value.trim(),
          nombre: body.querySelector("#pfNombre").value.trim(),
          categoria: body.querySelector("#pfCategoria").value.trim() || "Otros",
          stock: parseInt(body.querySelector("#pfStock").value, 10) || 0,
          stockMinimo: parseInt(body.querySelector("#pfStockMinimo").value, 10) || 0,
          precio: parseFloat(body.querySelector("#pfPrecio").value) || 0
        };

        let savedProduct;
        if (isEdit) {
          Object.assign(existing, payload);
          savedProduct = existing;
          showToast("Producto actualizado.", "success");
        } else {
          savedProduct = { id: uid("p"), ...payload };
          STORE.products.push(savedProduct);
          showToast("Producto creado.", "success");
        }

        saveStore();
        closeModal();
        renderProductos();
        renderDashboard();
        if (typeof options.onSaved === "function") options.onSaved(savedProduct);
      });
    }
  );
}

/* =========================================================================
   ENTRADAS / SALIDAS
   ========================================================================= */
function populateCategorySelect(selectEl) {
  const current = selectEl.value;
  const categories = [...new Set(STORE.products.map((p) => p.categoria))].sort();
  selectEl.innerHTML = `<option value="">Todas las categorías</option>` + categories.map((c) => `<option value="${c}">${c}</option>`).join("");
  if (categories.includes(current)) selectEl.value = current;
}

function populateProductSelect(selectEl, categoria) {
  const current = selectEl.value;
  const list = STORE.products.filter((p) => !categoria || p.categoria === categoria);
  selectEl.innerHTML = list.length
    ? list.map((p) => `<option value="${p.id}">${p.nombre} · ${p.sku} · ${p.categoria} (stock: ${p.stock})</option>`).join("")
    : `<option value="">No hay productos en esta categoría</option>`;
  if (list.some((p) => p.id === current)) selectEl.value = current;
}

function renderMovementHistory(tipo, tbodyId, emptyId) {
  const items = STORE.movements.filter((m) => m.tipo === tipo).sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
  const tbody = document.getElementById(tbodyId);
  tbody.innerHTML = items
    .map((m) => {
      const product = getProduct(m.productId);
      return `<tr>
        <td class="font-mono text-xs text-slate-400">${formatDate(m.fecha)}</td>
        <td class="font-medium text-ink">${product ? product.nombre : "Producto eliminado"}</td>
        <td class="font-mono ${tipo === "entrada" ? "text-greendark" : "text-red-500"}">${tipo === "entrada" ? "+" : "−"}${m.cantidad}</td>
        <td class="text-slate-400">${m.nota || "—"}</td>
      </tr>`;
    })
    .join("");
  document.getElementById(emptyId).classList.toggle("hidden", items.length > 0);
}

function renderEntradas() {
  const categoriaFiltro = document.getElementById("entradaCategoriaFiltro");
  populateCategorySelect(categoriaFiltro);
  populateProductSelect(document.getElementById("entradaProducto"), categoriaFiltro.value);
  renderMovementHistory("entrada", "entradasHistoryBody", "entradasEmptyState");
}

function renderSalidas() {
  const categoriaFiltro = document.getElementById("salidaCategoriaFiltro");
  populateCategorySelect(categoriaFiltro);
  populateProductSelect(document.getElementById("salidaProducto"), categoriaFiltro.value);
  renderMovementHistory("salida", "salidasHistoryBody", "salidasEmptyState");
}

document.getElementById("entradaCategoriaFiltro").addEventListener("change", (e) => {
  populateProductSelect(document.getElementById("entradaProducto"), e.target.value);
});
document.getElementById("salidaCategoriaFiltro").addEventListener("change", (e) => {
  populateProductSelect(document.getElementById("salidaProducto"), e.target.value);
});

function registerMovement(tipo, productSelectId, cantidadId, notaId, formId) {
  const productId = document.getElementById(productSelectId).value;
  const cantidad = parseInt(document.getElementById(cantidadId).value, 10);
  const nota = document.getElementById(notaId).value.trim();
  const product = getProduct(productId);

  if (!product || !cantidad || cantidad <= 0) {
    showToast("Completá el producto y una cantidad válida.", "error");
    return;
  }

  if (tipo === "salida" && cantidad > product.stock) {
    showToast(`No hay suficiente stock de ${product.nombre} (disponible: ${product.stock}).`, "error");
    return;
  }

  product.stock += tipo === "entrada" ? cantidad : -cantidad;
  STORE.movements.push({ id: uid("m"), tipo, productId, cantidad, nota, fecha: new Date().toISOString() });
  saveStore();

  document.getElementById(formId).reset();
  renderEntradas();
  renderSalidas();
  renderDashboard();
  showToast(tipo === "entrada" ? "Entrada registrada." : "Salida registrada.", "success");
}

document.getElementById("entradaForm").addEventListener("submit", (e) => {
  e.preventDefault();
  registerMovement("entrada", "entradaProducto", "entradaCantidad", "entradaNota", "entradaForm");
});
document.getElementById("salidaForm").addEventListener("submit", (e) => {
  e.preventDefault();
  registerMovement("salida", "salidaProducto", "salidaCantidad", "salidaNota", "salidaForm");
});

/* ---------------------------- Buscador / escáner de código ---------------------------- */
const MOVEMENT_FIELD_IDS = {
  entrada: { scan: "entradaScan", cam: "entradaScanCam", select: "entradaProducto", categoria: "entradaCategoriaFiltro", cantidad: "entradaCantidad" },
  salida: { scan: "salidaScan", cam: "salidaScanCam", select: "salidaProducto", categoria: "salidaCategoriaFiltro", cantidad: "salidaCantidad" }
};

function setupScanInput(tipo) {
  const ids = MOVEMENT_FIELD_IDS[tipo];
  const scanInput = document.getElementById(ids.scan);
  const camBtn = document.getElementById(ids.cam);

  scanInput.addEventListener("keydown", (e) => {
    // Los lectores físicos (pistola/USB) escriben el código y envían "Enter" solos.
    if (e.key !== "Enter") return;
    e.preventDefault();
    handleScannedCode(scanInput.value, tipo);
  });

  camBtn.addEventListener("click", () => {
    openCameraScanner((decodedText) => {
      scanInput.value = decodedText;
      handleScannedCode(decodedText, tipo);
    });
  });
}

function handleScannedCode(rawCode, tipo) {
  const code = (rawCode || "").trim();
  if (!code) return;

  const ids = MOVEMENT_FIELD_IDS[tipo];
  const product = findProductByCode(code);

  if (product) {
    document.getElementById(ids.categoria).value = "";
    populateProductSelect(document.getElementById(ids.select), "");
    document.getElementById(ids.select).value = product.id;
    document.getElementById(ids.scan).value = "";
    document.getElementById(ids.cantidad).focus();
    showToast(`Producto encontrado: ${product.nombre}`, "success");
    return;
  }

  openConfirmModal(
    "Producto no encontrado",
    `El código <strong>${code}</strong> no está registrado en tu inventario. ¿Querés registrarlo ahora?`,
    "Registrar producto",
    () => {
      openProductModal(null, {
        prefillSku: code,
        prefillBarcode: code,
        onSaved: (newProduct) => {
          document.getElementById(ids.categoria).value = "";
          populateProductSelect(document.getElementById(ids.select), "");
          document.getElementById(ids.select).value = newProduct.id;
          document.getElementById(ids.scan).value = "";
          document.getElementById(ids.cantidad).focus();
          renderEntradas();
          renderSalidas();
        }
      });
    }
  );
}

setupScanInput("entrada");
setupScanInput("salida");

/* ---------------------------- Escáner por cámara (QR / código de barras) ---------------------------- */
function openCameraScanner(onDecoded) {
  if (typeof Html5Qrcode === "undefined") {
    showToast("No se pudo cargar el módulo de cámara. Verificá tu conexión a internet.", "error");
    return;
  }
  openModal(
    "Escanear código",
    `<div id="qrReader" class="qr-reader-box"></div>
     <p class="text-xs text-slate-400 mt-3 text-center">Apuntá la cámara al código de barras o QR del producto.</p>`,
    () => {
      const reader = new Html5Qrcode("qrReader");
      activeCameraScanner = reader;
      reader
        .start(
          { facingMode: "environment" },
          { fps: 10, qrbox: { width: 240, height: 160 } },
          (decodedText) => {
            const finishedReader = reader;
            activeCameraScanner = null;
            finishedReader
              .stop()
              .then(() => finishedReader.clear())
              .catch(() => {});
            closeModal();
            onDecoded(decodedText);
          },
          () => {
            /* Ignorar frames sin código detectado, es esperable mientras se enfoca. */
          }
        )
        .catch(() => {
          showToast("No se pudo acceder a la cámara. Revisá los permisos del navegador.", "error");
          closeModal();
        });
    }
  );
}

/* =========================================================================
   INVENTARIO
   ========================================================================= */
function renderInventario() {
  const search = document.getElementById("inventarioSearch").value.trim().toLowerCase();
  const statusFilter = document.getElementById("inventarioStatusFilter").value;
  const mappedStatus = STATUS_FILTER_MAP[statusFilter] || "";

  const filtered = STORE.products.filter((p) => {
    const matchesSearch = !search || p.nombre.toLowerCase().includes(search) || p.sku.toLowerCase().includes(search);
    const matchesStatus = !mappedStatus || productStatus(p) === mappedStatus;
    return matchesSearch && matchesStatus;
  });

  const tbody = document.getElementById("inventarioTableBody");
  tbody.innerHTML = filtered.length
    ? filtered
        .map(
          (p) => `<tr>
            <td class="font-mono text-xs text-slate-400">${p.sku}</td>
            <td class="font-medium text-ink">${p.nombre}</td>
            <td class="text-slate-400">${p.categoria}</td>
            <td class="font-mono">${p.stock}</td>
            <td class="font-mono">${p.stockMinimo}</td>
            <td class="font-mono">${formatMoney(p.stock * p.precio)}</td>
            <td>${statusTagHtml(productStatus(p))}</td>
          </tr>`
        )
        .join("")
    : `<tr><td colspan="7" class="empty-state">No encontramos productos con ese criterio.</td></tr>`;
}

document.getElementById("inventarioSearch").addEventListener("input", renderInventario);
document.getElementById("inventarioStatusFilter").addEventListener("change", renderInventario);

/* =========================================================================
   REPORTES
   ========================================================================= */
let reportQuickFilter = "todo";

function populateReportCategoryFilter() {
  const select = document.getElementById("repCategoria");
  const current = select.value;
  const categories = [...new Set(STORE.products.map((p) => p.categoria))].sort();
  select.innerHTML = `<option value="">Todas las categorías</option>` + categories.map((c) => `<option value="${c}">${c}</option>`).join("");
  if (categories.includes(current)) select.value = current;
}

function quickFilterRange(key) {
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);

  if (key === "hoy") return { start, end };
  if (key === "semana") {
    const day = (start.getDay() + 6) % 7; // lunes = 0
    start.setDate(start.getDate() - day);
    return { start, end };
  }
  if (key === "mes") {
    start.setDate(1);
    return { start, end };
  }
  if (key === "anio") {
    start.setMonth(0, 1);
    return { start, end };
  }
  return null; // "todo"
}

function getReportFilters() {
  const desdeInput = document.getElementById("repDesde").value;
  const hastaInput = document.getElementById("repHasta").value;
  const tipo = document.getElementById("repTipo").value;
  const categoria = document.getElementById("repCategoria").value;
  const orden = document.getElementById("repOrden").value;

  let start = desdeInput ? new Date(`${desdeInput}T00:00:00`) : null;
  let end = hastaInput ? new Date(`${hastaInput}T23:59:59`) : null;

  if (!desdeInput && !hastaInput && reportQuickFilter !== "todo") {
    const range = quickFilterRange(reportQuickFilter);
    if (range) {
      start = range.start;
      end = range.end;
    }
  }

  return { start, end, tipo, categoria, orden };
}

function getFilteredReportMovements() {
  const { start, end, tipo, categoria, orden } = getReportFilters();

  let filtered = STORE.movements.filter((m) => {
    const fecha = new Date(m.fecha);
    const matchesStart = !start || fecha >= start;
    const matchesEnd = !end || fecha <= end;
    const matchesTipo = !tipo || m.tipo === tipo;
    const product = getProduct(m.productId);
    const matchesCategoria = !categoria || (product && product.categoria === categoria);
    return matchesStart && matchesEnd && matchesTipo && matchesCategoria;
  });

  filtered.sort((a, b) => (orden === "asc" ? new Date(a.fecha) - new Date(b.fecha) : new Date(b.fecha) - new Date(a.fecha)));
  return filtered;
}

function renderReportMovementsTable() {
  const filtered = getFilteredReportMovements();
  const tbody = document.getElementById("repMovementsBody");
  const empty = document.getElementById("repEmptyState");

  tbody.innerHTML = filtered
    .map((m) => {
      const product = getProduct(m.productId);
      return `<tr>
        <td class="font-mono text-xs text-slate-400">${formatDate(m.fecha)}</td>
        <td>${m.tipo === "entrada" ? `<span class="status-tag status-ok">Entrada</span>` : `<span class="status-tag status-critical">Salida</span>`}</td>
        <td class="font-medium text-ink">${product ? product.nombre : "Producto eliminado"}</td>
        <td class="text-slate-400">${product ? product.categoria : "—"}</td>
        <td class="font-mono ${m.tipo === "entrada" ? "text-greendark" : "text-red-500"}">${m.tipo === "entrada" ? "+" : "−"}${m.cantidad}</td>
        <td class="text-slate-400">${m.nota || "—"}</td>
      </tr>`;
    })
    .join("");

  empty.classList.toggle("hidden", filtered.length > 0);
  document.getElementById("repResultCount").textContent = `${filtered.length} movimiento${filtered.length === 1 ? "" : "s"} encontrado${filtered.length === 1 ? "" : "s"}`;
}

function renderReportes() {
  renderDonut(document.getElementById("reportDonut"), document.getElementById("reportDonutLegend"));

  const totalIn = STORE.movements.filter((m) => m.tipo === "entrada").reduce((s, m) => s + m.cantidad, 0);
  const totalOut = STORE.movements.filter((m) => m.tipo === "salida").reduce((s, m) => s + m.cantidad, 0);
  const maxMovement = Math.max(totalIn, totalOut, 1);

  const movementBars = document.getElementById("movementBars");
  movementBars.innerHTML = `
    <div class="bar-row">
      <span class="bar-label">Entradas</span>
      <span class="bar-track"><span class="bar-fill bar-fill-in" style="width:0%" data-width="${(totalIn / maxMovement) * 100}"></span></span>
      <span class="bar-value">${totalIn}</span>
    </div>
    <div class="bar-row">
      <span class="bar-label">Salidas</span>
      <span class="bar-track"><span class="bar-fill bar-fill-out" style="width:0%" data-width="${(totalOut / maxMovement) * 100}"></span></span>
      <span class="bar-value">${totalOut}</span>
    </div>`;

  const topProducts = [...STORE.products].sort((a, b) => b.stock - a.stock).slice(0, 5);
  const maxStock = Math.max(...topProducts.map((p) => p.stock), 1);
  const topStockBars = document.getElementById("topStockBars");
  topStockBars.innerHTML = topProducts
    .map(
      (p) => `<div class="bar-row">
        <span class="bar-label" title="${p.nombre}">${p.nombre.length > 16 ? p.nombre.slice(0, 15) + "…" : p.nombre}</span>
        <span class="bar-track"><span class="bar-fill bar-fill-stock" style="width:0%" data-width="${(p.stock / maxStock) * 100}"></span></span>
        <span class="bar-value">${p.stock}</span>
      </div>`
    )
    .join("");

  // Animate bar widths on next frame
  requestAnimationFrame(() => {
    document.querySelectorAll(".bar-fill").forEach((el) => {
      el.style.width = `${el.getAttribute("data-width")}%`;
    });
  });

  populateReportCategoryFilter();
  renderReportMovementsTable();
}

["repDesde", "repHasta", "repTipo", "repCategoria", "repOrden"].forEach((id) => {
  document.getElementById(id).addEventListener("change", () => {
    if (id === "repDesde" || id === "repHasta") {
      reportQuickFilter = "todo";
      document.querySelectorAll(".chip-btn").forEach((btn) => btn.classList.toggle("active", btn.getAttribute("data-quick") === "todo"));
    }
    renderReportMovementsTable();
  });
});

document.querySelectorAll(".chip-btn[data-quick]").forEach((btn) => {
  btn.addEventListener("click", () => {
    reportQuickFilter = btn.getAttribute("data-quick");
    document.querySelectorAll(".chip-btn").forEach((b) => b.classList.toggle("active", b === btn));
    document.getElementById("repDesde").value = "";
    document.getElementById("repHasta").value = "";
    renderReportMovementsTable();
  });
});

/* ---------------------------- Exportación a PDF (auditoría) ---------------------------- */
function buildReportRangeLabel() {
  const { start, end } = getReportFilters();
  if (!start && !end) return "Todo el historial";
  const fmt = (d) => d.toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric" });
  if (start && end) return `Del ${fmt(start)} al ${fmt(end)}`;
  if (start) return `Desde el ${fmt(start)}`;
  return `Hasta el ${fmt(end)}`;
}

/* Columnas disponibles para el reporte de movimientos. "width" se usa solo en el Excel. */
const REPORT_COLUMN_DEFS = [
  { id: "colFecha", header: "Fecha", key: "fecha", width: 14 },
  { id: "colTipo", header: "Tipo", key: "tipo", width: 12 },
  { id: "colProducto", header: "Producto", key: "producto", width: 30 },
  { id: "colCategoria", header: "Categoría", key: "categoria", width: 18 },
  { id: "colCantidad", header: "Cantidad", key: "cantidad", width: 12 },
  { id: "colNota", header: "Nota", key: "nota", width: 34 }
];

function getReportColumnValue(key, m, p) {
  switch (key) {
    case "fecha": return formatDate(m.fecha);
    case "tipo": return m.tipo === "entrada" ? "Entrada" : "Salida";
    case "producto": return p ? p.nombre : "Producto eliminado";
    case "categoria": return p ? p.categoria : "—";
    case "cantidad": return `${m.tipo === "entrada" ? "+" : "-"}${m.cantidad}`;
    case "nota": return m.nota || "—";
    default: return "";
  }
}

function generateMovementsPdf() {
  const filtered = getFilteredReportMovements();
  if (!filtered.length) {
    showToast("No hay movimientos para exportar con estos filtros.", "error");
    return;
  }
  if (!window.jspdf || !window.jspdf.jsPDF) {
    showToast("No se pudo cargar el generador de PDF. Verificá tu conexión a internet.", "error");
    return;
  }

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const marginX = 40;
  let headerY = 40;

  const settings = STORE.settings;
  const hasLogo = Boolean(settings.logoBase64);
  const nameX = hasLogo ? marginX + 50 : marginX;

  if (hasLogo) {
    try {
      doc.addImage(settings.logoBase64, marginX, headerY - 15, 38, 38);
    } catch (err) {
      console.warn("No se pudo insertar el logo en el PDF.", err);
    }
  } else {
    try {
      doc.addImage(PDF_ICONS.building, marginX, headerY - 15, 26, 26);
    } catch (err) { /* ignorar */ }
  }

  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  doc.setTextColor("#0B2B26");
  doc.text(settings.nombreNegocio || "Mi negocio", nameX, headerY);

  /* Datos de la empresa en grilla de 2 columnas x 2 filas: aprovecha el
     espacio horizontal disponible en vez de apilar todo verticalmente. */
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.3);
  doc.setTextColor("#475569");
  const iconSize = 7.5;
  const col1X = nameX;
  const col2X = nameX + 165;
  let infoY = headerY + 14;

  function drawInfoField(x, y, icon, text) {
    if (!text) return;
    if (icon) {
      doc.addImage(icon, x, y - 6.5, iconSize, iconSize);
      doc.text(text, x + iconSize + 4, y);
    } else {
      doc.text(text, x, y);
    }
  }

  const row1HasContent = settings.direccion || settings.telefono;
  const row2HasContent = settings.email || settings.fiscal;

  drawInfoField(col1X, infoY, PDF_ICONS.location, settings.direccion);
  drawInfoField(col2X, infoY, PDF_ICONS.phone, settings.telefono);
  if (row1HasContent) infoY += 12;
  drawInfoField(col1X, infoY, PDF_ICONS.mail, settings.email);
  drawInfoField(col2X, infoY, PDF_ICONS.nit, settings.fiscal ? `CUIT/ID: ${settings.fiscal}` : "");
  if (row2HasContent) infoY += 12;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.setTextColor("#0B2B26");
  doc.text("Reporte de movimientos", pageWidth - marginX, headerY, { align: "right" });

  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.3);
  doc.setTextColor("#475569");
  doc.text(buildReportRangeLabel(), pageWidth - marginX, headerY + 14, { align: "right" });
  doc.text(`Generado: ${new Date().toLocaleString("es-AR")}`, pageWidth - marginX, headerY + 26, { align: "right" });

  const tableStartY = Math.max(infoY, headerY + 32) + 12;
  doc.setDrawColor("#E2E8F0");
  doc.setLineWidth(0.75);
  doc.line(marginX, tableStartY - 10, pageWidth - marginX, tableStartY - 10);

  const columnDefs = REPORT_COLUMN_DEFS;
  const activeColumns = columnDefs.filter((c) => document.getElementById(c.id).checked);
  const columns = activeColumns.length ? activeColumns : columnDefs; // por si desmarcan todas

  const rows = filtered.map((m) => {
    const p = getProduct(m.productId);
    return columns.map((c) => getReportColumnValue(c.key, m, p));
  });

  doc.autoTable({
    startY: tableStartY,
    head: [columns.map((c) => c.header)],
    body: rows,
    styles: { font: "helvetica", fontSize: 7.3, textColor: "#334155", cellPadding: 4 },
    headStyles: { fillColor: "#0E6B4F", textColor: "#ffffff", fontStyle: "bold", fontSize: 7.6 },
    alternateRowStyles: { fillColor: "#F8FBF9" },
    margin: { left: marginX, right: marginX }
  });

  let finalY = doc.lastAutoTable.finalY + 20;
  const totalIn = filtered.filter((m) => m.tipo === "entrada").reduce((s, m) => s + m.cantidad, 0);
  const totalOut = filtered.filter((m) => m.tipo === "salida").reduce((s, m) => s + m.cantidad, 0);

  doc.setFont("helvetica", "bold");
  doc.setFontSize(8.5);
  doc.setTextColor("#0B2B26");
  doc.text(`Total entradas: +${totalIn}     Total salidas: -${totalOut}     Movimientos: ${filtered.length}`, marginX, finalY);

  finalY += 16;

  /* ---------------------------- Firma digital (opcional) ---------------------------- */
  const firmaHabilitada = document.getElementById("cfgFirmaHabilitada").checked;
  if (firmaHabilitada) {
    finalY = drawSignatureSection(doc, finalY, marginX, pageWidth);
  }

  doc.setFont("helvetica", "normal");
  doc.setFontSize(7);
  doc.setTextColor("#94A3B8");
  doc.text("Generado con Boxly — Panel de control de inventario.", marginX, doc.internal.pageSize.getHeight() - 20);

  doc.save(`boxly-reporte-movimientos-${new Date().toISOString().slice(0, 10)}.pdf`);
  showToast("Reporte PDF generado.", "success");
}

/* ---------------------------- Exportación a Excel (auditoría) ----------------------------
   Genera una planilla real: cada dato en su propia celda/columna (no todo apilado en una
   sola celda), con encabezados en verde, cuerpo con tinte alterno y el logo del negocio. */
async function generateMovementsExcel() {
  const filtered = getFilteredReportMovements();
  if (!filtered.length) {
    showToast("No hay movimientos para exportar con estos filtros.", "error");
    return;
  }
  if (!window.ExcelJS) {
    showToast("No se pudo cargar el generador de Excel. Verificá tu conexión a internet.", "error");
    return;
  }

  const settings = STORE.settings;
  const columnDefs = REPORT_COLUMN_DEFS;
  const activeColumns = columnDefs.filter((c) => document.getElementById(c.id).checked);
  const columns = activeColumns.length ? activeColumns : columnDefs;
  const colCount = columns.length;

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Boxly";
  workbook.created = new Date();
  const sheet = workbook.addWorksheet("Movimientos", {
    pageSetup: { orientation: "landscape", fitToPage: true }
  });

  const GREEN = "FF0E6B4F";
  const GREEN_LIGHT = "FFE9F8EE";
  const INK = "FF0B2B26";
  const MUTED = "FF64748B";
  const BORDER = "FFDCEAE1";

  // ---- Encabezado con nombre del negocio, datos de contacto y logo ----
  sheet.mergeCells(1, 1, 1, Math.max(colCount - 2, 1));
  const titleCell = sheet.getCell(1, 1);
  titleCell.value = settings.nombreNegocio || "Mi negocio";
  titleCell.font = { bold: true, size: 14, color: { argb: INK } };
  sheet.getRow(1).height = 24;

  const infoParts = [settings.direccion, settings.telefono, settings.email, settings.fiscal ? `CUIT/ID: ${settings.fiscal}` : null].filter(Boolean);
  sheet.mergeCells(2, 1, 2, Math.max(colCount - 2, 1));
  sheet.getCell(2, 1).value = infoParts.join("   ·   ") || " ";
  sheet.getCell(2, 1).font = { size: 9, color: { argb: MUTED } };

  sheet.mergeCells(3, 1, 3, Math.max(colCount - 2, 1));
  const reportTitleCell = sheet.getCell(3, 1);
  reportTitleCell.value = `Reporte de movimientos — ${buildReportRangeLabel()}`;
  reportTitleCell.font = { bold: true, size: 11, color: { argb: GREEN } };

  sheet.mergeCells(4, 1, 4, Math.max(colCount - 2, 1));
  sheet.getCell(4, 1).value = `Generado: ${new Date().toLocaleString("es-AR")}`;
  sheet.getCell(4, 1).font = { italic: true, size: 8.5, color: { argb: MUTED } };

  if (settings.logoBase64) {
    try {
      const match = /^data:image\/(png|jpe?g|webp);base64,/i.exec(settings.logoBase64);
      let ext = match ? match[1].toLowerCase() : "png";
      if (ext === "jpg") ext = "jpeg";
      if (ext === "webp") ext = "png"; // ExcelJS no soporta webp; se omite si no matchea png/jpeg
      const base64Data = settings.logoBase64.split(",")[1];
      if (base64Data && (ext === "png" || ext === "jpeg")) {
        const imageId = workbook.addImage({ base64: base64Data, extension: ext });
        sheet.addImage(imageId, { tl: { col: Math.max(colCount - 2, 1), row: 0 }, ext: { width: 64, height: 64 } });
        sheet.getRow(1).height = 26;
        sheet.getRow(2).height = 16;
        sheet.getRow(3).height = 16;
        sheet.getRow(4).height = 16;
      }
    } catch (err) {
      console.warn("No se pudo insertar el logo en el Excel.", err);
    }
  }

  // ---- Encabezado de columnas (verde, texto blanco) ----
  const headerRowIndex = 6;
  const headerRow = sheet.getRow(headerRowIndex);
  columns.forEach((c, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = c.header;
    cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 10.5 };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: GREEN } };
    cell.alignment = { vertical: "middle", horizontal: c.key === "cantidad" ? "right" : "left" };
    cell.border = { bottom: { style: "thin", color: { argb: "FF15803D" } } };
  });
  headerRow.height = 22;

  // ---- Filas de datos: cada columna en su propia celda, con tinte alterno ----
  filtered.forEach((m, rowIdx) => {
    const p = getProduct(m.productId);
    const row = sheet.getRow(headerRowIndex + 1 + rowIdx);
    columns.forEach((c, i) => {
      const cell = row.getCell(i + 1);
      if (c.key === "cantidad") {
        cell.value = (m.tipo === "entrada" ? 1 : -1) * m.cantidad;
        cell.numFmt = '+0;-0;0';
      } else {
        cell.value = getReportColumnValue(c.key, m, p);
      }
      cell.font = { size: 9.5, color: { argb: "FF334155" } };
      cell.alignment = { vertical: "middle", horizontal: c.key === "cantidad" ? "right" : "left", wrapText: c.key === "nota" || c.key === "producto" };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: rowIdx % 2 === 0 ? "FFFFFFFF" : GREEN_LIGHT } };
      cell.border = { bottom: { style: "hair", color: { argb: BORDER } } };
    });
  });

  // ---- Fila de totales ----
  const totalIn = filtered.filter((m) => m.tipo === "entrada").reduce((s, m) => s + m.cantidad, 0);
  const totalOut = filtered.filter((m) => m.tipo === "salida").reduce((s, m) => s + m.cantidad, 0);
  const totalsRowIndex = headerRowIndex + 1 + filtered.length + 1;
  sheet.mergeCells(totalsRowIndex, 1, totalsRowIndex, colCount);
  const totalsCell = sheet.getCell(totalsRowIndex, 1);
  totalsCell.value = `Total entradas: +${totalIn}     Total salidas: -${totalOut}     Movimientos: ${filtered.length}`;
  totalsCell.font = { bold: true, size: 10, color: { argb: INK } };
  totalsCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: GREEN_LIGHT } };
  sheet.getRow(totalsRowIndex).height = 20;

  const footerRowIndex = totalsRowIndex + 2;
  sheet.mergeCells(footerRowIndex, 1, footerRowIndex, colCount);
  sheet.getCell(footerRowIndex, 1).value = "Generado con Boxly — Panel de control de inventario.";
  sheet.getCell(footerRowIndex, 1).font = { italic: true, size: 8, color: { argb: "FF94A3B8" } };

  columns.forEach((c, i) => {
    sheet.getColumn(i + 1).width = c.width;
  });
  sheet.views = [{ state: "frozen", ySplit: headerRowIndex }];
  sheet.autoFilter = {
    from: { row: headerRowIndex, column: 1 },
    to: { row: headerRowIndex, column: colCount }
  };

  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `boxly-reporte-movimientos-${new Date().toISOString().slice(0, 10)}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showToast("Reporte Excel generado.", "success");
}

/* ---------------------------- Firma digital: dibujo en el PDF ---------------------------- */
function drawSignatureSection(doc, startY, marginX, pageWidth) {
  const pageHeight = doc.internal.pageSize.getHeight();
  const boxHeight = 140;

  // Si no entra en la página actual, se agrega una nueva.
  if (startY + boxHeight + 40 > pageHeight - 40) {
    doc.addPage();
    startY = 50;
  }

  const disclaimerActive = document.getElementById("cfgFirmaDisclaimer").checked;
  let y = startY;

  doc.setDrawColor("#E2E8F0");
  doc.setLineWidth(0.75);
  doc.line(marginX, y, pageWidth - marginX, y);
  y += 18;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(9.5);
  doc.setTextColor("#0B2B26");
  doc.text("Firma digital — auditoría", marginX, y);
  y += 14;

  if (disclaimerActive) {
    const disclaimerText = document.getElementById("cfgFirmaDisclaimerTexto").value.trim();
    if (disclaimerText) {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(7.3);
      doc.setTextColor("#64748B");
      const wrapped = doc.splitTextToSize(disclaimerText, pageWidth - marginX * 2);
      doc.text(wrapped, marginX, y);
      y += wrapped.length * 9 + 12;
    }
  }

  const colWidth = (pageWidth - marginX * 2 - 20) / 2;
  const col1X = marginX;
  const col2X = marginX + colWidth + 20;
  const sigImgHeight = 55;

  [
    { canvasId: "sigPadA", nameId: "sigNameA", label: "Responsable de inventario", x: col1X },
    { canvasId: "sigPadB", nameId: "sigNameB", label: "Auditor / Receptor", x: col2X }
  ].forEach((sig) => {
    const canvas = document.getElementById(sig.canvasId);
    const nombre = document.getElementById(sig.nameId).value.trim();
    try {
      if (canvas && !isCanvasBlank(canvas)) {
        doc.addImage(canvas.toDataURL("image/png"), sig.x, y, colWidth, sigImgHeight);
      }
    } catch (err) {
      console.warn("No se pudo insertar la firma en el PDF.", err);
    }
    doc.setDrawColor("#CBD5E1");
    doc.setLineWidth(0.5);
    doc.line(sig.x, y + sigImgHeight + 6, sig.x + colWidth, y + sigImgHeight + 6);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(7.5);
    doc.setTextColor("#0B2B26");
    doc.text(nombre || "________________________", sig.x, y + sigImgHeight + 18);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(6.8);
    doc.setTextColor("#94A3B8");
    doc.text(sig.label, sig.x, y + sigImgHeight + 29);
    doc.text(`Fecha: ${new Date().toLocaleDateString("es-AR")}`, sig.x, y + sigImgHeight + 40);
  });

  return y + sigImgHeight + 55;
}

function isCanvasBlank(canvas) {
  const ctx = canvas.getContext("2d");
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] !== 0) return false;
  }
  return true;
}

/* ---------------------------- Firma digital: pads de dibujo (canvas) ---------------------------- */
function initSignaturePad(canvas) {
  if (!canvas || canvas.dataset.sigReady) return;
  canvas.dataset.sigReady = "true";
  const ctx = canvas.getContext("2d");
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  ctx.strokeStyle = "#0B2B26";
  let drawing = false;

  function getPos(evt) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const point = evt.touches ? evt.touches[0] : evt;
    return { x: (point.clientX - rect.left) * scaleX, y: (point.clientY - rect.top) * scaleY };
  }

  function start(evt) {
    drawing = true;
    const pos = getPos(evt);
    ctx.beginPath();
    ctx.moveTo(pos.x, pos.y);
    evt.preventDefault();
  }
  function move(evt) {
    if (!drawing) return;
    const pos = getPos(evt);
    ctx.lineTo(pos.x, pos.y);
    ctx.stroke();
    evt.preventDefault();
  }
  function end() {
    drawing = false;
  }

  canvas.addEventListener("mousedown", start);
  canvas.addEventListener("mousemove", move);
  window.addEventListener("mouseup", end);
  canvas.addEventListener("touchstart", start, { passive: false });
  canvas.addEventListener("touchmove", move, { passive: false });
  canvas.addEventListener("touchend", end);
}

function clearSignaturePad(canvasId) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

document.querySelectorAll("[data-clear-sig]").forEach((btn) => {
  btn.addEventListener("click", () => clearSignaturePad(btn.getAttribute("data-clear-sig")));
});

/* Interruptor que habilita/deshabilita el apartado de firmas en Reportes */
document.getElementById("cfgFirmaHabilitada").addEventListener("change", (e) => {
  const block = document.getElementById("signatureBlock");
  block.classList.toggle("hidden", !e.target.checked);
  if (e.target.checked) {
    initSignaturePad(document.getElementById("sigPadA"));
    initSignaturePad(document.getElementById("sigPadB"));
  }
});

document.getElementById("cfgFirmaDisclaimer").addEventListener("change", (e) => {
  document.getElementById("cfgFirmaDisclaimerTexto").classList.toggle("hidden", !e.target.checked);
});

document.getElementById("repGenerarPdf").addEventListener("click", generateMovementsPdf);
document.getElementById("repGenerarExcel").addEventListener("click", generateMovementsExcel);

/* =========================================================================
   ALERTAS
   ========================================================================= */
function renderAlertas() {
  const alerts = STORE.products.filter((p) => productStatus(p) !== "ok").sort((a, b) => a.stock - b.stock);
  const list = document.getElementById("alertsList");
  const empty = document.getElementById("alertsEmptyState");

  list.innerHTML = alerts
    .map((p) => {
      const status = productStatus(p);
      return `<div class="alert-card ${status}">
        <span class="alert-icon">
          <i data-lucide="${status === "critical" ? "alert-octagon" : "alert-triangle"}" class="h-4 w-4"></i>
        </span>
        <div class="flex-1">
          <p class="font-semibold text-sm text-ink">${p.nombre} <span class="text-xs text-slate-400 font-normal">· ${p.sku}</span></p>
          <p class="text-xs text-slate-500 mt-0.5">Quedan ${p.stock} unidades — el mínimo es ${p.stockMinimo}.</p>
        </div>
        <button class="btn-secondary shrink-0" data-restock="${p.id}">
          <i data-lucide="arrow-down-to-line" class="h-4 w-4"></i>
          Reponer
        </button>
      </div>`;
    })
    .join("");

  empty.classList.toggle("hidden", alerts.length > 0);
  refreshIcons();

  list.querySelectorAll("[data-restock]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-restock");
      switchSection("entradas");
      requestAnimationFrame(() => {
        document.getElementById("entradaProducto").value = id;
        document.getElementById("entradaCantidad").focus();
      });
    });
  });
}

/* =========================================================================
   USUARIOS
   ========================================================================= */
function roleBadgeColor(rol) {
  return { Administrador: "status-critical", Editor: "status-low", Visualizador: "status-ok" }[rol] || "status-ok";
}

function renderUsuarios() {
  const tbody = document.getElementById("usersTableBody");
  tbody.innerHTML = STORE.users
    .map(
      (u) => `<tr>
        <td class="font-medium text-ink">
          <span class="avatar-sm">${u.nombre.charAt(0)}</span>
          ${u.nombre}
        </td>
        <td class="text-slate-400">${u.email}</td>
        <td><span class="status-tag ${roleBadgeColor(u.rol)}">${u.rol}</span></td>
        <td class="text-right">
          ${u.rol === "Administrador" ? "" : `<button class="icon-btn danger" data-remove-user="${u.id}" aria-label="Eliminar"><i data-lucide="trash-2" class="h-4 w-4"></i></button>`}
        </td>
      </tr>`
    )
    .join("");

  refreshIcons();

  tbody.querySelectorAll("[data-remove-user]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const user = STORE.users.find((u) => u.id === btn.getAttribute("data-remove-user"));
      openConfirmModal(
        "Quitar usuario",
        `¿Seguro que querés quitar a <strong>${user.nombre}</strong> de tu cuenta de Boxly?`,
        "Quitar",
        () => {
          STORE.users = STORE.users.filter((u) => u.id !== user.id);
          saveStore();
          renderUsuarios();
          showToast("Usuario eliminado.", "success");
        }
      );
    });
  });
}

document.getElementById("openAddUser").addEventListener("click", () => {
  openModal(
    "Invitar usuario",
    `<form id="userForm" class="movement-form">
      <label class="form-label">Nombre</label>
      <input id="ufNombre" type="text" class="form-input" placeholder="Nombre y apellido" required>
      <label class="form-label">Email</label>
      <input id="ufEmail" type="email" class="form-input" placeholder="nombre@negocio.com" required>
      <label class="form-label">Rol</label>
      <select id="ufRol" class="form-input">
        <option value="Editor">Editor</option>
        <option value="Visualizador">Visualizador</option>
        <option value="Administrador">Administrador</option>
      </select>
      <button type="submit" class="btn-primary w-full justify-center mt-4">
        <i data-lucide="user-plus" class="h-4 w-4"></i>
        Invitar
      </button>
    </form>`,
    (body) => {
      body.querySelector("#userForm").addEventListener("submit", (e) => {
        e.preventDefault();
        STORE.users.push({
          id: uid("u"),
          nombre: body.querySelector("#ufNombre").value.trim(),
          email: body.querySelector("#ufEmail").value.trim(),
          rol: body.querySelector("#ufRol").value
        });
        saveStore();
        closeModal();
        renderUsuarios();
        showToast("Usuario invitado.", "success");
      });
    }
  );
});

/* =========================================================================
   CONFIGURACIÓN
   ========================================================================= */
function renderConfiguracion() {
  document.getElementById("cfgNombreNegocio").value = STORE.settings.nombreNegocio;
  document.getElementById("cfgMoneda").value = STORE.settings.moneda;
  document.getElementById("cfgStockMinimo").value = STORE.settings.stockMinimoDefault;
  document.getElementById("cfgNotificaciones").checked = STORE.settings.notificaciones;

  document.getElementById("cfgDireccion").value = STORE.settings.direccion || "";
  document.getElementById("cfgTelefono").value = STORE.settings.telefono || "";
  document.getElementById("cfgEmail").value = STORE.settings.email || "";
  document.getElementById("cfgFiscal").value = STORE.settings.fiscal || "";
  renderLogoPreview();
}

function renderLogoPreview() {
  const preview = document.getElementById("logoPreview");
  const removeBtn = document.getElementById("cfgLogoRemove");
  if (STORE.settings.logoBase64) {
    preview.innerHTML = `<img src="${STORE.settings.logoBase64}" alt="Logo del negocio">`;
    removeBtn.classList.remove("hidden");
  } else {
    preview.innerHTML = `<i data-lucide="image" class="h-5 w-5"></i>`;
    removeBtn.classList.add("hidden");
    refreshIcons();
  }
}

/* Un único formulario ("settingsForm") agrupa los datos del negocio Y los
   datos de la empresa para el PDF, con un solo botón de guardado. */
document.getElementById("settingsForm").addEventListener("submit", (e) => {
  e.preventDefault();
  STORE.settings.nombreNegocio = document.getElementById("cfgNombreNegocio").value.trim() || "Mi negocio";
  STORE.settings.moneda = document.getElementById("cfgMoneda").value;
  STORE.settings.stockMinimoDefault = parseInt(document.getElementById("cfgStockMinimo").value, 10) || 0;
  STORE.settings.notificaciones = document.getElementById("cfgNotificaciones").checked;

  STORE.settings.direccion = document.getElementById("cfgDireccion").value.trim();
  STORE.settings.telefono = document.getElementById("cfgTelefono").value.trim();
  STORE.settings.email = document.getElementById("cfgEmail").value.trim();
  STORE.settings.fiscal = document.getElementById("cfgFiscal").value.trim();

  saveStore();
  showToast("Configuración guardada.", "success");
  renderDashboard();
});

document.getElementById("cfgLogoBtn").addEventListener("click", () => {
  document.getElementById("cfgLogoInput").click();
});

document.getElementById("cfgLogoInput").addEventListener("change", (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;

  if (file.size > 1.5 * 1024 * 1024) {
    showToast("La imagen es muy pesada. Usá un logo de menos de 1.5 MB.", "error");
    e.target.value = "";
    return;
  }

  const reader = new FileReader();
  reader.onload = () => {
    STORE.settings.logoBase64 = reader.result; // dataURL base64, listo para usar en el PDF
    saveStore();
    renderLogoPreview();
    showToast("Logo actualizado.", "success");
  };
  reader.onerror = () => showToast("No se pudo leer la imagen.", "error");
  reader.readAsDataURL(file);
  e.target.value = "";
});

document.getElementById("cfgLogoRemove").addEventListener("click", () => {
  STORE.settings.logoBase64 = null;
  saveStore();
  renderLogoPreview();
  showToast("Logo quitado.", "success");
});

/* =========================================================================
   Scroll reveal (dashboard panels)
   ========================================================================= */
function initReveal() {
  const els = document.querySelectorAll("[data-reveal]");
  if (prefersReducedMotion) {
    els.forEach((el) => el.classList.add("in-view"));
    return;
  }
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("in-view");
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.1 }
  );
  els.forEach((el) => observer.observe(el));
}

/* =========================================================================
   Tour de bienvenida (onboarding)
   Se muestra automáticamente la primera vez que un usuario nuevo entra a la
   app (flag NEW_USER_FLAG seteado por login.js al registrarse). También se
   puede volver a ver manualmente desde Ayuda y soporte.
   ========================================================================= */
const TOUR_STEPS = [
  {
    icon: "layout-dashboard",
    title: "¡Bienvenido a Boxly!",
    desc: "Este es tu Dashboard: de un vistazo vas a ver el stock total, el valor de tu inventario y las alertas activas.",
    section: "dashboard",
    target: ".stat-card:first-child"
  },
  {
    icon: "pie-chart",
    title: "Inventario por categoría",
    desc: "Mirá cómo se reparte tu stock entre categorías para detectar rápido dónde tenés más volumen.",
    section: "dashboard",
    target: "#dashCategoryPanel"
  },
  {
    icon: "box",
    title: "Productos",
    desc: "Cargá tu catálogo completo con SKU, código de barras, categoría, stock y precio. Todo queda listo para escanear.",
    section: "productos",
    target: "#openAddProduct"
  },
  {
    icon: "scan-line",
    title: "Entradas y salidas",
    desc: "Registrá movimientos de stock escaneando con una pistola lectora o la cámara de tu celular. Rápido y sin errores.",
    section: "entradas",
    target: "#entradaScan"
  },
  {
    icon: "warehouse",
    title: "Inventario en tiempo real",
    desc: "Consultá el estado de cada producto — OK, bajo o crítico — y filtrá por lo que necesites revisar.",
    section: "inventario",
    target: "#inventarioStatusFilter"
  },
  {
    icon: "file-down",
    title: "Reportes en PDF",
    desc: "Filtrá por fecha, tipo y categoría, elegí las columnas y descargá un PDF prolijo con tu logo y tus datos.",
    section: "reportes",
    target: "#repGenerarPdf"
  },
  {
    icon: "file-spreadsheet",
    title: "Reportes en Excel",
    desc: "El mismo reporte, pero como planilla lista para trabajar: columnas separadas, encabezados en verde y tu logo.",
    section: "reportes",
    target: "#repGenerarExcel"
  },
  {
    icon: "pen-tool",
    title: "Firma digital para auditorías",
    desc: "Activá este interruptor para sumar firmas y un descargo de responsabilidad automático al PDF que descargues.",
    section: "reportes",
    target: "#panelFirmas .toggle-row"
  },
  {
    icon: "settings",
    title: "Configuración a tu medida",
    desc: "Personalizá moneda, stock mínimo, logo y datos de contacto de tu negocio en un solo lugar.",
    section: "configuracion",
    target: "#cfgLogoBtn"
  },
  {
    icon: "life-buoy",
    title: "Estamos para ayudarte",
    desc: "Si te trabás con algo, en Ayuda y soporte encontrás preguntas frecuentes y nuestros canales de contacto.",
    section: "ayuda",
    target: "#replayTourBtn"
  }
];

let tourIndex = 0;

/* Ubica el "agujero" del spotlight y la tarjeta pegados al campo real del paso,
   eligiendo arriba o abajo según dónde haya más espacio libre. */
function positionTourAround(targetEl) {
  const spotlight = document.getElementById("tourSpotlight");
  const box = document.getElementById("tourBox");

  if (!targetEl) {
    spotlight.classList.remove("is-visible");
    box.style.transform = "translate(-50%, -50%)";
    box.style.top = "50%";
    box.style.left = "50%";
    return;
  }

  const rect = targetEl.getBoundingClientRect();
  const pad = 8;
  spotlight.style.width = `${rect.width + pad * 2}px`;
  spotlight.style.height = `${rect.height + pad * 2}px`;
  spotlight.style.top = `${rect.top - pad}px`;
  spotlight.style.left = `${rect.left - pad}px`;
  spotlight.classList.add("is-visible");

  const boxRect = box.getBoundingClientRect();
  const margin = 14;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const spaceBelow = vh - rect.bottom;
  const spaceAbove = rect.top;

  let top;
  if (spaceBelow >= boxRect.height + margin || spaceBelow >= spaceAbove) {
    top = rect.bottom + margin;
  } else {
    top = rect.top - boxRect.height - margin;
  }
  top = Math.min(Math.max(top, 12), vh - boxRect.height - 12);

  let left = rect.left + rect.width / 2 - boxRect.width / 2;
  left = Math.min(Math.max(left, 12), vw - boxRect.width - 12);

  box.style.transform = "none";
  box.style.top = `${top}px`;
  box.style.left = `${left}px`;
}

function currentTourTarget() {
  const step = TOUR_STEPS[tourIndex];
  return step && step.target ? document.querySelector(step.target) : null;
}

function handleTourReposition() {
  if (!document.getElementById("tourBackdrop").classList.contains("is-open")) return;
  positionTourAround(currentTourTarget());
}

function renderTourStep() {
  const step = TOUR_STEPS[tourIndex];
  document.getElementById("tourIcon").innerHTML = `<i data-lucide="${step.icon}"></i>`;
  document.getElementById("tourTitle").textContent = step.title;
  document.getElementById("tourDesc").textContent = step.desc;

  const dots = document.getElementById("tourDots");
  dots.innerHTML = TOUR_STEPS.map((_, i) => `<span class="tour-dot ${i === tourIndex ? "active" : ""}"></span>`).join("");

  const prevBtn = document.getElementById("tourPrev");
  const nextBtn = document.getElementById("tourNext");
  prevBtn.style.visibility = tourIndex === 0 ? "hidden" : "visible";
  nextBtn.innerHTML = tourIndex === TOUR_STEPS.length - 1
    ? `¡Empezar! <i data-lucide="check" class="h-4 w-4"></i>`
    : `Siguiente <i data-lucide="arrow-right" class="h-4 w-4"></i>`;

  refreshIcons();

  // Lleva a la sección real del paso para poder enfocar el campo correspondiente.
  if (step.section) switchSection(step.section, { keepScroll: true });

  const targetEl = step.target ? document.querySelector(step.target) : null;
  if (targetEl) {
    targetEl.scrollIntoView({ block: "center", behavior: prefersReducedMotion ? "auto" : "smooth" });
  }
  setTimeout(() => positionTourAround(targetEl), prefersReducedMotion ? 20 : 320);
}

function openTour() {
  tourIndex = 0;
  document.getElementById("tourBackdrop").classList.add("is-open");
  renderTourStep();
  window.addEventListener("resize", handleTourReposition);
  window.addEventListener("scroll", handleTourReposition, true);
}

function closeTour() {
  document.getElementById("tourBackdrop").classList.remove("is-open");
  document.getElementById("tourSpotlight").classList.remove("is-visible");
  localStorage.setItem(TOUR_DONE_FLAG, "true");
  localStorage.removeItem(NEW_USER_FLAG);
  window.removeEventListener("resize", handleTourReposition);
  window.removeEventListener("scroll", handleTourReposition, true);
}

document.getElementById("tourNext").addEventListener("click", () => {
  if (tourIndex === TOUR_STEPS.length - 1) {
    closeTour();
    return;
  }
  tourIndex++;
  renderTourStep();
});
document.getElementById("tourPrev").addEventListener("click", () => {
  if (tourIndex === 0) return;
  tourIndex--;
  renderTourStep();
});
document.getElementById("tourSkip").addEventListener("click", closeTour);

const replayBtn = document.getElementById("replayTourBtn");
if (replayBtn) replayBtn.addEventListener("click", openTour);

function initOnboardingTour() {
  const isNewUser = localStorage.getItem(NEW_USER_FLAG) === "true";
  const alreadySeen = localStorage.getItem(TOUR_DONE_FLAG) === "true";
  if (isNewUser && !alreadySeen) {
    setTimeout(openTour, 500);
  }
}

/* =========================================================================
   Init
   ========================================================================= */
document.addEventListener("DOMContentLoaded", () => {
  lucide.createIcons();
  initReveal();
  renderAuthUser();
  renderDashboard();
  initOnboardingTour();
});
