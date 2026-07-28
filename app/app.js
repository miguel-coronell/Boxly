/* =========================================================================
   BOXLY — Panel de control
   Estado persistido en localStorage. Sin backend: todo corre en el navegador.
   (ver firebase-config.js / login.html para la integración de autenticación)
   ========================================================================= */

const STORAGE_KEY_PREFIX = "boxly_app_data_v1";
/* FIX (seguridad multi-cuenta / fuga de datos entre negocios): antes
   STORAGE_KEY era una única clave fija de localStorage, compartida por
   CUALQUIER cuenta que iniciara sesión en ese mismo navegador. La sección
   "Usuarios" (STORE.users, más abajo) todavía vive enteramente en
   localStorage —a diferencia de "Encargados de sucursal", que ya está
   migrado a Firestore y filtrado por negocioId—, así que si en algún momento
   se probaron cuentas de distintos Administradores en la misma PC, la
   segunda cuenta heredaba la lista de usuarios "invitados" de la primera sin
   darse cuenta: cada negocio terminaba viendo usuarios que no eran suyos.
   Ahora la clave de localStorage se arma con el uid de la cuenta logueada
   (getStorageKey()), así que cada cuenta tiene su propio balde de datos
   locales, sin mezclarse con los de otra cuenta que haya usado el mismo
   navegador antes. Se calcula en el momento de leer/guardar (no una sola vez
   al cargar el script) porque CURRENT_USER recién queda asignado más abajo. */
function getStorageKey() {
  return CURRENT_USER && CURRENT_USER.uid ? `${STORAGE_KEY_PREFIX}_${CURRENT_USER.uid}` : STORAGE_KEY_PREFIX;
}
const AUTH_KEY = "boxly_auth_user";
const NEW_USER_FLAG = "boxly_new_user";
const TOUR_DONE_FLAG = "boxly_onboarding_done";

/* ---------------------------- Autenticación (guard) ----------------------------
   Si no hay sesión iniciada, se redirige a login.html.

   CURRENT_USER se sigue llenando de forma SÍNCRONA desde localStorage (como antes)
   para que el resto del archivo -que lo usa en decenas de funciones- no tenga que
   volverse asíncrono de punta a punta. Lo que cambia acá es que, con Firebase
   configurado, ADEMÁS verificamos en paralelo que esa sesión sea real contra
   firebase.auth().onAuthStateChanged(): si Firebase dice que no hay usuario logueado
   (por ejemplo, alguien pisó el localStorage a mano, o el token expiró), se cierra
   la sesión local y se redirige a login.html, aunque el localStorage "dijera" que
   había sesión. Esto tapa el hueco de seguridad de confiar ciegamente en localStorage,
   sin tener que reescribir el resto de la app en esta etapa. */
function getAuthUser() {
  try {
    const raw = localStorage.getItem(AUTH_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    return null;
  }
}

let CURRENT_USER = getAuthUser();
if (!CURRENT_USER) {
  window.location.replace("login.html");
}

if (isFirebaseReady()) {
  initFirebase().onAuthStateChanged((firebaseUser) => {
    if (!firebaseUser) {
      // Firebase no tiene sesión real: el localStorage no vale, se cierra todo.
      localStorage.removeItem(AUTH_KEY);
      window.location.replace("login.html");
      return;
    }
    /* FIX: antes, iniciarSincronizacionFirestore() se llamaba suelta al final
       del archivo (fuera de este callback), apenas cargaba el script — sin
       esperar a que Firebase confirmara la sesión ni a que se reparen/creen
       los documentos users/{uid} y negocios/{uid} de la cuenta. En una cuenta
       recién registrada eso genera una carrera real: Firestore puede recibir
       la primera lectura antes de que el documento del negocio exista, responde
       permission-denied, y como onSnapshot no reintenta solo, el toast de
       error "no se pudieron sincronizar los productos" queda pegado aunque
       medio segundo después todo esté en orden. Ahora encadenamos: primero
       reparar/crear documentos, y recién cuando esa promesa resuelve (o falla)
       nos suscribimos a Firestore. */
    repararDocumentosDeCuentaVieja(firebaseUser).finally(() => {
      iniciarSincronizacionFirestore();
    });
  });
}

/* ---------------------------- Paso 6F: auto-reparación ----------------------------
   Cuentas creadas ANTES del Paso 6A tienen usuario real en Firebase Auth pero NUNCA
   se les creó users/{uid} ni negocios/{uid} (ese código no existía todavía). Sin este
   arreglo, iniciarSincronizacionFirestore() de más abajo fallaría silenciosamente:
   NEGOCIO_ID terminaría valiendo el propio uid igual (por el "|| CURRENT_USER.uid"),
   pero negocios/{uid} no existiría, así que todos los onSnapshot no traerían nada.
   Se corre una sola vez por sesión, antes de iniciarSincronizacionFirestore(). */
function repararDocumentosDeCuentaVieja(firebaseUser) {
  const db = getFirestoreDb();
  const userRef = db.collection("users").doc(firebaseUser.uid);
  return userRef.get().then((userDoc) => {
    if (userDoc.exists) return; // cuenta ya migrada, no hace falta nada
    console.warn("Cuenta vieja sin users/{uid}: creando documentos por defecto.", firebaseUser.uid);
    const batch = db.batch();
    batch.set(userRef, {
      nombre: firebaseUser.displayName || (firebaseUser.email ? firebaseUser.email.split("@")[0] : "Administrador"),
      email: firebaseUser.email || "",
      negocioId: firebaseUser.uid,
      rol: "Administrador",
      sucursalId: null
    });
    batch.set(db.collection("negocios").doc(firebaseUser.uid), {
      nombreNegocio: "Mi negocio",
      moneda: "ARS",
      stockMinimoDefault: 10,
      notificaciones: true,
      trialStart: firebase.firestore.FieldValue.serverTimestamp(),
      plan: null,
      paidUntil: null,
      tier: "basico"
    }, { merge: true }); // merge: si negocios/{uid} ya existía por algún motivo, no lo pisa
    return batch.commit();
  }).catch((err) => console.error("No se pudo verificar/reparar los documentos de la cuenta.", err));
}

/* ---------------------------- Datos del negocio en Firestore (Pasos 6B/6C/6D) ----------------------------
   NEGOCIO_ID es el id del documento en negocios/{negocioId}. Para el Administrador
   coincide con su propio uid (así se crea en el registro, ver login.js), pero para un
   encargado invitado es distinto de su uid -> hay que leerlo primero de su propio
   documento users/{uid}. Recién con NEGOCIO_ID confirmado nos suscribimos con onSnapshot
   a cada subcolección, que mantiene el STORE correspondiente sincronizado en tiempo real
   y dispara los mismos render*() que ya existían. Todo esto no corre en modo demo
   (sin Firebase configurado): ahí STORE sigue viniendo de localStorage como siempre. */
let NEGOCIO_ID = null;
let unsubscribeProductos = null;
let unsubscribeMovimientos = null;
let unsubscribeSucursales = null;
let unsubscribeEncargados = null;
let unsubscribeTrasladosOrigen = null;
let unsubscribeTrasladosDestino = null;

function iniciarSincronizacionFirestore() {
  if (!isFirebaseReady() || !CURRENT_USER) return;
  const db = getFirestoreDb();
  db.collection("users").doc(CURRENT_USER.uid).get()
    .then((userDoc) => {
      NEGOCIO_ID = (userDoc.exists && userDoc.data().negocioId) || CURRENT_USER.uid;
      // Recién acá sabemos, con certeza, si quien inició sesión es el Administrador
      // dueño de la cuenta o un encargado invitado — y si es encargado, a qué
      // sucursal quedó limitado. Hasta este punto, ensureOwnerUser() lo había
      // dejado en un estado "pendiente" sin permisos (fail-closed).
      if (userDoc.exists) syncCurrentUserFromFirestore(userDoc.data());
      suscribirProductosFirestore(db);
      suscribirMovimientosFirestore(db);
      suscribirSucursalesFirestore(db);
      suscribirNegocioFirestore(db);
      suscribirEncargadosFirestore(db);
      suscribirTrasladosFirestore(db);
      // El Panel Creador (que escuchaba TODOS los negocios de Boxly) se sacó:
      // la cuenta creadora ahora funciona como un Administrador normal, con
      // plan ilimitado (ver isCreatorAccount() en getPlanLimits()), sin una
      // pantalla aparte para administrar otras cuentas.
    })
    .catch((err) => console.error("No se pudo leer el negocioId del usuario.", err));
}

/* FIX: permission-denied puede ser transitorio (p.ej. el documento del
   negocio recién se está creando en Firestore cuando esta suscripción
   arranca). onSnapshot deja de escuchar apenas dispara su callback de error
   y no reintenta solo, así que antes cualquier permission-denied momentáneo
   dejaba el toast de error pegado para siempre aunque todo se resolviera un
   instante después. Ahora, solo para ese código de error puntual, reintentamos
   una vez tras una pequeña espera antes de mostrar el error al usuario. */
function suscribirProductosFirestore(db, _retried) {
  if (unsubscribeProductos) unsubscribeProductos();
  unsubscribeProductos = db.collection("negocios").doc(NEGOCIO_ID).collection("productos")
    .onSnapshot(
      (snapshot) => {
        STORE.products = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
        renderProductos();
        renderDashboard();
        renderTraslados();
      },
      (err) => {
        console.error("Error escuchando productos en Firestore.", err);
        if (err.code === "permission-denied" && !_retried) {
          setTimeout(() => suscribirProductosFirestore(db, true), 1500);
          return;
        }
        showToast("No se pudieron sincronizar los productos. Revisá tu conexión.", "error");
      }
    );
}

/* Paso 6C: movimientos en tiempo real. El stock de cada producto se actualiza
   con runTransaction() dentro de registerMovement(), no acá — este listener solo
   refleja en pantalla lo que ya quedó confirmado en Firestore.

   FIX (encargados no veían Entradas/Salidas): este listener escuchaba TODA la
   colección "movimientos" del negocio sin filtro. Las Firestore Rules exigen
   que, para un encargado (esEncargado()), CADA documento que devuelva la query
   tenga su misma sucursalId — pero como acá no había ningún .where("sucursalId",
   "==", ...), la query intentaba traer movimientos de TODAS las sucursales, la
   regla rechazaba los que no eran de la suya, y Firestore denegaba la consulta
   COMPLETA con permission-denied (así funcionan los queries de Firestore: si
   un solo documento no cumple la regla, se cae toda la lista, no solo ese
   documento). Por eso a los invitados el historial de salidas/entradas no se
   actualizaba nunca. La solución es agregar acá el mismo filtro que ya exige
   la regla: si el usuario logueado tiene una sucursal fija (no es
   Administrador), se agrega .where("sucursalId","==", esa sucursal). */
function suscribirMovimientosFirestore(db, _retried) {
  if (unsubscribeMovimientos) unsubscribeMovimientos();
  const sucursalFija = currentUserSucursalId();
  let query = db.collection("negocios").doc(NEGOCIO_ID).collection("movimientos");
  if (sucursalFija) query = query.where("sucursalId", "==", sucursalFija);
  unsubscribeMovimientos = query
    .onSnapshot(
      (snapshot) => {
        STORE.movements = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
        renderEntradas();
        renderSalidas();
        renderDashboard();
      },
      (err) => {
        console.error("Error escuchando movimientos en Firestore.", err);
        if (err.code === "permission-denied" && !_retried) {
          setTimeout(() => suscribirMovimientosFirestore(db, true), 1500);
          return;
        }
        showToast("No se pudieron sincronizar los movimientos. Revisá tu conexión.", "error");
      }
    );
}

/* =========================================================================
   Reiniciar historial de movimientos ("Reiniciar movimientos" en
   Configuración, y desde Panel Creador para cualquier negocio)
   =========================================================================
   Borra SOLO los documentos de negocios/{negocioId}/movimientos — no toca
   productos, stock, sucursales ni configuración. El stock de cada producto
   no se recalcula a partir del historial (se actualiza al momento con
   runTransaction() dentro de registerMovement()), así que borrar el
   historial no altera el stock actual: únicamente limpia el registro de
   entradas/salidas que se ve en Dashboard, Entradas, Salidas y Reportes.
   Se borra en tandas de 450 (el límite real de un batch de Firestore es 500)
   porque un negocio con mucho historial puede superar ese límite de una. */
function borrarMovimientosDeNegocio(db, negocioId) {
  const coleccion = db.collection("negocios").doc(negocioId).collection("movimientos");
  function borrarTanda() {
    return coleccion.limit(450).get().then((snapshot) => {
      if (snapshot.empty) return;
      const batch = db.batch();
      snapshot.docs.forEach((doc) => batch.delete(doc.ref));
      return batch.commit().then(() => borrarTanda());
    });
  }
  return borrarTanda();
}

/* Reinicia el historial de movimientos del negocio del Administrador logueado
   (NEGOCIO_ID). No necesita el backend serverless: las Firestore Rules ya
   permiten a un Administrador borrar en las subcolecciones de SU propio
   negocio. */
function reiniciarMovimientos(negocioId) {
  if (!isFirebaseReady()) {
    // ---- Modo demo (sin Firebase) ----
    STORE.movements = [];
    saveStore();
    renderEntradas();
    renderSalidas();
    renderDashboard();
    showToast("Se reinició el historial de movimientos.", "success");
    return Promise.resolve();
  }
  const db = getFirestoreDb();
  const objetivo = negocioId || NEGOCIO_ID;
  return borrarMovimientosDeNegocio(db, objetivo)
    .then(() => showToast("Se reinició el historial de movimientos.", "success"))
    .catch((err) => {
      console.error("No se pudo reiniciar el historial de movimientos.", err);
      showToast("No se pudo reiniciar el historial. Probá de nuevo.", "error");
    });
}

/* Paso 6D (sucursales): mismo patrón que productos/movimientos. */
function suscribirSucursalesFirestore(db, _retried) {
  if (unsubscribeSucursales) unsubscribeSucursales();
  unsubscribeSucursales = db.collection("negocios").doc(NEGOCIO_ID).collection("sucursales")
    .onSnapshot(
      (snapshot) => {
        STORE.sucursales = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
        renderSucursales();
        renderUsuarios();
      },
      (err) => {
        console.error("Error escuchando sucursales en Firestore.", err);
        if (err.code === "permission-denied" && !_retried) {
          setTimeout(() => suscribirSucursalesFirestore(db, true), 1500);
          return;
        }
        showToast("No se pudieron sincronizar las sucursales. Revisá tu conexión.", "error");
      }
    );
}

/* Traslados: mismo problema que ya se resolvió en movimientos, pero con dos
   campos de sucursal en vez de uno (sucursalOrigenId / sucursalDestinoId).
   Un encargado puede necesitar ver un traslado tanto si su sucursal es el
   ORIGEN (para saber que ya salió mercadería) como si es el DESTINO (para
   recibirlo) — y las reglas exigen que la query venga filtrada por uno de
   los dos, o Firestore deniega el listado completo. El SDK compat no permite
   un OR directo entre dos campos distintos, así que se arman dos listeners
   (uno por cada campo) y se combinan en un mismo Map por id. Para el
   Administrador alcanza con un único listener sin filtrar: ve todo su negocio. */
function suscribirTrasladosFirestore(db, _retried) {
  if (unsubscribeTrasladosOrigen) unsubscribeTrasladosOrigen();
  if (unsubscribeTrasladosDestino) unsubscribeTrasladosDestino();
  const sucursalFija = currentUserSucursalId();
  const coleccion = db.collection("negocios").doc(NEGOCIO_ID).collection("traslados");

  function onError(err) {
    console.error("Error escuchando traslados en Firestore.", err);
    if (err.code === "permission-denied" && !_retried) {
      setTimeout(() => suscribirTrasladosFirestore(db, true), 1500);
      return;
    }
    showToast("No se pudieron sincronizar los traslados. Revisá tu conexión.", "error");
  }

  if (!sucursalFija) {
    unsubscribeTrasladosOrigen = coleccion.onSnapshot((snapshot) => {
      STORE.traslados = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
      renderTraslados();
    }, onError);
    return;
  }

  const mapa = new Map();
  function actualizar() {
    STORE.traslados = Array.from(mapa.values());
    renderTraslados();
  }
  function aplicarCambios(snapshot) {
    snapshot.docChanges().forEach((change) => {
      if (change.type === "removed") mapa.delete(change.doc.id);
      else mapa.set(change.doc.id, { id: change.doc.id, ...change.doc.data() });
    });
    actualizar();
  }
  unsubscribeTrasladosOrigen = coleccion.where("sucursalOrigenId", "==", sucursalFija).onSnapshot(aplicarCambios, onError);
  unsubscribeTrasladosDestino = coleccion.where("sucursalDestinoId", "==", sucursalFija).onSnapshot(aplicarCambios, onError);
}


/* Paso 6D (configuración) + Paso 6E (plan/trial): un solo listener sobre el documento
   negocios/{NEGOCIO_ID}, porque ahí viven tanto los datos de "Configuración" como
   trialStart/plan/paidUntil/tier que ya crea login.js al registrarse. */
let NEGOCIO_TRIAL = { trialStart: null, plan: null, paidUntil: null, tier: "basico" };
let unsubscribeNegocio = null;

function suscribirNegocioFirestore(db) {
  if (unsubscribeNegocio) unsubscribeNegocio();
  unsubscribeNegocio = db.collection("negocios").doc(NEGOCIO_ID)
    .onSnapshot(
      (doc) => {
        if (!doc.exists) return;
        const data = doc.data();
        STORE.settings = {
          nombreNegocio: data.nombreNegocio || "Mi negocio",
          moneda: data.moneda || "ARS",
          stockMinimoDefault: data.stockMinimoDefault ?? 10,
          notificaciones: data.notificaciones !== false,
          logoBase64: data.logoBase64 || null,
          direccion: data.direccion || "",
          telefono: data.telefono || "",
          email: data.email || "",
          fiscal: data.fiscal || ""
        };
        NEGOCIO_TRIAL = {
          trialStart: data.trialStart && data.trialStart.toDate ? data.trialStart.toDate().toISOString() : (data.trialStart || new Date().toISOString()),
          plan: data.plan || null,
          paidUntil: data.paidUntil && data.paidUntil.toDate ? data.paidUntil.toDate().toISOString() : (data.paidUntil || null),
          tier: data.tier || "basico"
        };
        renderDashboard();
        renderTrialBanner();
        if (document.getElementById("cfgNombreNegocio")) renderConfiguracion();
        if (typeof renderMiPlan === "function" && document.getElementById("section-mi-plan")) renderMiPlan();
      },
      (err) => console.error("Error escuchando el documento del negocio en Firestore.", err)
    );
}



const CREATOR_EMAIL = "miguelcoronell94@gmail.com";
function isCreatorAccount() {
  return !!(CURRENT_USER && CURRENT_USER.email && CURRENT_USER.email.toLowerCase() === CREATOR_EMAIL);
}
const CATEGORY_COLORS = ["#0E6B4F", "#22C55E", "#15803D", "#D7F205", "#B98A5E", "#94A3B8"];


/* ---------------------------- Prueba gratis (7 días) + Paywall ----------------------------*/
  
const TRIAL_KEY = "boxly_trial_v1";
const TRIAL_DAYS = 7;
const PLAN_PRICES = {
  mensual: { label: "Mensual", days: 30 },
  semestral: { label: "Semestral", days: 182 },
  anual: { label: "Anual", days: 365 }
};

function getTrialStore() {
  try {
    return JSON.parse(localStorage.getItem(TRIAL_KEY) || "{}");
  } catch (err) {
    return {};
  }
}
function saveTrialStore(store) {
  localStorage.setItem(TRIAL_KEY, JSON.stringify(store));
}
function ensureTrial(uid) {
  const store = getTrialStore();
  if (!store[uid]) {
    store[uid] = { start: new Date().toISOString(), plan: null, paidUntil: null };
    saveTrialStore(store);
  }
  return store[uid];
}
function getTrialStatus(uid) {
  if (isFirebaseReady() && NEGOCIO_ID) {
    const now = new Date();
    const start = NEGOCIO_TRIAL.trialStart ? new Date(NEGOCIO_TRIAL.trialStart) : now;
    const daysUsed = Math.floor((now - start) / 86400000);
    const daysLeft = Math.max(TRIAL_DAYS - daysUsed, 0);
    const isPaid = !!(NEGOCIO_TRIAL.paidUntil && new Date(NEGOCIO_TRIAL.paidUntil) > now);
    const expired = !isPaid && daysUsed >= TRIAL_DAYS;
    return { daysUsed, daysLeft, isPaid, expired, plan: NEGOCIO_TRIAL.plan };
  }
  // ---- Modo demo (sin Firebase) ----
  const store = getTrialStore();
  const data = store[uid] || ensureTrial(uid);
  const now = new Date();
  const start = new Date(data.start);
  const daysUsed = Math.floor((now - start) / 86400000);
  const daysLeft = Math.max(TRIAL_DAYS - daysUsed, 0);
  const isPaid = !!(data.paidUntil && new Date(data.paidUntil) > now);
  const expired = !isPaid && daysUsed >= TRIAL_DAYS;
  return { daysUsed, daysLeft, isPaid, expired, plan: data.plan };
}

/* IMPORTANTE — leído antes de tocar esta función:
   Con Firebase configurado, esta función YA NO escribe el plan en Firestore desde
   el navegador. Es a propósito: dejar que el cliente se auto-marque "pagado" es
   inseguro (cualquiera podría abrir la consola y llamar markPlanPaid() para
   desbloquearse gratis). En producción real, el único que debe escribir
   plan/paidUntil/tier en negocios/{negocioId} es el webhook de PayPal
   (api/paypal-webhook.js, con Firebase Admin SDK, verificando el pago del lado
   del servidor) — ese archivo no está entre los que me pasaste, así que no lo
   inventé. Avisame si querés que lo armemos.
   Mientras tanto, en modo Firebase esta función solo muestra un aviso; el cambio
   de plan real no se refleja hasta que ese webhook exista (o hasta que edites el
   documento a mano en la consola de Firestore para probar). */
function markPlanPaid(uid, planKey, tier) {
  const plan = PLAN_PRICES[planKey];
  const paidUntil = new Date(Date.now() + plan.days * 86400000).toISOString();
  const resolvedTier = tier || NEGOCIO_TRIAL.tier || "pro";

  if (isFirebaseReady() && NEGOCIO_ID) {
    console.warn("markPlanPaid(): en modo Firebase esto no escribe el plan; falta el webhook de PayPal (ver comentario arriba de esta función).");
    showToast("Pago recibido por PayPal. Tu plan se actualiza en cuanto se confirme del lado del servidor.", "success");
    return;
  }

  // ---- Modo demo (sin Firebase) ----
  const store = getTrialStore();
  store[uid] = { ...(store[uid] || {}), plan: planKey, paidUntil, tier: resolvedTier };
  saveTrialStore(store);
  document.body.classList.remove("trial-expired-lock");
  sidebarLinks.forEach((link) => (link.disabled = false));
}

function renderTrialBanner() {
  const banner = document.getElementById("trialBanner");
  if (!banner || !CURRENT_USER) return;
  if (isCreatorAccount()) {
    banner.classList.add("hidden");
    return;
  }
  const status = getTrialStatus(CURRENT_USER.uid);
  if (status.isPaid || status.expired) {
    banner.classList.add("hidden");
    return;
  }
  banner.classList.remove("hidden");
  document.getElementById("trialBannerText").textContent =
    status.daysLeft === 0
      ? "Tu prueba gratis termina hoy."
      : `Prueba gratis: te quedan ${status.daysLeft} día${status.daysLeft === 1 ? "" : "s"}.`;
}



function initTrialGuard() {
  if (!CURRENT_USER) return;
  if (isCreatorAccount()) {
    document.getElementById("trialBanner").classList.add("hidden");
    return; // la cuenta creadora nunca se bloquea ni ve el banner de prueba
  }
  ensureTrial(CURRENT_USER.uid);
  const status = getTrialStatus(CURRENT_USER.uid);
  renderTrialBanner();
  if (status.expired) lockToMiPlan();
}

/* Bloquea la navegación a cualquier sección que no sea "Mi Plan" o "Ayuda y soporte"
   mientras la cuenta no tenga un plan pago activo. Sin modal simulado: el usuario
   ve directamente la pantalla real de planes con los botones de PayPal. */
function lockToMiPlan() {
  document.body.classList.add("trial-expired-lock");
  sidebarLinks.forEach((link) => {
    const target = link.getAttribute("data-target");
    if (target !== "mi-plan" && target !== "ayuda") link.disabled = true;
  });
  switchSection("mi-plan");
}

/* =========================================================================
   REQUERIMIENTO 1 y 2 — "Mi Plan": tiers, límites de uso y bloqueo por plan
   =========================================================================
   Estos límites hoy viven en localStorage (junto con TRIAL_KEY) para que la demo
   funcione sin backend. En producción, "tier", "maxSucursales/Productos/Documentos"
   y "proximoPago" deben guardarse en el documento Firestore usuarios/{uid} del
   Administrador, y actualizarse SOLO desde el webhook de PayPal (api/paypal-webhook.js),
   nunca desde el navegador. Acá los dejamos igual de forma para que sea un
   reemplazo directo: cambiá getPlanLimits()/getTrialStatus() por una lectura de
   Firestore (onSnapshot sobre usuarios/{uid}) y el resto del código no cambia. */
const PLAN_TIERS = {
  basico: {
    label: "Plan Básico",
    priceLabel: "$12 <span>USD/mes</span>",
    maxSucursales: 1,
    maxProductos: 100,
    maxDocumentos: 200
  },
  pro: {
    label: "Plan Pro",
    priceLabel: "$18 <span>USD/mes</span>",
    maxSucursales: 5,
    maxProductos: 1000,
    maxDocumentos: 2000
  },
  premium: {
    label: "Plan Premium",
    priceLabel: "$25 <span>USD/mes</span>",
    maxSucursales: Infinity,
    maxProductos: Infinity,
    maxDocumentos: Infinity
  }
};

/* -------- PayPal (botones de suscripción reales) --------
   Completá estos dos valores para activar los botones reales de PayPal en "Mi Plan".
   - PAYPAL_CLIENT_ID: Client ID de tu app de PayPal (modo Live o Sandbox).
   - PAYPAL_PLAN_IDS: los "Plan ID" (empiezan con "P-...") que creaste en el
     dashboard de PayPal (Productos y servicios > Suscripciones) para cada tier.
   Mientras estén vacíos, la sección "Mi Plan" muestra el botón de demo en su lugar. */
const PAYPAL_CLIENT_ID = "BAA31DAp59ie21ISL1LdlIdz7m0T9H0OA5gg8Lc0OVIvvesRmT2_Z2e_qpfGIHEIjM6pQDmKOvOns5Lpp0"; // Client ID PayPal Live
const PAYPAL_PLAN_IDS = {
  basico: "P-2U160925B7282271CNJPSM3A",
  pro: "P-40H79840DY636180TNJPSLYY",
  premium: "P-93064402D0889823NNJPSKWQ"
};

function getTrialTier(uid) {
  if (isFirebaseReady() && NEGOCIO_ID) return NEGOCIO_TRIAL.tier || "basico";
  const store = getTrialStore();
  return (store[uid] && store[uid].tier) || "basico";
}

/* Límites del plan del usuario logueado. Si todavía está en período de prueba,
   usamos los límites del plan "pro" para que pueda probar sucursales múltiples. */


function getPlanLimits() {
  if (!CURRENT_USER) return PLAN_TIERS.basico;
  if (isCreatorAccount()) return PLAN_TIERS.premium; // ver punto 3.4 más abajo
  const status = getTrialStatus(CURRENT_USER.uid);
  if (!status.isPaid && !status.expired) return PLAN_TIERS.basico; // límites reales de la prueba
  const tier = getTrialTier(CURRENT_USER.uid);
  return PLAN_TIERS[tier] || PLAN_TIERS.basico;
}



function getPlanUsage() {
  return {
    sucursales: STORE.sucursales.length,
    productos: STORE.products.length,
    documentos: STORE.movements.length
  };
}

/* Función centralizada (Requerimiento 2). Se llama ANTES de abrir los modales
   de "Crear producto" / "Crear sucursal". type: "producto" | "sucursal" */
function checkPlanLimits(type) {
  const limits = getPlanLimits();
  const usage = getPlanUsage();
  const map = {
    producto: { used: usage.productos, max: limits.maxProductos, label: "productos" },
    sucursal: { used: usage.sucursales, max: limits.maxSucursales, label: "sucursales" },
    documento: { used: usage.documentos, max: limits.maxDocumentos, label: "documentos" }
  };
  const c = map[type];
  return { allowed: c.used < c.max, used: c.used, max: c.max, label: c.label };
}

/* Banner de aviso que se inserta arriba del formulario cuando el límite ya se superó,
   más el modal de upgrade que se abre en simultáneo invitando a mejorar el plan. */
function limitBannerHtml(check) {
  const maxLabel = check.max === Infinity ? "∞" : check.max;
  return `<div class="limit-banner">
    <i data-lucide="lock" class="h-4 w-4"></i>
    <div>
      Llegaste al límite de tu plan (${check.used}/${maxLabel} ${check.label}). Para seguir creando, mejorá tu plan.
      <div class="limit-banner-actions">
        <button type="button" class="btn-primary" id="limitBannerUpgradeBtn">
          <i data-lucide="arrow-up-circle" class="h-3.5 w-3.5"></i> Ver planes
        </button>
      </div>
    </div>
  </div>`;
}

/* Modal aparte que invita a mejorar el plan, con el mismo mecanismo de PayPal
   que ya usa el paywall. Se abre junto con el modal de creación bloqueado. */
function openUpgradeModal(check) {
  const maxLabel = check.max === Infinity ? "∞" : check.max;
  openModal(
    "Actualizá tu plan",
    `<div class="movement-form">
      <p class="text-sm text-slate-600">Superaste el límite de <strong>${check.label}</strong> de tu plan actual (${check.used}/${maxLabel}). Elegí un plan superior para seguir creciendo con Boxly.</p>
      <div class="paywall-plans mt-4" style="grid-template-columns:1fr 1fr;">
        <button type="button" class="btn-paypal" data-upgrade-tier="pro">
          <svg viewBox="0 0 24 24" class="paypal-mark" aria-hidden="true"><path fill="currentColor" d="M8.5 20.6 9.8 13H7l.4-2.5C8 6.7 9.9 5 13.6 5c2.5 0 4.4.8 4.4 3 0 .5-.1 1-.2 1.5 1.2.7 1.9 1.9 1.7 3.6-.4 3-2.7 4.6-6 4.6h-1.4l-.7 4-2.9-1.1Z"/></svg>
          Pasar a Plan Pro
        </button>
        <button type="button" class="btn-paypal" data-upgrade-tier="premium">
          <svg viewBox="0 0 24 24" class="paypal-mark" aria-hidden="true"><path fill="currentColor" d="M8.5 20.6 9.8 13H7l.4-2.5C8 6.7 9.9 5 13.6 5c2.5 0 4.4.8 4.4 3 0 .5-.1 1-.2 1.5 1.2.7 1.9 1.9 1.7 3.6-.4 3-2.7 4.6-6 4.6h-1.4l-.7 4-2.9-1.1Z"/></svg>
          Pasar a Plan Premium
        </button>
      </div>
    </div>`,
    (body) => {
      body.querySelectorAll("[data-upgrade-tier]").forEach((btn) => {
        btn.addEventListener("click", () => {
          closeModal();
          switchSection("mi-plan");
        });
      });
    }
  );
}

/* Carga el SDK de PayPal en modo "subscription" una sola vez, solo si hay client-id. */
let paypalSdkLoadPromise = null;
function loadPayPalSdk() {
  if (!PAYPAL_CLIENT_ID) return Promise.resolve(false);
  if (window.paypal) return Promise.resolve(true);
  if (paypalSdkLoadPromise) return paypalSdkLoadPromise;
  paypalSdkLoadPromise = new Promise((resolve) => {
    const script = document.createElement("script");
    script.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(PAYPAL_CLIENT_ID)}&vault=true&intent=subscription`;
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.head.appendChild(script);
  });
  return paypalSdkLoadPromise;
}

/* Renderiza los botones reales de suscripción de PayPal (uno por tier) dentro de
   los <div id="paypalBtn..."> de la sección Mi Plan. Cuando el comprador aprueba
   la suscripción, PayPal llama a onApprove en el navegador (solo para UX: mostrar
   un mensaje) y, en paralelo, dispara el webhook BILLING.SUBSCRIPTION.ACTIVATED
   contra api/paypal-webhook.js, que es quien realmente actualiza el plan en Firestore. */
async function initPayPalSubscriptionButtons() {
  const ok = await loadPayPalSdk();
  document.querySelectorAll(".plan-demo-btn").forEach((btn) => {
    btn.classList.toggle("hidden", ok);
  });
  if (!ok || !window.paypal) return;

  const slots = { basico: "paypalBtnBasico", pro: "paypalBtnPro", premium: "paypalBtnPremium" };
  Object.entries(slots).forEach(([tier, slotId]) => {
    const planId = PAYPAL_PLAN_IDS[tier];
    const slot = document.getElementById(slotId);
    if (!planId || !slot) return;
    slot.innerHTML = "";
    window.paypal
      .Buttons({
        style: { shape: "pill", color: "gold", layout: "vertical", label: "subscribe" },
        createSubscription: function (data, actions) {
          return actions.subscription.create({
            plan_id: planId,
            // custom_id: viaja hasta el webhook para que sepamos a qué usuario/admin
            // de Firestore hay que actualizarle el plan (ver api/paypal-webhook.js).
            custom_id: CURRENT_USER.uid
          });
        },
        onApprove: function (data) {
          showToast("¡Gracias! Estamos confirmando tu suscripción con PayPal...", "success");
          // El estado real (plan/límites/próximo pago) lo actualiza el webhook del
          // servidor. Acá solo refrescamos la UI por si ya llegó la actualización.
          setTimeout(() => renderMiPlan(), 3000);
        },
        onError: function (err) {
          console.error("Error de PayPal:", err);
          showToast("Hubo un problema con PayPal. Intentá de nuevo.", "error");
        }
      })
      .render(`#${slotId}`);
  });
}

/* Botones de demo (mientras no hay PAYPAL_CLIENT_ID configurado): simulan la
   activación del plan igual que ya hace handlePayPalClick() para el paywall. */
document.querySelectorAll("[data-plan-demo]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const tier = btn.getAttribute("data-plan-demo");
    showToast("Modo demo: procesando suscripción con PayPal...", "success");
    setTimeout(() => {
      markPlanPaid(CURRENT_USER.uid, "mensual", tier);
      showToast(`¡Listo! Tu ${PLAN_TIERS[tier].label} ya está activo.`, "success");
      renderMiPlan();
    }, 1200);
  });
});

/* Vista especial de "Mi Plan" para la cuenta creadora: todo ilimitado,
   sin barras de uso reales y sin la grilla de planes para contratar. */
function renderMiPlanCreador() {
  document.getElementById("miPlanBadge").innerHTML = `<i data-lucide="crown" class="h-3.5 w-3.5"></i> Plan Creador - Todo Ilimitado`;
  document.getElementById("miPlanNombre").textContent = "Plan Creador";
  document.getElementById("miPlanMeta").textContent = "Acceso total, sin límites ni vencimiento.";
  document.getElementById("miPlanPrecio").innerHTML = `<span>—</span>`;

  const bars = [
    { barId: "miPlanBarSucursales", labelId: "miPlanUsoSucursales" },
    { barId: "miPlanBarProductos", labelId: "miPlanUsoProductos" },
    { barId: "miPlanBarDocumentos", labelId: "miPlanUsoDocumentos" }
  ];
  bars.forEach((b) => {
    const bar = document.getElementById(b.barId);
    bar.style.width = "100%";
    bar.classList.remove("bar-fill-plan-warn", "bar-fill-plan-danger");
    document.getElementById(b.labelId).textContent = "∞ / ∞";
  });

  const upgradePanel = document.getElementById("miPlanUpgradePanel");
  if (upgradePanel) upgradePanel.classList.add("hidden");

  refreshIcons();
}




/* Pinta la sección "Mi Plan": plan actual, próximo pago y las 3 barras de progreso
   de uso (sucursales / productos / documentos). */
function renderMiPlan() {
  if (!CURRENT_USER) return;
  const status = getTrialStatus(CURRENT_USER.uid);
  const tier = status.isPaid ? getTrialTier(CURRENT_USER.uid) : "basico";
  const limits = getPlanLimits();
  const usage = getPlanUsage();

  document.getElementById("miPlanBadge").innerHTML = `<i data-lucide="gem" class="h-3.5 w-3.5"></i> ${status.isPaid ? "Plan activo" : status.expired ? "Sin plan activo" : "Prueba gratis"}`;
  document.getElementById("miPlanNombre").textContent = status.isPaid ? PLAN_TIERS[tier].label : "Prueba gratis (equivalente a Pro)";
  document.getElementById("miPlanPrecio").innerHTML = status.isPaid ? PLAN_TIERS[tier].priceLabel : "$0 <span>por ahora</span>";

  const trialStore = getTrialStore();
  const paidUntil = trialStore[CURRENT_USER.uid] && trialStore[CURRENT_USER.uid].paidUntil;
  document.getElementById("miPlanMeta").textContent = status.isPaid && paidUntil
    ? `Próximo pago: ${formatDate(paidUntil)}`
    : status.expired
    ? "Tu prueba gratis terminó. Elegí un plan para seguir usando Boxly."
    : `Prueba gratis: te quedan ${status.daysLeft} día${status.daysLeft === 1 ? "" : "s"}.`;

  const bars = [
    { key: "sucursales", used: usage.sucursales, max: limits.maxSucursales, barId: "miPlanBarSucursales", labelId: "miPlanUsoSucursales" },
    { key: "productos", used: usage.productos, max: limits.maxProductos, barId: "miPlanBarProductos", labelId: "miPlanUsoProductos" },
    { key: "documentos", used: usage.documentos, max: limits.maxDocumentos, barId: "miPlanBarDocumentos", labelId: "miPlanUsoDocumentos" }
  ];
  bars.forEach((b) => {
    const pct = b.max === Infinity ? Math.min((b.used / 50) * 100, 15) : Math.min((b.used / b.max) * 100, 100);
    const bar = document.getElementById(b.barId);
    bar.style.width = `${pct}%`;
    bar.classList.remove("bar-fill-plan-warn", "bar-fill-plan-danger");
    if (b.max !== Infinity) {
      if (b.used >= b.max) bar.classList.add("bar-fill-plan-danger");
      else if (b.used / b.max >= 0.8) bar.classList.add("bar-fill-plan-warn");
    }
    document.getElementById(b.labelId).textContent = `${b.used} / ${b.max === Infinity ? "∞" : b.max}`;
  });

  document.querySelectorAll(".plan-pricing-grid .paywall-plan").forEach((card) => {
    const isCurrent = status.isPaid && card.getAttribute("data-tier") === tier;
    card.classList.toggle("is-current-plan", isCurrent);
    let tag = card.querySelector(".plan-current-tag");
    if (isCurrent && !tag) {
      tag = document.createElement("span");
      tag.className = "plan-current-tag";
      tag.textContent = "Tu plan actual";
      card.prepend(tag);
    } else if (!isCurrent && tag) {
      tag.remove();
    }
  });

  refreshIcons();
  initPayPalSubscriptionButtons();
}

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
/* Estructura vacía para cuentas realmente nuevas: sin productos ni movimientos
   de ejemplo, pero con la sucursal por defecto (necesaria para que los
   formularios de Entradas/Salidas tengan al menos una opción).
   FIX: esta función vivía ANIDADA dentro de seedData() (declarada en medio de
   su cuerpo), así que no era accesible desde loadStore() ni desde ningún otro
   lugar del archivo — llamarla disparaba "seedEmptyData is not defined", lo
   que detenía toda la ejecución del script en la línea `let STORE = loadStore()`,
   antes de que se conectaran los botones del menú lateral. Por eso la app
   quedaba solo con el sidebar visible y sin poder navegar. Ahora es una
   función de nivel superior, igual que seedData(). */
function seedEmptyData() {
  return {
    products: [],
    movements: [],
    users: [],
    traslados: [],
    sucursales: [{ id: "s1", nombre: "Casa Central", direccion: "" }],
    settings: {
      nombreNegocio: "Mi negocio",
      moneda: "ARS",
      stockMinimoDefault: 10,
      notificaciones: true,
      logoBase64: null,
      direccion: "",
      telefono: "",
      email: "",
      fiscal: ""
    },
    encargados: []
  };
}

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

  const users = [];

  const sucursales = [{ id: "s1", nombre: "Casa Central", direccion: "" }];

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

  movements.forEach((m) => { m.sucursalId = "s1"; });

  const encargados = [];

  return { products, movements, users, sucursales, settings, encargados, traslados: [] };
}

/* URL de producción de las funciones serverless en Vercel. La app corre en
   GitHub Pages (miguel-coronell.github.io), un dominio distinto al de Vercel,
   así que las llamadas a /api/... necesitan la URL absoluta, no una ruta
   relativa. Usar SIEMPRE el alias estable de producción (no una URL de
   deployment puntual tipo app-xxxxx-proyecto.vercel.app, que cambia en cada push). */
const API_BASE = "https://app-nine-dusky-55.vercel.app";

/* ---------------------------- Persistencia ---------------------------- */
/* FIX: LEGACY_DEMO_EMAILS tiene que estar declarado ANTES de llamar a
   loadStore() (que internamente llama a migrateStore(), que usa esta
   constante). Antes estaba declarada más abajo en el archivo, y como
   const/let viven en "zona muerta temporal" hasta su propia línea, usarla
   acá arriba tiraba ReferenceError y hacía que loadStore() cayera siempre
   al catch, mostrando datos de demo vacíos en vez de los datos reales. */
const LEGACY_DEMO_EMAILS = ["admin@boxlyapp.com", "lucia@boxlyapp.com", "diego@boxlyapp.com"];

let STORE = loadStore();

/* ---------------------------- Dueño de la cuenta (admin real) ----------------------------
   Garantiza que quien está logueado (CURRENT_USER, con su email real de registro) sea
   siempre el Administrador de esta cuenta, y no un usuario de ejemplo. Se identifica por
   "uid" (el mismo id que devuelve el login). Si ya existía un usuario cargado con el mismo
   email (por ejemplo, alguien migrando de una versión vieja), lo adopta como dueño en vez
   de crear un duplicado. */
/* ---------------------------- Dueño de la cuenta (admin real) ----------------------------
   Garantiza que quien está logueado (CURRENT_USER, con su email real de registro) sea
   siempre el Administrador de esta cuenta, y no un usuario de ejemplo. Se identifica por
   "uid" (el mismo id que devuelve el login). Si ya existía un usuario cargado con el mismo
   email (por ejemplo, alguien migrando de una versión vieja), lo adopta como dueño en vez
   de crear un duplicado.

   FIX DE SEGURIDAD (roles): esta función forzaba rol "Administrador" para CUALQUIER uid
   logueado, sin importar quién fuera. Eso estaba bien en modo demo (localStorage), donde
   solo existe un usuario posible: el dueño de la cuenta. Pero con Firebase activo, quien
   inicia sesión puede perfectamente ser un encargado invitado (rol "encargado"/"Editor"/
   "Visualizador", con su propia sucursalId) — y como esta función se ejecuta de forma
   síncrona apenas carga el script, sin esperar a Firestore, terminaba convirtiendo a
   CUALQUIER encargado en Administrador dentro de STORE.users, mostrándole Usuarios,
   Sucursales, Mi Plan, Configuración y el filtro de todas las sucursales — exactamente lo
   que NO tiene que ver. Ahora, con Firebase activo, esta función NO asigna rol: crea (o
   deja) el registro en estado "pendiente" (rol: null), que isCurrentUserAdmin() y
   currentUserSucursalId() tratan igual que "no administrador" — o sea, todo lo sensible
   queda oculto por defecto (fail-closed) hasta que syncCurrentUserFromFirestore() lo
   reemplace por el rol y la sucursalId reales leídos de users/{uid} en Firestore. */
function ensureOwnerUser() {
  if (!CURRENT_USER) return;
  const firebaseMode = isFirebaseReady();
  let owner = STORE.users.find((u) => u.uid && u.uid === CURRENT_USER.uid);
  if (!owner && CURRENT_USER.email) {
    owner = STORE.users.find((u) => u.email && u.email.toLowerCase() === CURRENT_USER.email.toLowerCase());
  }
  if (owner) {
    owner.uid = CURRENT_USER.uid;
    owner.nombre = CURRENT_USER.nombre || owner.nombre;
    owner.email = CURRENT_USER.email || owner.email;
    if (!firebaseMode) {
      owner.isOwner = true;
      owner.rol = "Administrador";
      owner.sucursalId = null;
    }
    // En modo Firebase, si ya tenía rol/sucursalId (de una sincronización previa
    // en esta misma sesión de navegador), se respetan tal cual — no se pisan acá.
  } else {
    STORE.users.unshift({
      id: uid("u"),
      uid: CURRENT_USER.uid,
      nombre: CURRENT_USER.nombre || CURRENT_USER.email || "Administrador",
      email: CURRENT_USER.email || "",
      rol: firebaseMode ? null : "Administrador",
      sucursalId: null,
      isOwner: !firebaseMode
    });
  }
  saveStore();
}
ensureOwnerUser();

/* Pisa el registro de CURRENT_USER en STORE.users con el rol y la sucursalId REALES
   leídos desde su documento users/{uid} en Firestore (fuente de verdad). Se llama desde
   iniciarSincronizacionFirestore() apenas responde la lectura. Si el documento no tiene
   "rol" guardado (cuentas viejas del Administrador, migradas antes de que existiera este
   campo), se asume Administrador — así no se rompe el acceso del dueño original de la
   cuenta. */
function syncCurrentUserFromFirestore(userDocData) {
  if (!CURRENT_USER || !userDocData) return;
  let record = STORE.users.find((u) => u.uid === CURRENT_USER.uid);
  if (!record) {
    record = { id: uid("u"), uid: CURRENT_USER.uid };
    STORE.users.unshift(record);
  }
  record.nombre = userDocData.nombre || record.nombre || CURRENT_USER.nombre;
  record.email = userDocData.email || record.email || CURRENT_USER.email;
  record.rol = userDocData.rol || "Administrador";
  record.sucursalId = record.rol === "Administrador" ? null : (userDocData.sucursalId || null);
  record.isOwner = record.rol === "Administrador";
  saveStore();

  // Todo lo que ya se haya pintado en pantalla mientras el rol era "pendiente"
  // (sin saber todavía si es admin o no) se vuelve a evaluar con el rol real.
  applyRoleVisibility();
  if (document.getElementById("dashFiltroSucursal")) populateDashboardFilters();
  const activeLink = document.querySelector(".sidebar-link.active");
  const activeSection = activeLink ? activeLink.getAttribute("data-target") : "dashboard";
  switchSection(activeSection, { keepScroll: true });
}

function currentUserRecord() {
  return CURRENT_USER ? STORE.users.find((u) => u.uid === CURRENT_USER.uid) : null;
}
/* Nombre a guardar como "quién hizo esto" en movimientos/traslados — usa el
   nombre ya sincronizado desde Firestore (STORE.users) y, si todavía no está
   disponible, el nombre con el que se inició sesión. Así tanto el Administrador
   como cada encargado quedan identificados por su nombre real en cada entrada,
   salida o traslado que registren. */
function nombreUsuarioActual() {
  const u = currentUserRecord();
  return (u && u.nombre) || (CURRENT_USER && CURRENT_USER.nombre) || "Usuario";
}
function isCurrentUserAdmin() {
  const u = currentUserRecord();
  return !!u && u.rol === "Administrador";
}
/* Devuelve el id de sucursal al que está limitado el usuario logueado, o null si
   puede ver todas (Administrador). */
function currentUserSucursalId() {
  const u = currentUserRecord();
  return u && u.rol !== "Administrador" ? u.sucursalId : null;
}
function getSucursal(id) {
  return STORE.sucursales.find((s) => s.id === id);
}
function sucursalName(id) {
  const s = getSucursal(id);
  return s ? s.nombre : "Sin asignar";
}
/* Movimientos que puede ver el usuario logueado: todos si es Administrador,
   o solo los de su sucursal asignada si tiene otro rol. */
function visibleMovements() {
  const sucursalId = currentUserSucursalId();
  return sucursalId ? STORE.movements.filter((m) => m.sucursalId === sucursalId) : STORE.movements;
}

/* ---------------------------- Stock por sucursal ----------------------------
   FIX: cada producto solo tenía un campo "stock" GLOBAL, compartido por todas
   las sucursales del negocio — por eso a un encargado le aparecía "el stock
   general de todas las sucursales" en vez del propio. Ahora cada producto
   además guarda "stockPorSucursal": { [sucursalId]: cantidad }, que se
   actualiza en registerMovement() cada vez que se registra una entrada o
   salida en una sucursal puntual. El campo "stock" se sigue manteniendo como
   el TOTAL sumado de todas las sucursales (lo que ve el Administrador). Los
   productos que ya existían de antes de este cambio no tienen todavía
   stockPorSucursal cargado — su stock "viejo" queda como total general hasta
   que se registre la primera entrada/salida en una sucursal, momento en el
   que empieza a discriminarse. */
function stockDeSucursal(p, sucursalId) {
  // FIX (stock inicial invisible para salidas): un producto recién creado
  // solo tiene "stock" (el total cargado en el alta) — "stockPorSucursal" ni
  // siquiera existe todavía, porque recién se completa la primera vez que se
  // registra una entrada/salida en una sucursal puntual. Antes, en ese estado
  // "sin discriminar", esta función devolvía 0 pase lo que pase, así que una
  // salida rechazaba con "no hay stock" aunque el producto mostrara stock
  // disponible en el listado. Ahora, mientras el producto no tenga NINGUNA
  // sucursal discriminada todavía, tratamos el total como disponible en
  // cualquier sucursal (igual que ya se hacía en "stock actual" del listado).
  // Apenas se registra el primer movimiento en una sucursal, stockPorSucursal
  // deja de estar vacío y a partir de ahí cada sucursal usa su propio valor.
  if (!p.stockPorSucursal || Object.keys(p.stockPorSucursal).length === 0) {
    return p.stock || 0;
  }
  return p.stockPorSucursal[sucursalId] || 0;
}
/* Stock que le corresponde ver/usar al usuario logueado: el de su propia
   sucursal si tiene una asignada, o el total del negocio si es Administrador. */
function stockVisible(p) {
  const sucursalId = currentUserSucursalId();
  return sucursalId ? stockDeSucursal(p, sucursalId) : p.stock;
}

function applyRoleVisibility() {
  const admin = isCurrentUserAdmin();
  document.querySelectorAll(".admin-only").forEach((el) => el.classList.toggle("hidden", !admin));
}

function loadStore() {
  try {
    const raw = localStorage.getItem(getStorageKey());
    if (!raw) {
      const isNewUser = localStorage.getItem(NEW_USER_FLAG) === "true";
      /* FIX: antes, si el flag NEW_USER_FLAG no estaba en "true" (algo que
         pasaba seguido por el bug de flags globales de más abajo), se sembraba
         seedData() con los 12 productos de demo — y como esto vive en
         localStorage, esos productos "fantasma" llegaban a aparecer en
         cuentas reales antes de que Firestore terminara de sincronizar (o si
         la sincronización fallaba). Con Firebase configurado, Firestore es
         siempre la fuente de verdad real y pisa este seed apenas conecta, así
         que ya no tiene sentido arriesgarse a mostrar productos de demo:
         arrancamos siempre en blanco. El catálogo de demo con productos de
         ejemplo queda solo para cuando la app corre sin Firebase configurado. */
      const seeded = (isFirebaseReady() || isNewUser) ? seedEmptyData() : seedData();
      localStorage.setItem(getStorageKey(), JSON.stringify(seeded));
      return seeded;
    }
    return migrateStore(JSON.parse(raw));
  } catch (err) {
    console.error("No se pudo cargar el almacenamiento local, usando datos de demo.", err);
    return isFirebaseReady() ? seedEmptyData() : seedData();
  }
}

/* Asegura que datos guardados con versiones anteriores tengan los campos nuevos
   (codigoBarras en productos, datos de empresa/logo en settings, sucursales) sin
   perder la información ya cargada por el usuario. LEGACY_DEMO_EMAILS ahora está
   declarada más arriba en el archivo (ver nota junto a "let STORE = loadStore();"). */

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

  store.sucursales = store.sucursales && store.sucursales.length
    ? store.sucursales
    : [{ id: "s1", nombre: "Casa Central", direccion: "" }];
  const defaultSucursalId = store.sucursales[0].id;

  store.movements = (store.movements || []).map((m) => ({ sucursalId: defaultSucursalId, ...m }));

  // Limpia los usuarios de ejemplo de versiones viejas de la demo (no son cuentas reales).
  store.users = (store.users || []).filter((u) => !LEGACY_DEMO_EMAILS.includes(u.email));
  store.users = store.users.map((u) => ({ sucursalId: defaultSucursalId, uid: null, isOwner: false, ...u }));

  store.encargados = store.encargados || [];
  store.traslados = store.traslados || [];

  return store;
}

function saveStore() {
  try {
    localStorage.setItem(getStorageKey(), JSON.stringify(STORE));
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

/* ---------------------------- Requerimiento 3: Dashboard a moneda ----------------------------
   Formatea cualquier monto como moneda local usando Intl.NumberFormat, respetando la
   moneda elegida en Configuración (STORE.settings.moneda: ARS/USD/MXN/COP). Esta es la
   función que hay que usar en cualquier lugar del dashboard que muestre $, en vez de
   concatenar el símbolo "a mano" como hacía formatMoney(). Ejemplo de salida: "$ 15.420,00". */
const CURRENCY_LOCALE_MAP = { ARS: "es-AR", USD: "en-US", MXN: "es-MX", COP: "es-CO" };
function formatCurrency(amount) {
  const currency = (STORE.settings && STORE.settings.moneda) || "ARS";
  const locale = CURRENCY_LOCALE_MAP[currency] || "es-AR";
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(Number(amount) || 0);
  } catch (err) {
    // Fallback por si el navegador no reconoce el código de moneda.
    return `$ ${(Number(amount) || 0).toFixed(2)}`;
  }
}

function formatDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function statusForStock(stock, stockMinimo) {
  if (stock <= stockMinimo / 2) return "critical";
  if (stock <= stockMinimo) return "low";
  return "ok";
}

function productStatus(p) {
  return statusForStock(stockVisible(p), p.stockMinimo);
}

/* Igual que productStatus(), pero para un filtro de sucursal puntual (por ejemplo,
   el selector de sucursal del Dashboard) en vez de la sucursal fija del usuario
   logueado. Si sucursalId es "" o null, usa el total del negocio (todas las
   sucursales), igual que ve un Administrador sin filtrar. */
function productStatusFor(p, sucursalId) {
  const stock = sucursalId ? stockDeSucursal(p, sucursalId) : stockVisible(p);
  return statusForStock(stock, p.stockMinimo);
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
  if (typeof cerrarDetalleNegocio === "function") cerrarDetalleNegocio();
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
  traslados: { title: "Traslados", subtitle: "Remisiones y traslados de stock entre sucursales." },
  usuarios: { title: "Usuarios", subtitle: "Administrá quién accede a tu cuenta." },
  sucursales: { title: "Sucursales", subtitle: "Administrá las sucursales de tu negocio." },
  "mi-plan": { title: "Mi Plan", subtitle: "Tu suscripción, límites de uso y facturación." },
  configuracion: { title: "Configuración", subtitle: "Ajustá los datos de tu negocio." },
  ayuda: { title: "Ayuda y soporte", subtitle: "Estamos para ayudarte con Boxly." }
};



function switchSection(target, opts = {}) {
  if (document.body.classList.contains("trial-expired-lock") && target !== "mi-plan" && target !== "ayuda") {
    target = "mi-plan";
  }
  const ADMIN_ONLY_SECTIONS = ["usuarios", "sucursales", "mi-plan", "configuracion"];
  if (ADMIN_ONLY_SECTIONS.includes(target) && !isCurrentUserAdmin()) {
    showToast("No tenés permisos de administrador para ver esta sección.", "error");
    target = "dashboard";
  }
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
    case "traslados": renderTraslados(); break;
    case "usuarios": renderUsuarios(); break;
    case "sucursales": renderSucursales(); break;
    case "mi-plan": renderMiPlan(); break;
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
const addProductQuickBtn = document.getElementById("addProductQuick");
if (addProductQuickBtn) {
  addProductQuickBtn.addEventListener("click", () => openProductModal());
}

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
function computeStats(categoria, sucursalId) {
  const products = categoria ? STORE.products.filter((p) => p.categoria === categoria) : STORE.products;
  const stockOf = (p) => (sucursalId ? stockDeSucursal(p, sucursalId) : stockVisible(p));
  const totalProducts = products.length;
  const totalStock = products.reduce((sum, p) => sum + stockOf(p), 0);
  const totalValue = products.reduce((sum, p) => sum + stockOf(p) * p.precio, 0);
  const activeAlerts = products.filter((p) => productStatusFor(p, sucursalId) !== "ok").length;
  return { totalProducts, totalStock, totalValue, activeAlerts };
}

function categoryBreakdown(categoria, sucursalId) {
  const map = {};
  const stockOf = (p) => (sucursalId ? stockDeSucursal(p, sucursalId) : stockVisible(p));
  STORE.products
    .filter((p) => !categoria || p.categoria === categoria)
    .forEach((p) => {
      map[p.categoria] = (map[p.categoria] || 0) + stockOf(p);
    });
  const total = Object.values(map).reduce((a, b) => a + b, 0) || 1;
  return Object.entries(map)
    .map(([categoria, stock]) => ({ categoria, stock, pct: Math.round((stock / total) * 100) }))
    .sort((a, b) => b.stock - a.stock);
}

function renderDonut(svgEl, legendEl, categoria, sucursalId) {
  const data = categoryBreakdown(categoria, sucursalId);
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

/* ---------------------------- Barra de filtros del Dashboard ----------------------------
   Los mismos 3 filtros (fecha, sucursal, categoría) controlan las tarjetas de KPIs, el
   gráfico de categorías, los movimientos recientes y la tabla de stock bajo. Todo se
   recalcula en el momento a partir de STORE (localStorage). Ver más abajo el bloque
   FIRESTORE_DASHBOARD_SYNC con el equivalente para cuando conectes el backend. */
function getDashboardFilters() {
  const rango = document.getElementById("dashFiltroFecha").value;
  const sucursalId = document.getElementById("dashFiltroSucursal").value;
  const categoria = document.getElementById("dashFiltroCategoria").value;
  const range = rango === "todo" ? null : quickFilterRange(rango);
  return { start: range ? range.start : null, end: range ? range.end : null, sucursalId, categoria };
}

function populateDashboardFilters() {
  const sucursalSelect = document.getElementById("dashFiltroSucursal");
  const fixedId = currentUserSucursalId();
  if (!fixedId) {
    const current = sucursalSelect.value;
    sucursalSelect.innerHTML = `<option value="">Todas</option>` + STORE.sucursales.map((s) => `<option value="${s.id}">${s.nombre}</option>`).join("");
    sucursalSelect.disabled = false;
    if (STORE.sucursales.some((s) => s.id === current)) sucursalSelect.value = current;
  } else {
    const s = getSucursal(fixedId);
    sucursalSelect.innerHTML = s ? `<option value="${s.id}">${s.nombre}</option>` : `<option value="">Sin sucursal asignada</option>`;
    sucursalSelect.disabled = true;
  }
  populateCategorySelect(document.getElementById("dashFiltroCategoria"));
}

function getFilteredDashboardMovements() {
  const { start, end, sucursalId, categoria } = getDashboardFilters();
  return visibleMovements().filter((m) => {
    const fecha = new Date(m.fecha);
    const matchesStart = !start || fecha >= start;
    const matchesEnd = !end || fecha <= end;
    const matchesSucursal = !sucursalId || m.sucursalId === sucursalId;
    const product = getProduct(m.productId);
    const matchesCategoria = !categoria || (product && product.categoria === categoria);
    return matchesStart && matchesEnd && matchesSucursal && matchesCategoria;
  });
}

function renderDashboard() {
  populateDashboardFilters();
  const { categoria, sucursalId } = getDashboardFilters();
  const stats = computeStats(categoria, sucursalId);
  animateValue(document.getElementById("statTotalProducts"), stats.totalProducts);
  animateValue(document.getElementById("statTotalStock"), stats.totalStock);
  document.getElementById("statTotalValue").textContent = formatCurrency(stats.totalValue);
  animateValue(document.getElementById("statActiveAlerts"), stats.activeAlerts);

  renderDonut(document.getElementById("donutChart"), document.getElementById("donutLegend"), categoria, sucursalId);

  const filteredMovements = getFilteredDashboardMovements();
  // esTraslado: los movimientos que genera un traslado entre sucursales (ver
  // confirmarRecepcionTraslado / /api/confirmar-traslado.js) quedan en el
  // historial de entradas/salidas para que se pueda auditar todo, pero NO son
  // compras ni ventas reales — son la misma mercadería cambiando de sucursal
  // dentro del mismo negocio — así que se excluyen de estos KPIs para no
  // inflarlos artificialmente.
  const purchases = filteredMovements.filter((m) => m.tipo === "entrada" && !m.esTraslado).reduce((sum, m) => sum + m.cantidad, 0);
  const sales = filteredMovements.filter((m) => m.tipo === "salida" && !m.esTraslado).reduce((sum, m) => sum + m.cantidad, 0);
  animateValue(document.getElementById("statPurchases"), purchases);
  animateValue(document.getElementById("statSales"), sales);

  // Ventas / Compras totales EN MONEDA (Requerimiento 3): suman montoTotal de cada
  // movimiento (cantidad * precio unitario del producto al momento del movimiento,
  // ver registerMovement) y se formatean con Intl.NumberFormat vía formatCurrency().
  const purchasesAmount = filteredMovements
    .filter((m) => m.tipo === "entrada" && !m.esTraslado)
    .reduce((sum, m) => sum + (m.montoTotal || 0), 0);
  const salesAmount = filteredMovements
    .filter((m) => m.tipo === "salida" && !m.esTraslado)
    .reduce((sum, m) => sum + (m.montoTotal || 0), 0);
  document.getElementById("statPurchasesAmount").textContent = formatCurrency(purchasesAmount);
  document.getElementById("statSalesAmount").textContent = formatCurrency(salesAmount);

  // Recent movements (últimos 5, respetando los filtros y la sucursal del usuario logueado)
  const recent = [...filteredMovements].sort((a, b) => new Date(b.fecha) - new Date(a.fecha)).slice(0, 5);
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
    : `<li class="text-sm text-slate-400 px-1">No hay movimientos para estos filtros.</li>`;

  // Low stock table (respeta el filtro de categoría Y el de sucursal)
  const stockDelFiltro = (p) => (sucursalId ? stockDeSucursal(p, sucursalId) : stockVisible(p));
  const lowStock = STORE.products
    .filter((p) => !categoria || p.categoria === categoria)
    .filter((p) => productStatusFor(p, sucursalId) !== "ok")
    .sort((a, b) => stockDelFiltro(a) - stockDelFiltro(b));
  const tbody = document.getElementById("lowStockTableBody");
  tbody.innerHTML = lowStock.length
    ? lowStock
        .map(
          (p) => `<tr>
            <td class="font-medium text-ink">${p.nombre}</td>
            <td class="text-slate-400">${p.categoria}</td>
            <td class="font-mono">${stockDelFiltro(p)}</td>
            <td class="font-mono">${p.stockMinimo}</td>
            <td>${statusTagHtml(productStatusFor(p, sucursalId))}</td>
          </tr>`
        )
        .join("")
    : `<tr><td colspan="5" class="empty-state">No hay productos con stock bajo. ¡Buen trabajo!</td></tr>`;

  refreshIcons();
  updateAlertBadges();
}

/* Compartida entre renderAlertas() y updateAlertBadges() — antes cada una
   calculaba las alertas de stock bajo con su propia lógica, y quedaron
   desincronizadas: la campanita contaba PRODUCTOS DISTINTOS en alerta
   (productStatus(p), que para el Administrador usa el stock TOTAL del
   negocio), mientras que la lista de Alertas ya mostraba una fila POR CADA
   SUCURSAL en alerta. Resultado: la campanita podía decir "1" cuando la
   lista de abajo mostraba 2 (mismo producto, bajo en dos sucursales
   distintas). Ahora las dos usan exactamente el mismo cálculo. */
function calcularAlertasStock() {
  const sucursalFija = currentUserSucursalId();
  const alerts = [];
  if (sucursalFija) {
    STORE.products.forEach((p) => {
      if (productStatusFor(p, sucursalFija) !== "ok") {
        alerts.push({ product: p, sucursalId: sucursalFija });
      }
    });
  } else {
    STORE.products.forEach((p) => {
      STORE.sucursales.forEach((s) => {
        if (productStatusFor(p, s.id) !== "ok") {
          alerts.push({ product: p, sucursalId: s.id });
        }
      });
    });
  }
  return alerts;
}

function updateAlertBadges() {
  const count = calcularAlertasStock().length;
  document.getElementById("sidebarAlertBadge").textContent = count;
  document.getElementById("notifBadge").textContent = count;
  document.getElementById("sidebarAlertBadge").style.display = count ? "inline-flex" : "none";
  document.getElementById("notifBadge").style.display = count ? "inline-flex" : "none";
}

["dashFiltroFecha", "dashFiltroSucursal", "dashFiltroCategoria"].forEach((id) => {
  document.getElementById(id).addEventListener("change", () => renderDashboard());
});
document.getElementById("dashFiltroLimpiar").addEventListener("click", () => {
  document.getElementById("dashFiltroFecha").value = "todo";
  document.getElementById("dashFiltroSucursal").value = "";
  document.getElementById("dashFiltroCategoria").value = "";
  renderDashboard();
  showToast("Filtros del dashboard limpiados.", "success");
});

/* =========================================================================
   REFERENCIA: sincronización de estos mismos filtros con Firestore
   ========================================================================= */
/*
  Esta función NO se ejecuta todavía (no está llamada en ningún lado). Es la
  plantilla lista para cuando conectes Firestore: mismo criterio de filtros
  (fecha, sucursal, categoría) que ya usa getDashboardFilters(), pero en vez
  de filtrar el array STORE.movements en el navegador, arma una query de
  Firestore con .where() encadenados y la escucha en vivo con onSnapshot,
  para que las tarjetas y el gráfico se recalculen solos apenas cambia algo
  en la base (sin necesidad de F5).

  Para activarla:
  1) Agregá el SDK de Firestore en app.html (mismo compat que ya usa login.html)
     y tu firebase-config.js con las credenciales del proyecto.
  2) Reemplazá "productId" / "sucursalId" / "fecha" por los nombres reales de
     tus campos en la colección "movimientos" si los llamaste distinto.
  3) Llamá a initDashboardFirestoreSync() en el DOMContentLoaded, en lugar de
     (o además de) renderDashboard(), según cómo migres los datos.
*/
function initDashboardFirestoreSync() {
  const db = firebase.firestore();
  const negocioId = CURRENT_USER.uid; // o el id de la cuenta/negocio si manejás varios dueños

  function buildMovementsQuery() {
    const { start, end, sucursalId, categoria } = getDashboardFilters();

    // Punto de partida: todos los movimientos del negocio logueado.
    let query = db.collection("negocios").doc(negocioId).collection("movimientos");

    // --- Filtro de sucursal: solo se agrega el .where() si hay una sucursal elegida ---
    // (si el usuario logueado no es Administrador, sucursalId ya viene fijo en su propia sucursal)
    if (sucursalId) {
      query = query.where("sucursalId", "==", sucursalId);
    }

    // --- Filtro de categoría: Firestore no permite ir a "products.categoria" desde
    // "movimientos", así que lo ideal es desnormalizar y guardar "categoria" también
    // en cada documento de movimiento al crearlo (ver registerMovement). Así el filtro
    // queda simple: ---
    if (categoria) {
      query = query.where("categoria", "==", categoria);
    }

    // --- Filtro de fecha: Firestore sí permite rangos con .where() combinados,
    // pero solo sobre UN campo con desigualdades (">=" y "<=" sobre "fecha" está bien
    // porque son el mismo campo) ---
    if (start) query = query.where("fecha", ">=", start);
    if (end) query = query.where("fecha", "<=", end);

    return query.orderBy("fecha", "desc");
  }

  // Guardamos la referencia al listener activo para poder cancelarlo cuando
  // cambian los filtros y hay que volver a suscribirse con la query nueva.
  let unsubscribe = null;

  function subscribe() {
    if (unsubscribe) unsubscribe(); // corta el listener anterior antes de crear el nuevo

    unsubscribe = buildMovementsQuery().onSnapshot(
      (snapshot) => {
        const movimientos = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

        // A partir de acá, todo es el mismo cálculo que ya hace renderDashboard(),
        // pero con los datos que llegaron en vivo de Firestore en vez de STORE.movements:
        const purchases = movimientos.filter((m) => m.tipo === "entrada" && !m.esTraslado).reduce((sum, m) => sum + m.cantidad, 0);
        const sales = movimientos.filter((m) => m.tipo === "salida" && !m.esTraslado).reduce((sum, m) => sum + m.cantidad, 0);
        animateValue(document.getElementById("statPurchases"), purchases);
        animateValue(document.getElementById("statSales"), sales);

        const recent = movimientos.slice(0, 5);
        // ...acá reutilizás el mismo bloque que arma el <li> de "Movimientos recientes"...

        // Los KPIs que dependen de productos (stock total, valor de inventario, alertas)
        // seguirían viniendo de la colección "productos" con su propio listener,
        // filtrado también por categoría si corresponde.
      },
      (error) => {
        console.error("Error escuchando movimientos:", error);
        showToast("No se pudieron cargar los movimientos en vivo.", "error");
      }
    );
  }

  // Cada vez que el admin cambia un filtro, se vuelve a armar la query y se
  // re-suscribe (en vez de re-filtrar en el navegador como hace la versión demo).
  ["dashFiltroFecha", "dashFiltroSucursal", "dashFiltroCategoria"].forEach((id) => {
    document.getElementById(id).addEventListener("change", subscribe);
  });

  subscribe();
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
        <td class="font-mono">${stockVisible(p)}</td>
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
          if (isFirebaseReady() && NEGOCIO_ID) {
            getFirestoreDb().collection("negocios").doc(NEGOCIO_ID).collection("productos").doc(product.id).delete()
              .then(() => showToast("Producto eliminado.", "success"))
              .catch((err) => {
                console.error("No se pudo eliminar el producto en Firestore.", err);
                showToast("No se pudo eliminar el producto. Probá de nuevo.", "error");
              });
            // No hace falta renderProductos()/renderDashboard() acá: el onSnapshot
            // de iniciarSincronizacionProductos() los llama solo apenas Firestore confirma el borrado.
            return;
          }
          // ---- Modo demo (sin Firebase) ----
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

  // Requerimiento 2: checkPlanLimits() corre antes de construir el modal de "Crear producto".
  // Solo aplica al alta (no a la edición de un producto ya existente).
  const limitCheck = !isEdit ? checkPlanLimits("producto") : null;
  const limitExceeded = Boolean(limitCheck && !limitCheck.allowed);

  openModal(
    isEdit ? "Editar producto" : "Nuevo producto",
    `${limitExceeded ? limitBannerHtml(limitCheck) : ""}
    <form id="productForm" class="movement-form">
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

      <button type="submit" class="btn-primary w-full justify-center mt-4" ${limitExceeded ? "disabled" : ""}>
        <i data-lucide="${isEdit ? "save" : "plus"}" class="h-4 w-4"></i>
        ${isEdit ? "Guardar cambios" : "Crear producto"}
      </button>
    </form>`,
    (body) => {
      if (limitExceeded) {
        body.querySelectorAll("#productForm input, #productForm select").forEach((el) => (el.disabled = true));
        const upgradeBtn = body.querySelector("#limitBannerUpgradeBtn");
        if (upgradeBtn) upgradeBtn.addEventListener("click", () => openUpgradeModal(limitCheck));
      }
      body.querySelector("#productForm").addEventListener("submit", (e) => {
        e.preventDefault();
        if (limitExceeded) return; // doble resguardo además del atributo disabled
        const payload = {
          sku: body.querySelector("#pfSku").value.trim(),
          codigoBarras: body.querySelector("#pfCodigoBarras").value.trim(),
          nombre: body.querySelector("#pfNombre").value.trim(),
          categoria: body.querySelector("#pfCategoria").value.trim() || "Otros",
          stock: parseInt(body.querySelector("#pfStock").value, 10) || 0,
          stockMinimo: parseInt(body.querySelector("#pfStockMinimo").value, 10) || 0,
          precio: parseFloat(body.querySelector("#pfPrecio").value) || 0
        };

        if (isFirebaseReady() && NEGOCIO_ID) {
          const coleccion = getFirestoreDb().collection("negocios").doc(NEGOCIO_ID).collection("productos");
          const promesa = isEdit
            ? coleccion.doc(existing.id).update(payload)
            : coleccion.add(payload);
          promesa
            .then((docRef) => {
              showToast(isEdit ? "Producto actualizado." : "Producto creado.", "success");
              closeModal();
              // El onSnapshot de iniciarSincronizacionProductos() ya actualiza STORE.products
              // y vuelve a llamar a renderProductos()/renderDashboard() solo.
              if (typeof options.onSaved === "function") {
                options.onSaved(isEdit ? { id: existing.id, ...payload } : { id: docRef.id, ...payload });
              }
            })
            .catch((err) => {
              console.error("No se pudo guardar el producto en Firestore.", err);
              showToast("No se pudo guardar el producto. Probá de nuevo.", "error");
            });
          return;
        }

        // ---- Modo demo (sin Firebase) ----
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

/* FIX: antes esto siempre mostraba stockVisible(p) — para el Administrador,
   el TOTAL sumado de todas las sucursales, sin importar qué sucursal haya
   elegido en el formulario. Un Administrador registrando una entrada en
   "Depósito #1" veía "(stock: 41)" cuando en realidad esa sucursal puntual
   tenía 0 — el 41 era la suma de todo el negocio. Ahora, si se pasa
   sucursalId, se muestra el stock REAL de esa sucursal puntual. */
function populateProductSelect(selectEl, categoria, sucursalId) {
  const current = selectEl.value;
  const list = STORE.products.filter((p) => !categoria || p.categoria === categoria);
  selectEl.innerHTML = list.length
    ? list
        .map((p) => {
          const stockMostrado = sucursalId ? stockDeSucursal(p, sucursalId) : stockVisible(p);
          return `<option value="${p.id}">${p.nombre} · ${p.sku} · ${p.categoria} (stock: ${stockMostrado})</option>`;
        })
        .join("")
    : `<option value="">No hay productos en esta categoría</option>`;
  if (list.some((p) => p.id === current)) selectEl.value = current;
}

/* Puebla el selector de sucursal de un formulario de movimiento. Si el usuario
   logueado es Administrador, puede elegir cualquier sucursal; si tiene otro rol,
   el campo queda fijo en la sucursal que le asignó el administrador. */
function populateSucursalSelect(selectEl) {
  const fixedId = currentUserSucursalId();
  if (!fixedId) {
    const current = selectEl.value;
    selectEl.disabled = false;
    selectEl.innerHTML = STORE.sucursales.map((s) => `<option value="${s.id}">${s.nombre}</option>`).join("");
    if (STORE.sucursales.some((s) => s.id === current)) selectEl.value = current;
  } else {
    const s = getSucursal(fixedId);
    selectEl.disabled = true;
    selectEl.innerHTML = s ? `<option value="${s.id}">${s.nombre}</option>` : `<option value="">Sin sucursal asignada</option>`;
  }
}

function renderMovementHistory(tipo, tbodyId, emptyId) {
  const items = visibleMovements().filter((m) => m.tipo === tipo).sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
  const tbody = document.getElementById(tbodyId);
  tbody.innerHTML = items
    .map((m) => {
      const product = getProduct(m.productId);
      return `<tr>
        <td class="font-mono text-xs text-slate-400">${formatDate(m.fecha)}</td>
        <td class="text-slate-400">${sucursalName(m.sucursalId)}</td>
        <td class="font-medium text-ink">${product ? product.nombre : "Producto eliminado"}</td>
        <td class="font-mono ${tipo === "entrada" ? "text-greendark" : "text-red-500"}">${tipo === "entrada" ? "+" : "−"}${m.cantidad}</td>
        <td class="text-slate-400">${m.nota || "—"}</td>
        <td class="text-slate-400">${m.creadoPorNombre || "—"}</td>
      </tr>`;
    })
    .join("");
  document.getElementById(emptyId).classList.toggle("hidden", items.length > 0);
}

function renderEntradas() {
  populateSucursalSelect(document.getElementById("entradaSucursal"));
  const categoriaFiltro = document.getElementById("entradaCategoriaFiltro");
  populateCategorySelect(categoriaFiltro);
  populateProductSelect(document.getElementById("entradaProducto"), categoriaFiltro.value, document.getElementById("entradaSucursal").value);
  renderMovementHistory("entrada", "entradasHistoryBody", "entradasEmptyState");
}

function renderSalidas() {
  populateSucursalSelect(document.getElementById("salidaSucursal"));
  const categoriaFiltro = document.getElementById("salidaCategoriaFiltro");
  populateCategorySelect(categoriaFiltro);
  populateProductSelect(document.getElementById("salidaProducto"), categoriaFiltro.value, document.getElementById("salidaSucursal").value);
  renderMovementHistory("salida", "salidasHistoryBody", "salidasEmptyState");
}

document.getElementById("entradaCategoriaFiltro").addEventListener("change", (e) => {
  populateProductSelect(document.getElementById("entradaProducto"), e.target.value, document.getElementById("entradaSucursal").value);
});
document.getElementById("salidaCategoriaFiltro").addEventListener("change", (e) => {
  populateProductSelect(document.getElementById("salidaProducto"), e.target.value, document.getElementById("salidaSucursal").value);
});
// FIX: cuando el Administrador cambia la sucursal del movimiento, el stock que
// se muestra al lado de cada producto tiene que actualizarse también — antes
// se quedaba pegado al stock de la sucursal que estuviera seleccionada al
// momento de entrar a la pantalla (o al total, si no se había tocado nada).
document.getElementById("entradaSucursal").addEventListener("change", (e) => {
  populateProductSelect(document.getElementById("entradaProducto"), document.getElementById("entradaCategoriaFiltro").value, e.target.value);
});
document.getElementById("salidaSucursal").addEventListener("change", (e) => {
  populateProductSelect(document.getElementById("salidaProducto"), document.getElementById("salidaCategoriaFiltro").value, e.target.value);
});

function registerMovement(tipo, productSelectId, cantidadId, notaId, formId, sucursalSelectId) {
  const sucursalId = document.getElementById(sucursalSelectId).value;
  const productId = document.getElementById(productSelectId).value;
  const cantidad = parseInt(document.getElementById(cantidadId).value, 10);
  const nota = document.getElementById(notaId).value.trim();
  const product = getProduct(productId);

  if (!sucursalId) {
    showToast("Seleccioná una sucursal.", "error");
    return;
  }
  if (!product || !cantidad || cantidad <= 0) {
    showToast("Completá el producto y una cantidad válida.", "error");
    return;
  }

  // FIX: la validación de "hay stock suficiente" comparaba contra el TOTAL del
  // negocio (product.stock), no contra lo que hay realmente en la sucursal
  // elegida. Ahora se valida contra stockDeSucursal(), que es lo único que un
  // encargado puede vender/mover.
  const stockDeEstaSucursal = stockDeSucursal(product, sucursalId);
  if (tipo === "salida" && cantidad > stockDeEstaSucursal) {
    showToast(`No hay suficiente stock de ${product.nombre} en esta sucursal (disponible: ${stockDeEstaSucursal}).`, "error");
    return;
  }

  if (isFirebaseReady() && NEGOCIO_ID) {
    const db = getFirestoreDb();
    const productRef = db.collection("negocios").doc(NEGOCIO_ID).collection("productos").doc(productId);
    const movimientoRef = db.collection("negocios").doc(NEGOCIO_ID).collection("movimientos").doc();

    db.runTransaction((transaction) => {
      return transaction.get(productRef).then((productSnap) => {
        if (!productSnap.exists) throw new Error("STOCK_PRODUCTO_INEXISTENTE");
        const data = productSnap.data();
        const stockPorSucursal = data.stockPorSucursal || {};
        // FIX: mismo criterio que stockDeSucursal() más arriba — si el producto
        // todavía no tiene ninguna sucursal discriminada, su stock inicial
        // (cargado al crearlo) cuenta como disponible en cualquier sucursal.
        const sinDiscriminarTodavia = Object.keys(stockPorSucursal).length === 0;
        const stockActualSucursal = sinDiscriminarTodavia ? (data.stock || 0) : (stockPorSucursal[sucursalId] || 0);
        if (tipo === "salida" && cantidad > stockActualSucursal) {
          throw new Error(`STOCK_INSUFICIENTE:No hay suficiente stock de ${data.nombre} en esta sucursal (disponible: ${stockActualSucursal}).`);
        }
        const delta = tipo === "entrada" ? cantidad : -cantidad;
        const nuevoStockSucursal = stockActualSucursal + delta;
        const nuevoStockTotal = (data.stock || 0) + delta; // total del negocio = suma de todas las sucursales
        const montoTotal = cantidad * (data.precio || 0);
        transaction.update(productRef, {
          stock: nuevoStockTotal,
          [`stockPorSucursal.${sucursalId}`]: nuevoStockSucursal
        });
        // creadoPorUid/creadoPorNombre: quién hizo el movimiento (Administrador o
        // encargado), para que cualquiera que mire el historial sepa quién lo cargó.
        transaction.set(movimientoRef, {
          tipo, productId, cantidad, nota, sucursalId, montoTotal,
          creadoPorUid: CURRENT_USER.uid,
          creadoPorNombre: nombreUsuarioActual(),
          fecha: new Date().toISOString()
        });
      });
    })
      .then(() => {
        document.getElementById(formId).reset();
        showToast(tipo === "entrada" ? "Entrada registrada." : "Salida registrada.", "success");
        // Los onSnapshot de productos y movimientos ya refrescan entradas/salidas/dashboard solos.
      })
      .catch((err) => {
        console.error("No se pudo registrar el movimiento en Firestore.", err);
        if (err.message && err.message.startsWith("STOCK_INSUFICIENTE:")) {
          showToast(err.message.replace("STOCK_INSUFICIENTE:", ""), "error");
        } else if (err.message === "STOCK_PRODUCTO_INEXISTENTE") {
          showToast("Ese producto ya no existe.", "error");
        } else {
          showToast("No se pudo registrar el movimiento. Probá de nuevo.", "error");
        }
      });
    return;
  }

  // ---- Modo demo (sin Firebase) ----
  if (!product.stockPorSucursal) product.stockPorSucursal = {};
  // FIX: mismo criterio que en el modo Firestore — si todavía no hay ninguna
  // sucursal discriminada, arrancamos desde el stock total (no desde 0), o
  // una salida sobre un producto recién creado dejaría el stock de esa
  // sucursal en negativo en vez de descontar del stock inicial real.
  const sinDiscriminarTodavia = Object.keys(product.stockPorSucursal).length === 0;
  const stockActualSucursal = sinDiscriminarTodavia ? (product.stock || 0) : (product.stockPorSucursal[sucursalId] || 0);
  const delta = tipo === "entrada" ? cantidad : -cantidad;
  product.stockPorSucursal[sucursalId] = stockActualSucursal + delta;
  product.stock += delta;
  // montoTotal = cantidad * precio unitario del producto en el momento del movimiento.
  // Es la base que usa el dashboard (Requerimiento 3) para sumar "Compras totales" y
  // "Ventas totales" en moneda, en vez de solo unidades.
  const montoTotal = cantidad * (product.precio || 0);
  STORE.movements.push({
    id: uid("m"), tipo, productId, cantidad, nota, sucursalId, montoTotal,
    creadoPorUid: CURRENT_USER.uid,
    creadoPorNombre: nombreUsuarioActual(),
    fecha: new Date().toISOString()
  });
  saveStore();

  document.getElementById(formId).reset();
  renderEntradas();
  renderSalidas();
  renderDashboard();
  showToast(tipo === "entrada" ? "Entrada registrada." : "Salida registrada.", "success");
}

document.getElementById("entradaForm").addEventListener("submit", (e) => {
  e.preventDefault();
  registerMovement("entrada", "entradaProducto", "entradaCantidad", "entradaNota", "entradaForm", "entradaSucursal");
});
document.getElementById("salidaForm").addEventListener("submit", (e) => {
  e.preventDefault();
  registerMovement("salida", "salidaProducto", "salidaCantidad", "salidaNota", "salidaForm", "salidaSucursal");
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
   TRASLADOS ENTRE SUCURSALES (remisiones)
   =========================================================================
   Solo el Administrador genera remisiones (crearTraslado). El stock de la
   sucursal de ORIGEN recién se descuenta cuando la sucursal DESTINO confirma
   la recepción física (confirmarRecepcionTraslado) — hasta ese momento el
   traslado queda "pendiente" y no mueve ni una unidad de stock. Si lo
   recibido no coincide con lo enviado, la diferencia queda anotada en el
   remito con el motivo que cargue quien recibe (rotura, pérdida, etc.), pero
   igual se descuenta del origen lo que salió y se suma al destino solo lo
   que realmente llegó.

   La confirmación de recepción NO se hace directo contra Firestore desde acá:
   cuando quien confirma es el encargado de la sucursal DESTINO, hace falta
   tocar el stock de la sucursal ORIGEN (que no es la suya), y las reglas de
   Firestore a propósito no dejan que un encargado edite el stock de una
   sucursal ajena (ver firestore.rules). Por eso esa parte vive en
   /api/confirmar-traslado.js, con el Admin SDK, que valida a mano que quien
   llama es el Administrador o el encargado de esa sucursal destino puntual.
   ========================================================================= */

/* Ítems que se van armando en el formulario de "Nuevo traslado" antes de
   generar la remisión. Se resetea cada vez que se abre/limpia la sección. */
let TRASLADO_ITEMS = [];

function trasladosVisibles() {
  // Ya vienen filtrados por sucursal desde suscribirTrasladosFirestore() (o,
  // en modo demo, no hace falta filtrar: el demo siempre corre como Admin).
  return [...STORE.traslados].sort((a, b) => new Date(b.fechaCreacion) - new Date(a.fechaCreacion));
}

function populateTrasladoSucursalSelects() {
  const origenSelect = document.getElementById("trasladoOrigen");
  const destinoSelect = document.getElementById("trasladoDestino");
  if (!origenSelect || !destinoSelect) return;
  const opciones = STORE.sucursales.map((s) => `<option value="${s.id}">${s.nombre}</option>`).join("");
  const curOrigen = origenSelect.value;
  const curDestino = destinoSelect.value;
  origenSelect.innerHTML = opciones;
  destinoSelect.innerHTML = opciones;
  if (STORE.sucursales.some((s) => s.id === curOrigen)) origenSelect.value = curOrigen;
  if (STORE.sucursales.some((s) => s.id === curDestino)) destinoSelect.value = curDestino;
  // Si hay más de una sucursal, evitamos que origen y destino arranquen
  // apuntando a la misma por accidente.
  if (STORE.sucursales.length > 1 && destinoSelect.value === origenSelect.value) {
    const otra = STORE.sucursales.find((s) => s.id !== origenSelect.value);
    if (otra) destinoSelect.value = otra.id;
  }
}

function renderTrasladoItemsTable() {
  const tbody = document.getElementById("trasladoItemsBody");
  const empty = document.getElementById("trasladoItemsEmpty");
  if (!tbody) return;
  const origenId = document.getElementById("trasladoOrigen").value;

  tbody.innerHTML = TRASLADO_ITEMS
    .map((item, idx) => {
      const p = getProduct(item.productId);
      const stockOrigen = p ? stockDeSucursal(p, origenId) : 0;
      return `<tr>
        <td class="font-medium text-ink">${p ? p.nombre : "Producto eliminado"}</td>
        <td class="font-mono text-xs text-slate-400">${stockOrigen}</td>
        <td><input type="number" min="1" step="1" class="form-input" data-traslado-cantidad="${idx}" value="${item.cantidad}" style="padding:0.4rem 0.6rem"></td>
        <td><button type="button" class="icon-btn danger" data-traslado-quitar="${idx}" aria-label="Quitar"><i data-lucide="trash-2" class="h-4 w-4"></i></button></td>
      </tr>`;
    })
    .join("");

  empty.classList.toggle("hidden", TRASLADO_ITEMS.length > 0);
  refreshIcons();

  tbody.querySelectorAll("[data-traslado-cantidad]").forEach((input) => {
    input.addEventListener("change", () => {
      const idx = parseInt(input.getAttribute("data-traslado-cantidad"), 10);
      const val = parseInt(input.value, 10);
      TRASLADO_ITEMS[idx].cantidad = val > 0 ? val : 1;
      input.value = TRASLADO_ITEMS[idx].cantidad;
    });
  });
  tbody.querySelectorAll("[data-traslado-quitar]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.getAttribute("data-traslado-quitar"), 10);
      TRASLADO_ITEMS.splice(idx, 1);
      renderTrasladoItemsTable();
    });
  });
}

function agregarProductoATraslado(productId) {
  if (!productId) return;
  const existente = TRASLADO_ITEMS.find((it) => it.productId === productId);
  if (existente) {
    existente.cantidad += 1;
  } else {
    TRASLADO_ITEMS.push({ productId, cantidad: 1 });
  }
  renderTrasladoItemsTable();
}

function setupTrasladoForm() {
  const form = document.getElementById("trasladoForm");
  if (!form) return;

  populateProductSelect(document.getElementById("trasladoProductoManual"), "");

  document.getElementById("trasladoAgregarManual").addEventListener("click", () => {
    const select = document.getElementById("trasladoProductoManual");
    agregarProductoATraslado(select.value);
  });

  document.getElementById("trasladoOrigen").addEventListener("change", () => {
    if (document.getElementById("trasladoDestino").value === document.getElementById("trasladoOrigen").value) {
      showToast("El origen y el destino no pueden ser la misma sucursal.", "error");
    }
    populateProductSelect(document.getElementById("trasladoProductoManual"), "", document.getElementById("trasladoOrigen").value);
    renderTrasladoItemsTable();
  });

  const scanInput = document.getElementById("trasladoScan");
  scanInput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const code = scanInput.value.trim();
    if (!code) return;
    const product = findProductByCode(code);
    if (!product) {
      showToast(`No se encontró ningún producto con el código ${code}.`, "error");
      return;
    }
    agregarProductoATraslado(product.id);
    scanInput.value = "";
    showToast(`Agregado al remito: ${product.nombre}`, "success");
  });
  document.getElementById("trasladoScanCam").addEventListener("click", () => {
    openCameraScanner((decodedText) => {
      const product = findProductByCode(decodedText);
      if (!product) {
        showToast(`No se encontró ningún producto con el código ${decodedText}.`, "error");
        return;
      }
      agregarProductoATraslado(product.id);
      showToast(`Agregado al remito: ${product.nombre}`, "success");
    });
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const sucursalOrigenId = document.getElementById("trasladoOrigen").value;
    const sucursalDestinoId = document.getElementById("trasladoDestino").value;
    const nota = document.getElementById("trasladoNota").value.trim();

    if (!sucursalOrigenId || !sucursalDestinoId) {
      showToast("Elegí sucursal de origen y destino.", "error");
      return;
    }
    if (sucursalOrigenId === sucursalDestinoId) {
      showToast("El origen y el destino no pueden ser la misma sucursal.", "error");
      return;
    }
    if (!TRASLADO_ITEMS.length) {
      showToast("Agregá al menos un producto al remito.", "error");
      return;
    }

    crearTraslado(sucursalOrigenId, sucursalDestinoId, TRASLADO_ITEMS, nota).then((numero) => {
      if (!numero) return;
      TRASLADO_ITEMS = [];
      form.reset();
      renderTrasladoItemsTable();
      populateTrasladoSucursalSelects();
    });
  });
}

/* Genera el número de remisión de forma correlativa (REM-0001, REM-0002, ...)
   usando un contador guardado en el propio documento negocios/{negocioId} —
   se incrementa dentro de la misma transacción que crea el traslado, para
   que dos remisiones creadas casi al mismo tiempo nunca puedan repetir número. */
function crearTraslado(sucursalOrigenId, sucursalDestinoId, items, nota) {
  if (!isCurrentUserAdmin()) {
    showToast("Solo un Administrador puede generar traslados entre sucursales.", "error");
    return Promise.resolve(null);
  }

  const productosConNombre = items.map((it) => {
    const p = getProduct(it.productId);
    return {
      productId: it.productId,
      nombre: p ? p.nombre : "Producto eliminado",
      sku: p ? p.sku : "",
      cantidadEnviada: it.cantidad
    };
  });

  if (isFirebaseReady() && NEGOCIO_ID) {
    const db = getFirestoreDb();
    const negocioRef = db.collection("negocios").doc(NEGOCIO_ID);
    const trasladoRef = negocioRef.collection("traslados").doc();

    return db.runTransaction((transaction) => {
      return transaction.get(negocioRef).then((negocioSnap) => {
        const contadorActual = (negocioSnap.exists && negocioSnap.data().contadorRemisiones) || 0;
        const siguiente = contadorActual + 1;
        const numero = `REM-${String(siguiente).padStart(4, "0")}`;
        // FIX: algunos negocios nunca tienen el documento negocios/{negocioId}
        // creado formalmente (solo existen sus subcolecciones, como sucursales
        // — ver la misma nota en diagnostico-temporal.js). transaction.update()
        // exige que el documento YA exista, así que fallaba con "Can't update a
        // document that doesn't exist" y el traslado nunca se creaba. set() con
        // merge:true funciona lo mismo si existe, y además lo crea si no existía.
        transaction.set(negocioRef, { contadorRemisiones: siguiente }, { merge: true });
        transaction.set(trasladoRef, {
          numero,
          sucursalOrigenId,
          sucursalDestinoId,
          sucursalOrigenNombre: sucursalName(sucursalOrigenId),
          sucursalDestinoNombre: sucursalName(sucursalDestinoId),
          productos: productosConNombre,
          nota: nota || "",
          estado: "pendiente",
          creadoPorUid: CURRENT_USER.uid,
          creadoPorNombre: nombreUsuarioActual(),
          fechaCreacion: new Date().toISOString()
        });
        return numero;
      });
    })
      .then((numero) => {
        showToast(`Remisión ${numero} creada. Queda pendiente de recepción en ${sucursalName(sucursalDestinoId)}.`, "success");
        return numero;
      })
      .catch((err) => {
        console.error("No se pudo crear el traslado.", err);
        showToast("No se pudo crear el traslado. Probá de nuevo.", "error");
        return null;
      });
  }

  // ---- Modo demo (sin Firebase) ----
  STORE.settings.contadorRemisiones = (STORE.settings.contadorRemisiones || 0) + 1;
  const numero = `REM-${String(STORE.settings.contadorRemisiones).padStart(4, "0")}`;
  STORE.traslados.push({
    id: uid("t"),
    numero,
    sucursalOrigenId,
    sucursalDestinoId,
    sucursalOrigenNombre: sucursalName(sucursalOrigenId),
    sucursalDestinoNombre: sucursalName(sucursalDestinoId),
    productos: productosConNombre,
    nota: nota || "",
    estado: "pendiente",
    creadoPorUid: CURRENT_USER.uid,
    creadoPorNombre: nombreUsuarioActual(),
    fechaCreacion: new Date().toISOString()
  });
  saveStore();
  renderTraslados();
  showToast(`Remisión ${numero} creada (modo demo).`, "success");
  return Promise.resolve(numero);
}

/* Cancela un traslado que todavía está pendiente. Como el stock no se mueve
   hasta que el destino confirma, cancelar es seguro: no hay nada que revertir. */
function cancelarTraslado(trasladoId) {
  if (!isCurrentUserAdmin()) {
    showToast("Solo un Administrador puede cancelar un traslado.", "error");
    return;
  }
  if (isFirebaseReady() && NEGOCIO_ID) {
    const db = getFirestoreDb();
    db.collection("negocios").doc(NEGOCIO_ID).collection("traslados").doc(trasladoId)
      .update({ estado: "cancelado" })
      .then(() => showToast("Traslado cancelado.", "success"))
      .catch((err) => {
        console.error("No se pudo cancelar el traslado.", err);
        showToast("No se pudo cancelar el traslado.", "error");
      });
    return;
  }
  const t = STORE.traslados.find((x) => x.id === trasladoId);
  if (t) {
    t.estado = "cancelado";
    saveStore();
    renderTraslados();
    showToast("Traslado cancelado.", "success");
  }
}

const TRASLADO_ESTADO_TAG = {
  pendiente: `<span class="status-tag status-low">Pendiente</span>`,
  recibido: `<span class="status-tag status-ok">Recibido</span>`,
  cancelado: `<span class="status-tag status-critical">Cancelado</span>`
};

function renderTraslados() {
  populateTrasladoSucursalSelects();
  // FIX: antes esto se poblaba una única vez en setupTrasladoForm(), al cargar
  // la página — si en ese momento STORE.products todavía no había llegado de
  // Firestore (lo normal, porque es asíncrono), el <select> quedaba vacío para
  // siempre y "Agregar manualmente" no tenía nada para agregar. Ahora se
  // repuebla cada vez que se renderiza la sección (cada snapshot de productos
  // o traslados dispara renderTraslados()), igual que ya hacen Entradas/Salidas.
  const manualSelect = document.getElementById("trasladoProductoManual");
  if (manualSelect) populateProductSelect(manualSelect, "", document.getElementById("trasladoOrigen").value);
  renderTrasladoItemsTable();

  const tbody = document.getElementById("trasladosTableBody");
  const empty = document.getElementById("trasladosEmptyState");
  if (!tbody) return;

  const items = trasladosVisibles();
  const admin = isCurrentUserAdmin();
  const miSucursal = currentUserSucursalId();

  tbody.innerHTML = items
    .map((t) => {
      const puedeRecibir = t.estado === "pendiente" && (admin || miSucursal === t.sucursalDestinoId);
      const puedeCancelar = t.estado === "pendiente" && admin;
      const acciones = [
        puedeRecibir ? `<button class="btn-secondary" data-recibir-traslado="${t.id}"><i data-lucide="package-check" class="h-4 w-4"></i> Recibir</button>` : "",
        puedeCancelar ? `<button class="icon-btn danger" data-cancelar-traslado="${t.id}" aria-label="Cancelar"><i data-lucide="x-circle" class="h-4 w-4"></i></button>` : ""
      ].join(" ");
      return `<tr>
        <td class="font-mono font-semibold text-ink">${t.numero}</td>
        <td class="font-mono text-xs text-slate-400">${formatDate(t.fechaCreacion)}</td>
        <td class="text-slate-500">${t.sucursalOrigenNombre || sucursalName(t.sucursalOrigenId)}</td>
        <td class="text-slate-500">${t.sucursalDestinoNombre || sucursalName(t.sucursalDestinoId)}</td>
        <td>${TRASLADO_ESTADO_TAG[t.estado] || t.estado}</td>
        <td class="text-slate-400">${t.creadoPorNombre || "—"}</td>
        <td class="text-right"><div class="flex justify-end gap-2">${acciones || "—"}</div></td>
      </tr>`;
    })
    .join("");

  empty.classList.toggle("hidden", items.length > 0);
  refreshIcons();

  tbody.querySelectorAll("[data-recibir-traslado]").forEach((btn) => {
    btn.addEventListener("click", () => abrirRecepcionTraslado(btn.getAttribute("data-recibir-traslado")));
  });
  tbody.querySelectorAll("[data-cancelar-traslado]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const t = items.find((x) => x.id === btn.getAttribute("data-cancelar-traslado"));
      openConfirmModal(
        "Cancelar traslado",
        `¿Seguro que querés cancelar la remisión <strong>${t.numero}</strong>? Como todavía no se descontó stock, no hace falta revertir nada.`,
        "Cancelar traslado",
        () => cancelarTraslado(t.id)
      );
    });
  });

  actualizarBadgeTraslados(items);
}

function actualizarBadgeTraslados(items) {
  const badge = document.getElementById("sidebarTrasladosBadge");
  if (!badge) return;
  const admin = isCurrentUserAdmin();
  const miSucursal = currentUserSucursalId();
  const pendientesQueMeTocan = items.filter((t) => t.estado === "pendiente" && (admin ? true : miSucursal === t.sucursalDestinoId));
  const count = pendientesQueMeTocan.length;
  badge.textContent = count;
  badge.classList.toggle("hidden", count === 0);
}

/* ---------------------------- Recepción de un traslado ---------------------------- */
let TRASLADO_EN_RECEPCION = null; // { traslado, cantidades: { [productId]: number }, motivos: { [productId]: string } }

function abrirRecepcionTraslado(trasladoId) {
  const traslado = STORE.traslados.find((t) => t.id === trasladoId);
  if (!traslado || traslado.estado !== "pendiente") {
    showToast("Ese traslado ya no está disponible para recibir.", "error");
    return;
  }
  TRASLADO_EN_RECEPCION = {
    traslado,
    cantidades: {},
    motivos: {}
  };
  traslado.productos.forEach((p) => { TRASLADO_EN_RECEPCION.cantidades[p.productId] = 0; });

  document.getElementById("recibirTrasladoNumero").textContent = traslado.numero;
  document.getElementById("recibirTrasladoResumen").textContent =
    `De ${traslado.sucursalOrigenNombre || sucursalName(traslado.sucursalOrigenId)} hacia ${traslado.sucursalDestinoNombre || sucursalName(traslado.sucursalDestinoId)} — generado por ${traslado.creadoPorNombre || "—"} el ${formatDate(traslado.fechaCreacion)}.`;

  document.getElementById("panelNuevoTraslado").classList.add("hidden");
  document.getElementById("panelRecibirTraslado").classList.remove("hidden");
  renderRecepcionItemsTable();
  document.getElementById("recibirScan").value = "";
  document.getElementById("recibirScan").focus();
}

function cerrarRecepcionTraslado() {
  TRASLADO_EN_RECEPCION = null;
  document.getElementById("panelRecibirTraslado").classList.add("hidden");
  applyRoleVisibility(); // vuelve a mostrar/ocultar "Nuevo traslado" según corresponda
}

function renderRecepcionItemsTable() {
  if (!TRASLADO_EN_RECEPCION) return;
  const { traslado, cantidades, motivos } = TRASLADO_EN_RECEPCION;
  const tbody = document.getElementById("recibirItemsBody");
  tbody.innerHTML = traslado.productos
    .map((p) => {
      const recibido = cantidades[p.productId] || 0;
      const diferencia = p.cantidadEnviada - recibido;
      return `<tr>
        <td class="font-medium text-ink">${p.nombre}</td>
        <td class="font-mono text-xs text-slate-400">${p.sku || "—"}</td>
        <td class="font-mono">${p.cantidadEnviada}</td>
        <td><input type="number" min="0" step="1" class="form-input" data-recibido="${p.productId}" value="${recibido}" style="padding:0.4rem 0.6rem"></td>
        <td>
          <input type="text" class="form-input" data-motivo="${p.productId}" placeholder="${diferencia !== 0 ? "Ej: rotura en el traslado" : "—"}" value="${motivos[p.productId] || ""}" ${diferencia === 0 ? "disabled" : ""} style="padding:0.4rem 0.6rem">
        </td>
      </tr>`;
    })
    .join("");

  tbody.querySelectorAll("[data-recibido]").forEach((input) => {
    input.addEventListener("change", () => {
      const productId = input.getAttribute("data-recibido");
      const val = parseInt(input.value, 10);
      TRASLADO_EN_RECEPCION.cantidades[productId] = val >= 0 ? val : 0;
      renderRecepcionItemsTable();
    });
  });
  tbody.querySelectorAll("[data-motivo]").forEach((input) => {
    input.addEventListener("input", () => {
      const productId = input.getAttribute("data-motivo");
      TRASLADO_EN_RECEPCION.motivos[productId] = input.value;
    });
  });
}

function setupRecepcionTraslado() {
  const cerrarBtn = document.getElementById("cerrarRecibirTraslado");
  if (!cerrarBtn) return;
  cerrarBtn.addEventListener("click", () => {
    openConfirmModal(
      "Cerrar sin confirmar",
      "¿Cerrar esta recepción sin confirmar? Lo que hayas cargado no se guarda.",
      "Cerrar",
      () => cerrarRecepcionTraslado()
    );
  });

  const scanInput = document.getElementById("recibirScan");
  function sumarPorCodigo(code) {
    if (!TRASLADO_EN_RECEPCION) return;
    const product = findProductByCode(code);
    if (!product) {
      showToast(`No se encontró ningún producto con el código ${code}.`, "error");
      return;
    }
    const perteneceAlRemito = TRASLADO_EN_RECEPCION.traslado.productos.some((p) => p.productId === product.id);
    if (!perteneceAlRemito) {
      showToast(`${product.nombre} no forma parte de este remito.`, "error");
      return;
    }
    TRASLADO_EN_RECEPCION.cantidades[product.id] = (TRASLADO_EN_RECEPCION.cantidades[product.id] || 0) + 1;
    renderRecepcionItemsTable();
    showToast(`+1 ${product.nombre} (${TRASLADO_EN_RECEPCION.cantidades[product.id]} contadas)`, "success");
  }
  scanInput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const code = scanInput.value.trim();
    if (!code) return;
    sumarPorCodigo(code);
    scanInput.value = "";
  });
  document.getElementById("recibirScanCam").addEventListener("click", () => {
    openCameraScanner((decodedText) => sumarPorCodigo(decodedText));
  });

  document.getElementById("confirmarRecepcionBtn").addEventListener("click", () => {
    if (!TRASLADO_EN_RECEPCION) return;
    const { traslado, cantidades, motivos } = TRASLADO_EN_RECEPCION;
    const recepciones = traslado.productos.map((p) => ({
      productId: p.productId,
      cantidadRecibida: cantidades[p.productId] || 0,
      motivoDiferencia: motivos[p.productId] || ""
    }));
    const conDiferenciaSinMotivo = recepciones.some((r) => {
      const enviado = traslado.productos.find((p) => p.productId === r.productId);
      return enviado && enviado.cantidadEnviada !== r.cantidadRecibida && !r.motivoDiferencia.trim();
    });
    if (conDiferenciaSinMotivo) {
      showToast("Hay productos con una cantidad distinta a la enviada: indicá el motivo de la diferencia antes de confirmar.", "error");
      return;
    }
    openConfirmModal(
      "Confirmar recepción",
      `¿Confirmar la recepción de <strong>${traslado.numero}</strong>? Esto va a actualizar el stock de ambas sucursales y no se puede deshacer.`,
      "Confirmar",
      () => confirmarRecepcionTraslado(traslado.id, recepciones)
    );
  });
}

/* Llama al endpoint serverless (ver nota al inicio de este bloque sobre por
   qué esto no se hace directo contra Firestore desde el navegador). */
async function confirmarRecepcionTraslado(trasladoId, recepciones) {
  if (!isFirebaseReady()) {
    // ---- Modo demo (sin Firebase, sin backend): se resuelve todo acá mismo ----
    const traslado = STORE.traslados.find((t) => t.id === trasladoId);
    if (!traslado) return;
    recepciones.forEach((r) => {
      const p = getProduct(r.productId);
      if (!p) return;
      const enviado = traslado.productos.find((x) => x.productId === r.productId);
      const cantidadEnviada = enviado ? enviado.cantidadEnviada : 0;
      if (!p.stockPorSucursal) p.stockPorSucursal = {};
      const sinDiscriminar = Object.keys(p.stockPorSucursal).length === 0;
      const stockOrigenActual = sinDiscriminar ? (p.stock || 0) : (p.stockPorSucursal[traslado.sucursalOrigenId] || 0);
      const stockDestinoActual = sinDiscriminar ? 0 : (p.stockPorSucursal[traslado.sucursalDestinoId] || 0);
      p.stockPorSucursal[traslado.sucursalOrigenId] = stockOrigenActual - cantidadEnviada;
      p.stockPorSucursal[traslado.sucursalDestinoId] = stockDestinoActual + r.cantidadRecibida;

      const diferencia = cantidadEnviada - r.cantidadRecibida;
      STORE.movements.push({
        id: uid("m"), tipo: "salida", productId: r.productId, cantidad: cantidadEnviada,
        nota: `Traslado ${traslado.numero} → ${traslado.sucursalDestinoNombre}`,
        sucursalId: traslado.sucursalOrigenId, montoTotal: 0, esTraslado: true, trasladoId,
        creadoPorUid: traslado.creadoPorUid, creadoPorNombre: traslado.creadoPorNombre,
        fecha: new Date().toISOString()
      });
      STORE.movements.push({
        id: uid("m"), tipo: "entrada", productId: r.productId, cantidad: r.cantidadRecibida,
        nota: `Traslado ${traslado.numero} ← ${traslado.sucursalOrigenNombre}${diferencia !== 0 ? ` · diferencia ${diferencia > 0 ? "-" : "+"}${Math.abs(diferencia)} (${r.motivoDiferencia || "sin motivo"})` : ""}`,
        sucursalId: traslado.sucursalDestinoId, montoTotal: 0, esTraslado: true, trasladoId,
        creadoPorUid: CURRENT_USER.uid, creadoPorNombre: nombreUsuarioActual(),
        fecha: new Date().toISOString()
      });
    });
    traslado.estado = "recibido";
    traslado.recepcion = {
      fecha: new Date().toISOString(),
      recibidoPorUid: CURRENT_USER.uid,
      recibidoPorNombre: nombreUsuarioActual(),
      productos: recepciones.map((r) => {
        const enviado = traslado.productos.find((p) => p.productId === r.productId);
        const cantidadEnviada = enviado ? enviado.cantidadEnviada : 0;
        return { productId: r.productId, cantidadRecibida: r.cantidadRecibida, diferencia: cantidadEnviada - r.cantidadRecibida, motivoDiferencia: r.motivoDiferencia || "" };
      })
    };
    saveStore();
    cerrarRecepcionTraslado();
    renderTraslados();
    renderEntradas();
    renderSalidas();
    renderDashboard();
    showToast(`Recepción de ${traslado.numero} confirmada (modo demo).`, "success");
    return;
  }

  const idToken = await getIdTokenSafe();
  try {
    const res = await fetch(`${API_BASE}/api/confirmar-traslado`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}) },
      body: JSON.stringify({ trasladoId, recepciones })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showToast(data.error || "No se pudo confirmar la recepción.", "error");
      return;
    }
    showToast("Recepción confirmada. El stock de ambas sucursales ya se actualizó.", "success");
    cerrarRecepcionTraslado();
    // Los onSnapshot de productos/movimientos/traslados refrescan solos el resto de la pantalla.
  } catch (err) {
    console.error("Error llamando a /api/confirmar-traslado:", err);
    showToast("No se pudo conectar con el servidor. ¿Ya desplegaste /api/confirmar-traslado en Vercel?", "error");
  }
}

setupTrasladoForm();
setupRecepcionTraslado();

/* =========================================================================
   INVENTARIO
   ========================================================================= */
/* Para el Administrador, deja elegir "Todas las sucursales" (stock agregado del
   negocio, como antes) o una sucursal puntual (stock real de esa sucursal) —
   así puede comparar sucursal por sucursal en vez de solo ver el total
   sumado, que podía tapar que una estuviera con exceso y otra en cero. Un
   encargado sigue viendo, fijo, solo la suya (mismo patrón que ya usan los
   filtros del Dashboard). */
function populateInventarioSucursalFilter() {
  const select = document.getElementById("inventarioSucursalFilter");
  if (!select) return;
  const fixedId = currentUserSucursalId();
  if (!fixedId) {
    const current = select.value;
    select.innerHTML = `<option value="">Todas las sucursales</option>` + STORE.sucursales.map((s) => `<option value="${s.id}">${s.nombre}</option>`).join("");
    select.disabled = false;
    if (STORE.sucursales.some((s) => s.id === current)) select.value = current;
  } else {
    const s = getSucursal(fixedId);
    select.innerHTML = s ? `<option value="${s.id}">${s.nombre}</option>` : `<option value="">Sin sucursal asignada</option>`;
    select.disabled = true;
  }
}

function renderInventario() {
  populateInventarioSucursalFilter();
  const search = document.getElementById("inventarioSearch").value.trim().toLowerCase();
  const statusFilter = document.getElementById("inventarioStatusFilter").value;
  const mappedStatus = STATUS_FILTER_MAP[statusFilter] || "";
  const sucursalFiltroId = document.getElementById("inventarioSucursalFilter").value;

  const conStock = STORE.products.map((p) => ({
    p,
    stockAqui: sucursalFiltroId ? stockDeSucursal(p, sucursalFiltroId) : stockVisible(p),
    status: sucursalFiltroId ? productStatusFor(p, sucursalFiltroId) : productStatus(p)
  }));

  const filtered = conStock.filter(({ p, status }) => {
    const matchesSearch = !search || p.nombre.toLowerCase().includes(search) || p.sku.toLowerCase().includes(search);
    const matchesStatus = !mappedStatus || status === mappedStatus;
    return matchesSearch && matchesStatus;
  });

  const tbody = document.getElementById("inventarioTableBody");
  tbody.innerHTML = filtered.length
    ? filtered
        .map(
          ({ p, stockAqui, status }) => `<tr>
            <td class="font-mono text-xs text-slate-400">${p.sku}</td>
            <td class="font-medium text-ink">${p.nombre}</td>
            <td class="text-slate-400">${p.categoria}</td>
            <td class="font-mono">${stockAqui}</td>
            <td class="font-mono">${p.stockMinimo}</td>
            <td class="font-mono">${formatMoney(stockAqui * p.precio)}</td>
            <td>${statusTagHtml(status)}</td>
          </tr>`
        )
        .join("")
    : `<tr><td colspan="7" class="empty-state">No encontramos productos con ese criterio.</td></tr>`;
}

document.getElementById("inventarioSucursalFilter").addEventListener("change", renderInventario);
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
  if (key === "7dias") {
    const start7 = new Date(now);
    start7.setDate(start7.getDate() - 6);
    start7.setHours(0, 0, 0, 0);
    return { start: start7, end };
  }
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
  const sucursalId = document.getElementById("repSucursal").value;

  let start = desdeInput ? new Date(`${desdeInput}T00:00:00`) : null;
  let end = hastaInput ? new Date(`${hastaInput}T23:59:59`) : null;

  if (!desdeInput && !hastaInput && reportQuickFilter !== "todo") {
    const range = quickFilterRange(reportQuickFilter);
    if (range) {
      start = range.start;
      end = range.end;
    }
  }

  return { start, end, tipo, categoria, orden, sucursalId };
}

/* Puebla el filtro de sucursal de Reportes. El Administrador puede elegir
   cualquier sucursal (o "Todas"); otros roles quedan fijos en la suya. */
function populateReportSucursalFilter() {
  const select = document.getElementById("repSucursal");
  const fixedId = currentUserSucursalId();
  if (!fixedId) {
    const current = select.value;
    select.innerHTML = `<option value="">Todas las sucursales</option>` + STORE.sucursales.map((s) => `<option value="${s.id}">${s.nombre}</option>`).join("");
    select.disabled = false;
    if (STORE.sucursales.some((s) => s.id === current)) select.value = current;
  } else {
    const s = getSucursal(fixedId);
    select.innerHTML = s ? `<option value="${s.id}">${s.nombre}</option>` : `<option value="">Sin sucursal asignada</option>`;
    select.disabled = true;
  }
}

function getFilteredReportMovements() {
  const { start, end, tipo, categoria, orden, sucursalId } = getReportFilters();

  let filtered = visibleMovements().filter((m) => {
    const fecha = new Date(m.fecha);
    const matchesStart = !start || fecha >= start;
    const matchesEnd = !end || fecha <= end;
    const matchesTipo = !tipo || m.tipo === tipo;
    const matchesSucursal = !sucursalId || m.sucursalId === sucursalId;
    const product = getProduct(m.productId);
    const matchesCategoria = !categoria || (product && product.categoria === categoria);
    return matchesStart && matchesEnd && matchesTipo && matchesSucursal && matchesCategoria;
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
        <td class="text-slate-400">${sucursalName(m.sucursalId)}</td>
        <td>${m.tipo === "entrada" ? `<span class="status-tag status-ok">Entrada</span>` : `<span class="status-tag status-critical">Salida</span>`}</td>
        <td class="font-medium text-ink">${product ? product.nombre : "Producto eliminado"}</td>
        <td class="text-slate-400">${product ? product.categoria : "—"}</td>
        <td class="font-mono ${m.tipo === "entrada" ? "text-greendark" : "text-red-500"}">${m.tipo === "entrada" ? "+" : "−"}${m.cantidad}</td>
        <td class="text-slate-400">${m.nota || "—"}</td>
        <td class="text-slate-400">${m.creadoPorNombre || "—"}</td>
      </tr>`;
    })
    .join("");

  empty.classList.toggle("hidden", filtered.length > 0);
  document.getElementById("repResultCount").textContent = `${filtered.length} movimiento${filtered.length === 1 ? "" : "s"} encontrado${filtered.length === 1 ? "" : "s"}`;
}

function renderReportes() {
  renderDonut(document.getElementById("reportDonut"), document.getElementById("reportDonutLegend"));

  const totalIn = STORE.movements.filter((m) => m.tipo === "entrada" && !m.esTraslado).reduce((s, m) => s + m.cantidad, 0);
  const totalOut = STORE.movements.filter((m) => m.tipo === "salida" && !m.esTraslado).reduce((s, m) => s + m.cantidad, 0);
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

  const topProducts = [...STORE.products].sort((a, b) => stockVisible(b) - stockVisible(a)).slice(0, 5);
  const maxStock = Math.max(...topProducts.map((p) => stockVisible(p)), 1);
  const topStockBars = document.getElementById("topStockBars");
  topStockBars.innerHTML = topProducts
    .map(
      (p) => `<div class="bar-row">
        <span class="bar-label" title="${p.nombre}">${p.nombre.length > 16 ? p.nombre.slice(0, 15) + "…" : p.nombre}</span>
        <span class="bar-track"><span class="bar-fill bar-fill-stock" style="width:0%" data-width="${(stockVisible(p) / maxStock) * 100}"></span></span>
        <span class="bar-value">${stockVisible(p)}</span>
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
  populateReportSucursalFilter();
  renderReportMovementsTable();
}

["repDesde", "repHasta", "repTipo", "repCategoria", "repOrden", "repSucursal"].forEach((id) => {
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
  { id: "colSucursal", header: "Sucursal", key: "sucursal", width: 16 },
  { id: "colTipo", header: "Tipo", key: "tipo", width: 12 },
  { id: "colProducto", header: "Producto", key: "producto", width: 30 },
  { id: "colCategoria", header: "Categoría", key: "categoria", width: 18 },
  { id: "colCantidad", header: "Cantidad", key: "cantidad", width: 12 },
  { id: "colNota", header: "Nota", key: "nota", width: 34 },
  { id: "colRegistradoPor", header: "Registrado por", key: "registradoPor", width: 22 }
];

function getReportColumnValue(key, m, p) {
  switch (key) {
    case "fecha": return formatDate(m.fecha);
    case "sucursal": return sucursalName(m.sucursalId);
    case "tipo": return m.tipo === "entrada" ? "Entrada" : "Salida";
    case "producto": return p ? p.nombre : "Producto eliminado";
    case "categoria": return p ? p.categoria : "—";
    case "cantidad": return `${m.tipo === "entrada" ? "+" : "-"}${m.cantidad}`;
    case "nota": return m.nota || "—";
    case "registradoPor": return m.creadoPorNombre || "—";
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
  const totalIn = filtered.filter((m) => m.tipo === "entrada" && !m.esTraslado).reduce((s, m) => s + m.cantidad, 0);
  const totalOut = filtered.filter((m) => m.tipo === "salida" && !m.esTraslado).reduce((s, m) => s + m.cantidad, 0);

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
  const totalIn = filtered.filter((m) => m.tipo === "entrada" && !m.esTraslado).reduce((s, m) => s + m.cantidad, 0);
  const totalOut = filtered.filter((m) => m.tipo === "salida" && !m.esTraslado).reduce((s, m) => s + m.cantidad, 0);
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
/* FIX (alertas sin sucursal): antes esta lista mostraba una sola alerta por
   producto, calculada sobre stockVisible() — para el Administrador eso es el
   TOTAL sumado de todas las sucursales, así que si una sucursal estaba en 0
   pero otra tenía de sobra, el total podía dar "OK" y la alerta ni aparecía; y
   aunque apareciera, no decía en qué sucursal reponer. Ahora, para el
   Administrador, se arma una alerta POR CADA sucursal donde ese producto esté
   bajo su mínimo (usando productStatusFor/stockDeSucursal), mostrando el
   nombre de la sucursal. Un encargado sigue viendo solo lo de su propia
   sucursal, igual que antes. */
function renderAlertas() {
  const list = document.getElementById("alertsList");
  const empty = document.getElementById("alertsEmptyState");
  const alerts = calcularAlertasStock();

  alerts.sort((a, b) => stockDeSucursal(a.product, a.sucursalId) - stockDeSucursal(b.product, b.sucursalId));

  list.innerHTML = alerts
    .map(({ product: p, sucursalId }) => {
      const stockAca = stockDeSucursal(p, sucursalId);
      const status = statusForStock(stockAca, p.stockMinimo);
      return `<div class="alert-card ${status}">
        <span class="alert-icon">
          <i data-lucide="${status === "critical" ? "alert-octagon" : "alert-triangle"}" class="h-4 w-4"></i>
        </span>
        <div class="flex-1">
          <p class="font-semibold text-sm text-ink">${p.nombre} <span class="text-xs text-slate-400 font-normal">· ${p.sku}</span></p>
          <p class="text-xs text-slate-500 mt-0.5">
            <span class="alert-sucursal-pill"><i data-lucide="store" class="h-3 w-3"></i> ${sucursalName(sucursalId)}</span>
            Quedan ${stockAca} unidades — el mínimo es ${p.stockMinimo}.
          </p>
        </div>
        <button class="btn-secondary shrink-0" data-restock="${p.id}" data-restock-sucursal="${sucursalId}">
          <i data-lucide="arrow-down-to-line" class="h-4 w-4"></i>
          Reponer
        </button>
      </div>`;
    })
    .join("");

  empty.classList.toggle("hidden", alerts.length > 0);
  refreshIcons();
  updateAlertBadges();

  list.querySelectorAll("[data-restock]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-restock");
      const sucursalId = btn.getAttribute("data-restock-sucursal");
      switchSection("entradas");
      requestAnimationFrame(() => {
        document.getElementById("entradaProducto").value = id;
        const sucursalSelect = document.getElementById("entradaSucursal");
        if (sucursalSelect && !sucursalSelect.disabled && sucursalId) sucursalSelect.value = sucursalId;
        document.getElementById("entradaCantidad").focus();
      });
    });
  });
}

/* =========================================================================
   USUARIOS
   ========================================================================= */
function roleBadgeColor(rol) {
  return { Administrador: "status-critical", Encargado: "status-low", Editor: "status-low", Visualizador: "status-ok" }[rol] || "status-ok";
}

/* La página "Usuarios" ahora refleja las cuentas REALES: el dueño de la cuenta
   (Administrador, acceso ilimitado) y los encargados creados desde Sucursales →
   "Nuevo encargado" (STORE.encargados / Firestore, con contraseña real). Ya no
   existe un "Invitar usuario" separado acá: ese formulario guardaba un registro
   solamente local, que nunca creaba una cuenta con la que alguien pudiera
   iniciar sesión, así que un encargado invitado por ahí jamás iba a aparecer
   con un estado real (activo/pendiente/etc.) — porque no era una cuenta real.
   Ahora esta tabla usa la misma fuente de datos que "Encargados de sucursal"
   (renderEncargados), así el estado siempre coincide entre las dos pantallas. */
function renderUsuarios() {
  const tbody = document.getElementById("usersTableBody");
  const empty = document.getElementById("usersEmptyState");
  if (!tbody) return;

  const pendientes = Object.values(PENDING_ENCARGADOS).map((p) => ({ ...p, id: null }));
  const encargados = [...STORE.encargados, ...pendientes];

  const filas = [];
  if (CURRENT_USER) {
    filas.push({
      esDueno: true,
      nombre: CURRENT_USER.nombre || CURRENT_USER.email || "Administrador",
      email: CURRENT_USER.email || "",
      rol: "Administrador",
      sucursalLabel: "Todas",
      estadoClass: "encargado-status-activo",
      estadoLabel: isCreatorAccount() ? "Activo · ilimitado" : "Activo"
    });
  }
  encargados.forEach((e) => {
    const estadoClass = e.id
      ? (e.activo === false ? "encargado-status-error" : "encargado-status-activo")
      : (e.estado === "error" ? "encargado-status-error" : "encargado-status-pendiente");
    const estadoLabel = e.id
      ? (e.activo === false ? "Deshabilitado" : "Activo")
      : (e.estado === "error" ? "Error al crear" : "Creando...");
    filas.push({ esDueno: false, raw: e, nombre: e.nombre, email: e.email, rol: "Encargado", sucursalLabel: sucursalName(e.sucursalId), estadoClass, estadoLabel });
  });

  tbody.innerHTML = filas
    .map((f) => {
      const actions = f.esDueno
        ? `<span class="text-xs text-slate-400">Es tu cuenta</span>`
        : f.raw.id
        ? `<button class="icon-btn" data-us-invite="${f.raw.id}" aria-label="Reenviar invitación"><i data-lucide="send" class="h-4 w-4"></i></button>
           <button class="icon-btn danger" data-us-toggle="${f.raw.id}" data-disabled="${f.raw.activo === false}" aria-label="${f.raw.activo === false ? "Reactivar" : "Deshabilitar"}"><i data-lucide="${f.raw.activo === false ? "rotate-ccw" : "user-x"}" class="h-4 w-4"></i></button>`
        : `<span class="text-xs text-slate-400">—</span>`;
      return `<tr>
        <td class="font-medium text-ink">
          <span class="avatar-sm">${(f.nombre || "?").charAt(0)}</span>
          ${f.nombre}${f.esDueno ? ` <span class="status-tag status-ok">Vos</span>` : ""}
        </td>
        <td class="text-slate-400">${f.email}</td>
        <td><span class="status-tag ${roleBadgeColor(f.esDueno ? "Administrador" : "Encargado")}">${f.rol}</span></td>
        <td class="text-slate-400">${f.sucursalLabel}</td>
        <td class="${f.estadoClass} font-mono text-xs">${f.estadoLabel}</td>
        <td class="text-right">${actions}</td>
      </tr>`;
    })
    .join("");

  if (empty) empty.classList.toggle("hidden", filas.length > 0);
  refreshIcons();

  tbody.querySelectorAll("[data-us-invite]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const enc = STORE.encargados.find((x) => x.id === btn.getAttribute("data-us-invite"));
      if (enc) openInviteModal({ nombre: enc.nombre, email: enc.email, sucursalId: enc.sucursalId, password: null });
    });
  });

  tbody.querySelectorAll("[data-us-toggle]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const encUid = btn.getAttribute("data-us-toggle");
      const enc = STORE.encargados.find((x) => x.id === encUid);
      const yaDeshabilitado = btn.getAttribute("data-disabled") === "true";
      const accion = yaDeshabilitado ? "reactivar" : "deshabilitar";
      openConfirmModal(
        yaDeshabilitado ? "Reactivar encargado" : "Deshabilitar encargado",
        `¿Seguro que querés ${accion} el acceso de <strong>${enc.nombre}</strong>? ${yaDeshabilitado ? "Va a poder volver a iniciar sesión." : "No va a poder iniciar sesión hasta que lo reactives."}`,
        yaDeshabilitado ? "Reactivar" : "Deshabilitar",
        () => toggleEncargado(encUid, !yaDeshabilitado)
      );
    });
  });
}

/* El botón de arriba de "Usuarios" ya no abre un formulario propio: lleva
   directo a Sucursales y abre el mismo modal de "Nuevo encargado" que ya
   crea la cuenta real (con contraseña, Firebase Auth, todo). */
document.getElementById("goToSucursalesForInvite").addEventListener("click", () => {
  switchSection("sucursales");
  requestAnimationFrame(() => openEncargadoForm());
});

/* =========================================================================
   SUCURSALES
   ========================================================================= */
function renderSucursales() {
  const tbody = document.getElementById("sucursalesTableBody");
  tbody.innerHTML = STORE.sucursales
    .map((s) => {
      const cantidadUsuarios = STORE.users.filter((u) => u.rol !== "Administrador" && u.sucursalId === s.id).length;
      const esUnica = STORE.sucursales.length <= 1;
      return `<tr>
        <td class="font-medium text-ink">${s.nombre}</td>
        <td class="text-slate-400">${s.direccion || "—"}</td>
        <td class="text-slate-400">${cantidadUsuarios}</td>
        <td class="text-right">
          <button class="icon-btn" data-edit-sucursal="${s.id}" aria-label="Editar"><i data-lucide="pencil" class="h-4 w-4"></i></button>
          ${esUnica ? "" : `<button class="icon-btn danger" data-remove-sucursal="${s.id}" aria-label="Eliminar"><i data-lucide="trash-2" class="h-4 w-4"></i></button>`}
        </td>
      </tr>`;
    })
    .join("");

  refreshIcons();

  tbody.querySelectorAll("[data-edit-sucursal]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const s = STORE.sucursales.find((x) => x.id === btn.getAttribute("data-edit-sucursal"));
      openSucursalForm(s);
    });
  });

  tbody.querySelectorAll("[data-remove-sucursal]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const s = STORE.sucursales.find((x) => x.id === btn.getAttribute("data-remove-sucursal"));
      const enUso = STORE.users.some((u) => u.sucursalId === s.id) || STORE.movements.some((m) => m.sucursalId === s.id);
      openConfirmModal(
        "Eliminar sucursal",
        enUso
          ? `<strong>${s.nombre}</strong> tiene usuarios o movimientos cargados. Si la eliminás, esos usuarios van a quedar sin sucursal asignada hasta que les asignes otra. ¿Continuar?`
          : `¿Seguro que querés eliminar <strong>${s.nombre}</strong>?`,
        "Eliminar",
        () => {
          if (isFirebaseReady() && NEGOCIO_ID) {
            getFirestoreDb().collection("negocios").doc(NEGOCIO_ID).collection("sucursales").doc(s.id).delete()
              .then(() => showToast("Sucursal eliminada.", "success"))
              .catch((err) => {
                console.error("No se pudo eliminar la sucursal en Firestore.", err);
                showToast("No se pudo eliminar la sucursal. Probá de nuevo.", "error");
              });
            // El onSnapshot de suscribirSucursalesFirestore() refresca la tabla solo.
            // Nota: los usuarios/{uid} con esta sucursalId no se limpian automáticamente
            // acá todavía (eso queda para cuando migremos STORE.users, Paso 6D-usuarios).
            return;
          }
          // ---- Modo demo (sin Firebase) ----
          STORE.sucursales = STORE.sucursales.filter((x) => x.id !== s.id);
          STORE.users.forEach((u) => { if (u.sucursalId === s.id) u.sucursalId = null; });
          saveStore();
          renderSucursales();
          renderUsuarios();
          showToast("Sucursal eliminada.", "success");
        }
      );
    });
  });

  renderEncargados();
}

function openSucursalForm(sucursal) {
  const isEdit = Boolean(sucursal);
  const limitCheck = !isEdit ? checkPlanLimits("sucursal") : null;
  const limitExceeded = Boolean(limitCheck && !limitCheck.allowed);

  openModal(
    isEdit ? "Editar sucursal" : "Nueva sucursal",
    `${limitExceeded ? limitBannerHtml(limitCheck) : ""}
    <form id="sucursalForm" class="movement-form">
      <label class="form-label" style="margin-top:0">Nombre</label>
      <input id="sfNombre" type="text" class="form-input" placeholder="Ej: Sucursal Centro" value="${isEdit ? sucursal.nombre : ""}" required>
      <label class="form-label">Dirección (opcional)</label>
      <input id="sfDireccion" type="text" class="form-input" placeholder="Ej: Av. San Martín 1234" value="${isEdit ? sucursal.direccion || "" : ""}">
      <button type="submit" class="btn-primary w-full justify-center mt-4" ${limitExceeded ? "disabled" : ""}>
        <i data-lucide="${isEdit ? "save" : "plus"}" class="h-4 w-4"></i>
        ${isEdit ? "Guardar cambios" : "Crear sucursal"}
      </button>
    </form>`,
    (body) => {
      if (limitExceeded) {
        body.querySelectorAll("#sucursalForm input").forEach((el) => (el.disabled = true));
        const upgradeBtn = body.querySelector("#limitBannerUpgradeBtn");
        if (upgradeBtn) upgradeBtn.addEventListener("click", () => openUpgradeModal(limitCheck));
      }
      body.querySelector("#sucursalForm").addEventListener("submit", (e) => {
        e.preventDefault();
        if (limitExceeded) return;
        const nombre = body.querySelector("#sfNombre").value.trim();
        const direccion = body.querySelector("#sfDireccion").value.trim();

        if (isFirebaseReady() && NEGOCIO_ID) {
          const coleccion = getFirestoreDb().collection("negocios").doc(NEGOCIO_ID).collection("sucursales");
          const promesa = isEdit
            ? coleccion.doc(sucursal.id).update({ nombre, direccion })
            : coleccion.add({ nombre, direccion });
          promesa
            .then(() => {
              closeModal();
              showToast(isEdit ? "Sucursal actualizada." : "Sucursal creada.", "success");
              // El onSnapshot de suscribirSucursalesFirestore() refresca solo.
            })
            .catch((err) => {
              console.error("No se pudo guardar la sucursal en Firestore.", err);
              showToast("No se pudo guardar la sucursal. Probá de nuevo.", "error");
            });
          return;
        }

        // ---- Modo demo (sin Firebase) ----
        if (isEdit) {
          sucursal.nombre = nombre;
          sucursal.direccion = direccion;
        } else {
          STORE.sucursales.push({ id: uid("s"), nombre, direccion });
        }
        saveStore();
        closeModal();
        renderSucursales();
        renderUsuarios();
        showToast(isEdit ? "Sucursal actualizada." : "Sucursal creada.", "success");
      });
    }
  );
}

document.getElementById("openAddSucursal").addEventListener("click", () => openSucursalForm(null));

/* =========================================================================
   REQUERIMIENTO 4 — Encargados de sucursal (Vercel Serverless + Firebase Auth)
   =========================================================================
   Por qué esto NO usa firebase.auth().createUserWithEmailAndPassword() directo
   desde el navegador: esa llamada inicia sesión automáticamente con el usuario
   recién creado, lo que cerraría la sesión del Administrador que está logueado.
   La solución es delegar la creación a una Vercel Serverless Function que usa el
   Firebase Admin SDK (admin.auth().createUser), que no toca la sesión del cliente.
   Ver /api/create-encargado.js (creación) y /api/disable-encargado.js (baja).

   FIX: esta sección vivía enteramente en STORE.encargados (localStorage) — un
   invento aparte que ni siquiera reflejaba lo que create-encargado.js guarda
   en Firestore. Ahora STORE.encargados se llena en tiempo real desde la
   colección "users" (nivel raíz, misma donde vive el perfil del Admin),
   filtrando por negocioId + rol == "encargado" — ver suscribirEncargadosFirestore()
   más abajo. PENDING_ENCARGADOS es solo un overlay transitorio en memoria
   (nunca se persiste) para mostrar "Creando..." mientras el backend responde;
   apenas Firestore confirma el alta, el listener en tiempo real lo reemplaza
   por el dato real. */
let PENDING_ENCARGADOS = {};

function suscribirEncargadosFirestore(db) {
  if (unsubscribeEncargados) unsubscribeEncargados();
  unsubscribeEncargados = db.collection("users")
    .where("negocioId", "==", NEGOCIO_ID)
    .where("rol", "==", "encargado")
    .onSnapshot(
      (snapshot) => {
        STORE.encargados = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
        Object.keys(PENDING_ENCARGADOS).forEach((email) => {
          if (STORE.encargados.some((e) => e.email === email)) delete PENDING_ENCARGADOS[email];
        });
        renderEncargados();
      },
      (err) => console.error("Error escuchando encargados en Firestore.", err)
    );
}

function renderEncargados() {
  const tbody = document.getElementById("encargadosTableBody");
  const empty = document.getElementById("encargadosEmptyState");
  if (!tbody) return;

  const pendientes = Object.values(PENDING_ENCARGADOS).map((p) => ({ ...p, id: null }));
  const lista = [...STORE.encargados, ...pendientes];

  tbody.innerHTML = lista
    .map((e) => {
      const estadoClass = e.id
        ? (e.activo === false ? "encargado-status-error" : "encargado-status-activo")
        : (e.estado === "error" ? "encargado-status-error" : "encargado-status-pendiente");
      const estadoLabel = e.id
        ? (e.activo === false ? "Deshabilitado" : "Activo")
        : (e.estado === "error" ? "Error al crear" : "Creando...");
      // FIX: si se borró la sucursal a la que estaba asignado (o quedó con un
      // sucursalId que ya no existe por cualquier otro motivo), avisamos acá en
      // vez de mostrar sucursalName() en blanco silenciosamente — así el
      // Administrador ve de un vistazo quién quedó sin poder operar y necesita
      // que le reasignen una sucursal (botón "Cambiar sucursal" más abajo).
      const sucursalValida = e.id && STORE.sucursales.some((s) => s.id === e.sucursalId);
      const sucursalCelda = !e.id
        ? sucursalName(e.sucursalId)
        : sucursalValida
          ? sucursalName(e.sucursalId)
          : `<span class="status-tag status-critical">Sin sucursal</span>`;
      return `<tr>
        <td class="font-medium text-ink">
          <span class="avatar-sm">${e.nombre.charAt(0)}</span>
          ${e.nombre}
        </td>
        <td class="text-slate-400">${e.email}</td>
        <td class="text-slate-400">${sucursalCelda}</td>
        <td class="${estadoClass} font-mono text-xs">${estadoLabel}</td>
        <td class="text-right">
          <div class="flex justify-end gap-2">
            ${e.id ? `<button class="icon-btn" data-invite-encargado="${e.id}" aria-label="Reenviar invitación"><i data-lucide="send" class="h-4 w-4"></i></button>` : ""}
            ${e.id ? `<button class="icon-btn" data-reasignar-sucursal="${e.id}" aria-label="Cambiar sucursal"><i data-lucide="repeat" class="h-4 w-4"></i></button>` : ""}
            ${e.id ? `<button class="icon-btn danger" data-toggle-encargado="${e.id}" data-disabled="${e.activo === false}" aria-label="${e.activo === false ? "Reactivar" : "Deshabilitar"}"><i data-lucide="${e.activo === false ? "rotate-ccw" : "user-x"}" class="h-4 w-4"></i></button>` : ""}
            ${e.id ? `<button class="icon-btn danger" data-eliminar-encargado="${e.id}" aria-label="Eliminar definitivamente"><i data-lucide="trash-2" class="h-4 w-4"></i></button>` : ""}
          </div>
        </td>
      </tr>`;
    })
    .join("");

  if (empty) empty.classList.toggle("hidden", lista.length > 0);
  refreshIcons();

  tbody.querySelectorAll("[data-invite-encargado]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const enc = STORE.encargados.find((x) => x.id === btn.getAttribute("data-invite-encargado"));
      if (enc) openInviteModal({ nombre: enc.nombre, email: enc.email, sucursalId: enc.sucursalId, password: null });
    });
  });

  tbody.querySelectorAll("[data-reasignar-sucursal]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const enc = STORE.encargados.find((x) => x.id === btn.getAttribute("data-reasignar-sucursal"));
      if (enc) openReasignarSucursalModal(enc);
    });
  });

  tbody.querySelectorAll("[data-toggle-encargado]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const encUid = btn.getAttribute("data-toggle-encargado");
      const enc = STORE.encargados.find((x) => x.id === encUid);
      const yaDeshabilitado = btn.getAttribute("data-disabled") === "true";
      const accion = yaDeshabilitado ? "reactivar" : "deshabilitar";
      openConfirmModal(
        yaDeshabilitado ? "Reactivar encargado" : "Deshabilitar encargado",
        `¿Seguro que querés ${accion} el acceso de <strong>${enc.nombre}</strong>? ${yaDeshabilitado ? "Va a poder volver a iniciar sesión." : "No va a poder iniciar sesión hasta que lo reactives."}`,
        yaDeshabilitado ? "Reactivar" : "Deshabilitar",
        () => toggleEncargado(encUid, !yaDeshabilitado)
      );
    });
  });

  tbody.querySelectorAll("[data-eliminar-encargado]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const encUid = btn.getAttribute("data-eliminar-encargado");
      const enc = STORE.encargados.find((x) => x.id === encUid);
      openConfirmModal(
        "Eliminar encargado definitivamente",
        `¿Seguro que querés eliminar a <strong>${enc.nombre}</strong>? Esto borra su acceso por completo (no como deshabilitar) — si más adelante necesita volver a entrar, hay que crearlo de nuevo desde cero. Esta acción no se puede deshacer.`,
        "Eliminar definitivamente",
        () => eliminarEncargado(encUid)
      );
    });
  });
}

/* Modal simple para elegir la nueva sucursal de un encargado — sirve tanto
   para reincorporar a uno que quedó "Sin sucursal" (porque se borró la suya)
   como para mover a cualquier encargado activo a otra sucursal. */
function openReasignarSucursalModal(encargado) {
  openModal(
    "Cambiar sucursal",
    `<p class="text-sm text-slate-500 mb-3">Elegí la sucursal a la que va a quedar asignado <strong>${encargado.nombre}</strong>.</p>
    <form id="reasignarSucursalForm" class="movement-form">
      <label class="form-label" style="margin-top:0">Sucursal</label>
      <select id="reasignarSucursalSelect" class="form-input" required>
        ${STORE.sucursales.map((s) => `<option value="${s.id}" ${s.id === encargado.sucursalId ? "selected" : ""}>${s.nombre}</option>`).join("")}
      </select>
      <button type="submit" class="btn-primary w-full justify-center mt-4">
        <i data-lucide="repeat" class="h-4 w-4"></i>
        Guardar sucursal
      </button>
    </form>`,
    (body) => {
      body.querySelector("#reasignarSucursalForm").addEventListener("submit", (e) => {
        e.preventDefault();
        const sucursalId = body.querySelector("#reasignarSucursalSelect").value;
        reasignarSucursalEncargado(encargado.id, sucursalId);
      });
    }
  );
}

async function reasignarSucursalEncargado(encargadoUid, sucursalId) {
  if (isFirebaseReady()) {
    const idToken = await getIdTokenSafe();
    try {
      const res = await fetch(`${API_BASE}/api/reasignar-sucursal-encargado`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}) },
        body: JSON.stringify({ uid: encargadoUid, sucursalId })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showToast(data.error || "No se pudo cambiar la sucursal.", "error");
        return;
      }
      closeModal();
      showToast("Sucursal actualizada. El encargado va a verla reflejada la próxima vez que inicie sesión.", "success");
    } catch (err) {
      console.error("Error llamando a /api/reasignar-sucursal-encargado:", err);
      showToast("No se pudo conectar con el servidor.", "error");
    }
    return;
  }
  // ---- Modo demo (sin Firebase) ----
  const enc = STORE.encargados.find((x) => x.id === encargadoUid);
  if (enc) {
    enc.sucursalId = sucursalId;
    saveStore();
    closeModal();
    renderEncargados();
    showToast("Sucursal actualizada (modo demo).", "success");
  }
}

async function toggleEncargado(encargadoUid, disabled) {
  const idToken = await getIdTokenSafe();
  try {
    const res = await fetch(`${API_BASE}/api/disable-encargado`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}) },
      body: JSON.stringify({ uid: encargadoUid, action: disabled ? "disable" : "enable" })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showToast(data.error || "No se pudo actualizar el acceso del encargado.", "error");
      return;
    }
    showToast(disabled ? "Encargado deshabilitado." : "Encargado reactivado.", "success");
  } catch (err) {
    console.error("Error llamando a /api/disable-encargado:", err);
    showToast("No se pudo conectar con el servidor.", "error");
  }
}

async function eliminarEncargado(encargadoUid) {
  const idToken = await getIdTokenSafe();
  try {
    const res = await fetch(`${API_BASE}/api/disable-encargado`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}) },
      body: JSON.stringify({ uid: encargadoUid, action: "delete" })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showToast(data.error || "No se pudo eliminar al encargado.", "error");
      return;
    }
    showToast("Encargado eliminado.", "success");
    // El onSnapshot de suscribirEncargadosFirestore() refresca la tabla solo.
  } catch (err) {
    console.error("Error llamando a /api/disable-encargado:", err);
    showToast("No se pudo conectar con el servidor.", "error");
  }
}

/* Devuelve el ID token del usuario de Firebase actualmente logueado. Con
   Firebase Auth activo (como en esta app) esto funciona siempre que haya
   sesión real; si por algún motivo no hay sesión de Firebase, el backend
   rechaza la request igual, así que es seguro devolver null en ese caso. */
async function getIdTokenSafe() {
  try {
    if (window.firebase && firebase.auth && firebase.auth().currentUser) {
      return await firebase.auth().currentUser.getIdToken();
    }
  } catch (err) {
    console.error("No se pudo obtener el ID token de Firebase:", err);
  }
  return null;
}

/* Contraseña generada al azar para el encargado nuevo — el encargado la usa
   directamente para entrar y sigue usándola (no hay pantalla de "elegí tu
   propia contraseña" en el primer ingreso). Si en algún momento quiere
   cambiarla, usa "¿Olvidaste tu contraseña?" en login.html. Nunca usar el
   nombre de la sucursal ni ningún dato público como contraseña: cualquiera
   que lo sepa podría entrar. */
function generarPasswordTemporal() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  let pass = "";
  for (let i = 0; i < 10; i++) pass += chars.charAt(Math.floor(Math.random() * chars.length));
  return pass;
}

/* Arma el mensaje de invitación (mismo texto para WhatsApp y email) con el
   nombre de la sucursal, el email registrado y la contraseña, y abre un
   modal con un link de WhatsApp y un link mailto: ya completados para que
   el Administrador se los mande al encargado con un clic. No hay un
   servicio de envío de emails propio conectado, así que en vez de "enviar"
   desde el servidor, se arma el mensaje y se abre el cliente de
   WhatsApp/email del propio Administrador con todo precargado. */
function openInviteModal({ nombre, email, sucursalId, password, telefono }) {
  const sucursal = sucursalName(sucursalId);
  const loginUrl = `${window.location.origin}/login.html`;
  const lineaPassword = password
    ? `Contraseña: ${password}`
    : `Usá la contraseña que te compartieron antes, o tocá "¿Olvidaste tu contraseña?" en el login para generar una nueva.`;
  const mensaje = `Hola ${nombre}! Te invitamos a usar Boxly como encargado/a de la sucursal "${sucursal}".\n\nIngresá en: ${loginUrl}\nEmail: ${email}\n${lineaPassword}\n\nDesde ahí vas a ver los movimientos de tu sucursal en tiempo real.`;

  const whatsappUrl = telefono
    ? `https://wa.me/${telefono.replace(/\D/g, "")}?text=${encodeURIComponent(mensaje)}`
    : `https://api.whatsapp.com/send?text=${encodeURIComponent(mensaje)}`;
  const mailtoUrl = `mailto:${email}?subject=${encodeURIComponent("Invitación a Boxly")}&body=${encodeURIComponent(mensaje)}`;

  openModal(
    "Invitar al encargado",
    `<p class="text-sm text-slate-400 mb-3">Elegí cómo mandarle el acceso a <strong>${nombre}</strong>. Se abre tu WhatsApp o tu email con el mensaje ya escrito.</p>
     <a href="${whatsappUrl}" target="_blank" rel="noopener" class="btn-primary w-full justify-center mb-2"><i data-lucide="message-circle" class="h-4 w-4"></i> Enviar por WhatsApp</a>
     <a href="${mailtoUrl}" class="btn-secondary w-full justify-center"><i data-lucide="mail" class="h-4 w-4"></i> Enviar por email</a>
     <label class="form-label mt-4">O copiá el mensaje</label>
     <textarea class="form-input" rows="6" readonly onclick="this.select()">${mensaje}</textarea>`,
    () => {}
  );
}

async function createEncargado({ nombre, email, password, sucursalId, telefono }) {
  const idToken = await getIdTokenSafe();
  PENDING_ENCARGADOS[email] = { nombre, email, sucursalId, estado: "pendiente" };
  renderEncargados();

  try {
    const res = await fetch(`${API_BASE}/api/create-encargado`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // El backend valida este token con admin.auth().verifyIdToken() y confirma
        // que quien llama es, efectivamente, el Administrador de la cuenta.
        ...(idToken ? { Authorization: `Bearer ${idToken}` } : {})
      },
      body: JSON.stringify({ nombre, email, password, sucursalId })
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      PENDING_ENCARGADOS[email] = { nombre, email, sucursalId, estado: "error" };
      renderEncargados();
      showToast(data.error || "No se pudo crear el encargado.", "error");
      return;
    }

    // No borramos el pendiente todavía: lo saca suscribirEncargadosFirestore()
    // apenas el onSnapshot en tiempo real confirma que el documento llegó.
    showToast(`Encargado ${nombre} creado correctamente.`, "success");
    openInviteModal({ nombre, email, sucursalId, password, telefono });
  } catch (err) {
    console.error("Error llamando a /api/create-encargado:", err);
    PENDING_ENCARGADOS[email] = { nombre, email, sucursalId, estado: "error" };
    renderEncargados();
    showToast("No se pudo conectar con el servidor. ¿Ya desplegaste /api/create-encargado en Vercel?", "error");
  }
}

function openEncargadoForm() {
  if (!STORE.sucursales.length) {
    showToast("Primero creá al menos una sucursal.", "error");
    return;
  }
  const sucursalOptions = STORE.sucursales.map((s) => `<option value="${s.id}">${s.nombre}</option>`).join("");

  openModal(
    "Nuevo encargado de sucursal",
    `<form id="encargadoForm" class="movement-form">
      <label class="form-label" style="margin-top:0">Nombre y apellido</label>
      <input id="efNombre" type="text" class="form-input" placeholder="Ej: Marina Gómez" required>
      <label class="form-label">Email</label>
      <input id="efEmail" type="email" class="form-input" placeholder="marina@negocio.com" required>
      <label class="form-label">Teléfono (WhatsApp, opcional)</label>
      <input id="efTelefono" type="tel" class="form-input" placeholder="Ej: 5492613863563">
      <label class="form-label">Contraseña</label>
      <div class="password-field">
        <input id="efPassword" type="text" class="form-input" placeholder="Mínimo 6 caracteres" minlength="6" required value="${generarPasswordTemporal()}">
        <button type="button" id="efRegenPassword" class="password-toggle" aria-label="Generar otra contraseña"><i data-lucide="refresh-cw" class="h-4 w-4"></i></button>
      </div>
      <label class="form-label">Sucursal asignada</label>
      <select id="efSucursal" class="form-input">${sucursalOptions}</select>
      <p class="text-xs text-slate-400 mt-1"><i data-lucide="info" class="h-3 w-3 inline"></i> El encargado va a poder iniciar sesión con este email y contraseña, y solo va a ver/operar la sucursal asignada. Después de crearlo te dejamos mandarle la invitación por WhatsApp o email.</p>
      <button type="submit" class="btn-primary w-full justify-center mt-4">
        <i data-lucide="user-cog" class="h-4 w-4"></i>
        Crear encargado
      </button>
    </form>`,
    (body) => {
      body.querySelector("#efRegenPassword").addEventListener("click", () => {
        body.querySelector("#efPassword").value = generarPasswordTemporal();
      });

      body.querySelector("#encargadoForm").addEventListener("submit", async (e) => {
        e.preventDefault();
        const nombre = body.querySelector("#efNombre").value.trim();
        const email = body.querySelector("#efEmail").value.trim().toLowerCase();
        const telefono = body.querySelector("#efTelefono").value.trim();
        const password = body.querySelector("#efPassword").value;
        const sucursalId = body.querySelector("#efSucursal").value;

        if (STORE.encargados.some((x) => x.email.toLowerCase() === email) || PENDING_ENCARGADOS[email]) {
          showToast("Ya hay un encargado con ese email.", "error");
          return;
        }

        const submitBtn = body.querySelector("button[type=submit]");
        submitBtn.disabled = true;
        closeModal();
        await createEncargado({ nombre, email, password, sucursalId, telefono });
      });
    }
  );
}

document.getElementById("openAddEncargado").addEventListener("click", () => openEncargadoForm());

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
  const nuevo = {
    nombreNegocio: document.getElementById("cfgNombreNegocio").value.trim() || "Mi negocio",
    moneda: document.getElementById("cfgMoneda").value,
    stockMinimoDefault: parseInt(document.getElementById("cfgStockMinimo").value, 10) || 0,
    notificaciones: document.getElementById("cfgNotificaciones").checked,
    direccion: document.getElementById("cfgDireccion").value.trim(),
    telefono: document.getElementById("cfgTelefono").value.trim(),
    email: document.getElementById("cfgEmail").value.trim(),
    fiscal: document.getElementById("cfgFiscal").value.trim()
  };

  if (isFirebaseReady() && NEGOCIO_ID) {
    getFirestoreDb().collection("negocios").doc(NEGOCIO_ID).update(nuevo)
      .then(() => showToast("Configuración guardada.", "success"))
      .catch((err) => {
        console.error("No se pudo guardar la configuración en Firestore.", err);
        showToast("No se pudo guardar la configuración. Probá de nuevo.", "error");
      });
    // El onSnapshot de suscribirNegocioFirestore() refresca STORE.settings y la pantalla solo.
    return;
  }

  // ---- Modo demo (sin Firebase) ----
  Object.assign(STORE.settings, nuevo);
  saveStore();
  showToast("Configuración guardada.", "success");
  renderDashboard();
});

document.getElementById("cfgLogoBtn").addEventListener("click", () => {
  document.getElementById("cfgLogoInput").click();
});

/* "Zona de riesgo": reiniciar el historial de entradas/salidas del PROPIO
   negocio. Disponible para cualquier Administrador (incluida la cuenta
   creadora sobre su propia cuenta) — no toca productos, stock ni sucursales. */
document.getElementById("reiniciarMovimientosBtn").addEventListener("click", () => {
  openConfirmModal(
    "Reiniciar historial de movimientos",
    "Esto borra TODO el historial de entradas y salidas registrado hasta ahora. No modifica el stock actual de tus productos ni tu catálogo, solo limpia el registro que ves en Dashboard, Entradas, Salidas y Reportes. Esta acción no se puede deshacer. ¿Querés continuar?",
    "Sí, reiniciar",
    () => reiniciarMovimientos()
  );
});

document.getElementById("cfgLogoInput").addEventListener("change", (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;

  // OJO: Firestore tiene un límite de 1 MiB por documento (todos los campos juntos).
  // Un logo en base64 pesa ~33% más que el archivo original, así que 1.5 MB de imagen
  // ya se come casi todo ese límite. Si tenés pensado usar logos con Firebase activado,
  // lo correcto es subir el archivo a Firebase Storage y guardar acá solo la URL, no el
  // base64 entero. Por ahora bajo el límite aceptado a 300 KB para no romper el documento;
  // avisame si querés que armemos la versión con Storage.
  const maxBytes = isFirebaseReady() ? 300 * 1024 : 1.5 * 1024 * 1024;
  if (file.size > maxBytes) {
    showToast(`La imagen es muy pesada. Usá un logo de menos de ${Math.round(maxBytes / 1024)} KB.`, "error");
    e.target.value = "";
    return;
  }

  const reader = new FileReader();
  reader.onload = () => {
    const logoBase64 = reader.result;
    if (isFirebaseReady() && NEGOCIO_ID) {
      getFirestoreDb().collection("negocios").doc(NEGOCIO_ID).update({ logoBase64 })
        .then(() => showToast("Logo actualizado.", "success"))
        .catch((err) => {
          console.error("No se pudo guardar el logo en Firestore.", err);
          showToast("No se pudo guardar el logo. Probá con una imagen más chica.", "error");
        });
    } else {
      STORE.settings.logoBase64 = logoBase64;
      saveStore();
      renderLogoPreview();
      showToast("Logo actualizado.", "success");
    }
  };
  reader.onerror = () => showToast("No se pudo leer la imagen.", "error");
  reader.readAsDataURL(file);
  e.target.value = "";
});

document.getElementById("cfgLogoRemove").addEventListener("click", () => {
  if (isFirebaseReady() && NEGOCIO_ID) {
    getFirestoreDb().collection("negocios").doc(NEGOCIO_ID).update({ logoBase64: null })
      .then(() => showToast("Logo quitado.", "success"))
      .catch((err) => {
        console.error("No se pudo quitar el logo en Firestore.", err);
        showToast("No se pudo quitar el logo. Probá de nuevo.", "error");
      });
    return;
  }
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
    title: "Dashboard",
    desc: "Acá tenés el resumen de tu negocio: stock total, valor de inventario, compras, ventas y alertas activas, todo de un vistazo.",
    section: "dashboard",
    target: ".stat-card:first-child"
  },
  {
    icon: "box",
    title: "Productos",
    desc: "Cargá tu catálogo completo con SKU, código de barras, categoría, stock y precio. Todo queda listo para escanear.",
    section: "productos",
    target: "#openAddProduct"
  },
  {
    icon: "arrow-down-to-line",
    title: "Entradas",
    desc: "Registrá el ingreso de mercadería escaneando con una pistola lectora o la cámara de tu celular. Rápido y sin errores.",
    section: "entradas",
    target: "#entradaScan"
  },
  {
    icon: "arrow-up-from-line",
    title: "Salidas",
    desc: "Registrá ventas y salidas de stock del mismo modo: escaneando o buscando el producto por SKU.",
    section: "salidas",
    target: "#salidaScan"
  },
  {
    icon: "warehouse",
    title: "Inventario",
    desc: "Consultá el estado de cada producto — OK, bajo o crítico — y filtrá por lo que necesites revisar.",
    section: "inventario",
    target: "#inventarioStatusFilter"
  },
  {
    icon: "bar-chart-2",
    title: "Reportes",
    desc: "Filtrá movimientos por fecha, sucursal, tipo y categoría, y descargá reportes en PDF o Excel con tu logo y firma digital para auditorías.",
    section: "reportes",
    target: "#repGenerarPdf"
  },
  {
    icon: "alert-triangle",
    title: "Alertas",
    desc: "Acá aparecen automáticamente los productos con stock bajo o crítico, para que nunca te quedes sin mercadería importante.",
    section: "alertas",
    target: "#section-alertas .panel"
  },
  {
    icon: "users",
    title: "Usuarios",
    desc: "Acá ves quién tiene acceso a tu cuenta: vos como Administrador y los encargados que invites, con su sucursal y estado real.",
    section: "usuarios",
    target: "#goToSucursalesForInvite",
    adminOnly: true
  },
  {
    icon: "store",
    title: "Sucursales",
    desc: "Administrá tus sucursales y creá accesos de encargados limitados a ver y operar solo la sucursal que le asignes.",
    section: "sucursales",
    target: "#openAddSucursal",
    adminOnly: true
  },
  {
    icon: "gem",
    title: "Mi Plan",
    desc: "Consultá tu plan actual, tus límites de uso (sucursales, productos, documentos) y mejorá tu suscripción cuando lo necesites.",
    section: "mi-plan",
    target: "#miPlanBadge",
    adminOnly: true
  },
  {
    icon: "settings",
    title: "Configuración",
    desc: "Personalizá moneda, stock mínimo, logo y datos de contacto de tu negocio en un solo lugar.",
    section: "configuracion",
    target: "#cfgLogoBtn"
  },
  {
    icon: "life-buoy",
    title: "Ayuda y soporte",
    desc: "Si te trabás con algo, acá encontrás preguntas frecuentes y nuestros canales de contacto directo.",
    section: "ayuda",
    target: "#replayTourBtn"
  }
];

/* Pasos visibles según el rol del usuario logueado: los admin-only (Usuarios,
   Sucursales, Mi Plan) se saltean si quien ve el tour no es Administrador,
   para no chocar con la redirección que ya hace switchSection(). */
function getVisibleTourSteps() {
  return TOUR_STEPS.filter((step) => !step.adminOnly || isCurrentUserAdmin());
}

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
  const steps = getVisibleTourSteps();
  const step = steps[tourIndex];
  return step && step.target ? document.querySelector(step.target) : null;
}

function handleTourReposition() {
  if (!document.getElementById("tourBackdrop").classList.contains("is-open")) return;
  positionTourAround(currentTourTarget());
}

function renderTourStep() {
  const steps = getVisibleTourSteps();
  const step = steps[tourIndex];
  document.getElementById("tourIcon").innerHTML = `<i data-lucide="${step.icon}"></i>`;
  document.getElementById("tourTitle").textContent = step.title;
  document.getElementById("tourDesc").textContent = step.desc;

  // Contador y barra de progreso
  const total = steps.length;
  const current = tourIndex + 1;
  document.getElementById("tourStepCounter").textContent = `Paso ${current} de ${total}`;
  document.getElementById("tourProgressFill").style.width = `${(current / total) * 100}%`;

  const dots = document.getElementById("tourDots");
  dots.innerHTML = steps.map((_, i) => `<span class="tour-dot ${i === tourIndex ? "active" : ""}"></span>`).join("");

  const prevBtn = document.getElementById("tourPrev");
  const nextBtn = document.getElementById("tourNext");
  prevBtn.style.visibility = tourIndex === 0 ? "hidden" : "visible";
  nextBtn.innerHTML = tourIndex === total - 1
    ? `¡Empezar! <i data-lucide="check" class="h-4 w-4"></i>`
    : `Siguiente <i data-lucide="arrow-right" class="h-4 w-4"></i>`;

  refreshIcons();

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

/* FIX: TOUR_DONE_FLAG y NEW_USER_FLAG vivían como una única clave GLOBAL en
   localStorage, no atada a la cuenta (uid). Resultado: apenas una primera
   cuenta terminaba o cerraba el tour, boxly_onboarding_done quedaba en
   "true" para SIEMPRE en ese navegador — así que cualquier cuenta nueva que
   se creara después, en el mismo PC/navegador, heredaba el "ya visto" y
   nunca veía el tour, aunque fuera su primer inicio de sesión real. Ahora el
   "visto" se guarda por uid (scopedFlagKey), así cada cuenta tiene su propio
   estado de onboarding sin importar qué otras cuentas se hayan usado antes
   en ese mismo navegador. */
function scopedFlagKey(base) {
  return CURRENT_USER && CURRENT_USER.uid ? `${base}:${CURRENT_USER.uid}` : base;
}

function closeTour() {
  document.getElementById("tourBackdrop").classList.remove("is-open");
  document.getElementById("tourSpotlight").classList.remove("is-visible");
  localStorage.setItem(scopedFlagKey(TOUR_DONE_FLAG), "true");
  localStorage.removeItem(NEW_USER_FLAG);
  localStorage.removeItem(scopedFlagKey(NEW_USER_FLAG));
  window.removeEventListener("resize", handleTourReposition);
  window.removeEventListener("scroll", handleTourReposition, true);
}



document.getElementById("tourNext").addEventListener("click", () => {
  const steps = getVisibleTourSteps();
  if (tourIndex === steps.length - 1) {
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
  const isNewUser = localStorage.getItem(NEW_USER_FLAG) === "true" || localStorage.getItem(scopedFlagKey(NEW_USER_FLAG)) === "true";
  const alreadySeen = localStorage.getItem(scopedFlagKey(TOUR_DONE_FLAG)) === "true";
  if (isNewUser && !alreadySeen) {
    setTimeout(openTour, 500);
  }
}

/* =========================================================================
   Init
   ========================================================================= */
const trialUpgradeBtn = document.getElementById("trialUpgradeBtn");
if (trialUpgradeBtn) trialUpgradeBtn.addEventListener("click", () => switchSection("mi-plan"));
document.addEventListener("DOMContentLoaded", () => {
  lucide.createIcons();
  initReveal();
  renderAuthUser();
  applyRoleVisibility();
  renderDashboard();
  renderTraslados();
  initOnboardingTour();
  initTrialGuard();
});
