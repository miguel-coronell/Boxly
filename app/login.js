/* =========================================================================
   BOXLY — Login / Registro
   Funciona en modo demo (localStorage) apenas lo abrís. En cuanto completes
   firebase-config.js y descomentés el SDK, usa Firebase Authentication real
   sin tener que tocar el resto del código (ver isFirebaseReady()).
   ========================================================================= */

const AUTH_KEY = "boxly_auth_user";
const NEW_USER_FLAG = "boxly_new_user";
const DEMO_USERS_KEY = "boxly_demo_users";

/* Si ya hay una sesión activa, va directo al panel. */
(function redirectIfLoggedIn() {
  try {
    if (localStorage.getItem(AUTH_KEY)) {
      window.location.replace("app.html");
    }
  } catch (err) { /* localStorage no disponible */ }
})();

/* ---------------------------- Preloader ---------------------------- */
(function () {
  const preloader = document.getElementById("preloader");
  if (!preloader) return;
  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function hidePreloader() {
    document.body.classList.remove("is-loading");
    preloader.classList.add("is-hidden");
    setTimeout(() => preloader.remove(), 700);
  }

  if (prefersReducedMotion) {
    window.addEventListener("load", hidePreloader);
  } else {
    const minDelay = new Promise((resolve) => setTimeout(resolve, 800));
    const pageLoaded = new Promise((resolve) => {
      if (document.readyState === "complete") resolve();
      else window.addEventListener("load", resolve);
    });
    Promise.all([minDelay, pageLoaded]).then(hidePreloader);
  }

  setTimeout(hidePreloader, 4000);
})();

/* ---------------------------- Toasts ---------------------------- */
function showToast(message, type = "success") {
  const container = document.getElementById("toastContainer");
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  const icon = type === "error" ? "alert-circle" : type === "success" ? "check-circle-2" : "info";
  toast.innerHTML = `<i data-lucide="${icon}" class="h-4 w-4"></i><span>${message}</span>`;
  container.appendChild(toast);
  lucide.createIcons();
  setTimeout(() => {
    toast.classList.add("leaving");
    setTimeout(() => toast.remove(), 250);
  }, 2800);
}

/* ---------------------------- Almacén demo (sin Firebase) ---------------------------- */
function getDemoUsers() {
  try {
    return JSON.parse(localStorage.getItem(DEMO_USERS_KEY) || "[]");
  } catch (err) {
    return [];
  }
}
function saveDemoUsers(users) {
  localStorage.setItem(DEMO_USERS_KEY, JSON.stringify(users));
}

function setAuthUser(user, opts = {}) {
  localStorage.setItem(AUTH_KEY, JSON.stringify(user));
  if (opts.isNewUser) localStorage.setItem(NEW_USER_FLAG, "true");
  window.location.href = "app.html";
}

/* ---------------------------- Tabs (login / registro) ---------------------------- */
const tabs = document.querySelectorAll("[data-auth-tab]");
const panels = { login: document.getElementById("panel-login"), registro: document.getElementById("panel-registro") };
const switchLabel = document.getElementById("authSwitchLabel");
const switchLink = document.getElementById("authSwitchLink");

function setAuthMode(mode) {
  tabs.forEach((t) => t.classList.toggle("active", t.getAttribute("data-auth-tab") === mode));
  Object.entries(panels).forEach(([key, el]) => el.classList.toggle("active", key === mode));
  if (mode === "login") {
    switchLabel.textContent = "¿No tenés cuenta?";
    switchLink.textContent = "Creá una gratis";
  } else {
    switchLabel.textContent = "¿Ya tenés cuenta?";
    switchLink.textContent = "Iniciá sesión";
  }
}

tabs.forEach((tab) => tab.addEventListener("click", () => setAuthMode(tab.getAttribute("data-auth-tab"))));

switchLink.addEventListener("click", (e) => {
  e.preventDefault();
  const current = document.querySelector(".auth-tab.active").getAttribute("data-auth-tab");
  setAuthMode(current === "login" ? "registro" : "login");
});

/* ---------------------------- Mostrar / ocultar contraseña ---------------------------- */
document.querySelectorAll("[data-toggle-pass]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const input = document.getElementById(btn.getAttribute("data-toggle-pass"));
    const isPass = input.type === "password";
    input.type = isPass ? "text" : "password";
    btn.innerHTML = `<i data-lucide="${isPass ? "eye-off" : "eye"}" class="h-4 w-4"></i>`;
    lucide.createIcons();
  });
});

/* ---------------------------- Login con email/contraseña ---------------------------- */
document.getElementById("loginForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const email = document.getElementById("loginEmail").value.trim().toLowerCase();
  const password = document.getElementById("loginPassword").value;

  if (isFirebaseReady()) {
    const auth = initFirebase();
    auth.signInWithEmailAndPassword(email, password)
      .then((cred) => {
        setAuthUser({
          uid: cred.user.uid,
          nombre: cred.user.displayName || email.split("@")[0],
          email: cred.user.email,
          provider: "password"
        });
      })
      .catch((err) => showToast(mapFirebaseError(err), "error"));
    return;
  }

  // ---- Modo demo (localStorage) ----
  const users = getDemoUsers();
  const found = users.find((u) => u.email === email && u.password === password);
  if (!found) {
    showToast("Email o contraseña incorrectos.", "error");
    return;
  }
  setAuthUser({ uid: found.uid, nombre: found.nombre, email: found.email, negocio: found.negocio, provider: "password" });
});

/* ---------------------------- Registro con email/contraseña ---------------------------- */
document.getElementById("registerForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const nombre = document.getElementById("regNombre").value.trim();
  const negocio = document.getElementById("regNegocio").value.trim();
  const email = document.getElementById("regEmail").value.trim().toLowerCase();
  const password = document.getElementById("regPassword").value;

  if (password.length < 6) {
    showToast("La contraseña debe tener al menos 6 caracteres.", "error");
    return;
  }

  if (isFirebaseReady()) {
    const auth = initFirebase();
    auth.createUserWithEmailAndPassword(email, password)
      .then((cred) => {
        cred.user.updateProfile({ displayName: nombre }).catch(() => {});
        // Si activaste Firestore, acá conviene crear el documento de negocio:
        // firestoreInstance.collection("users").doc(cred.user.uid).set({ nombre, email, negocio });
        setAuthUser({ uid: cred.user.uid, nombre, email, negocio, provider: "password" }, { isNewUser: true });
      })
      .catch((err) => showToast(mapFirebaseError(err), "error"));
    return;
  }

  // ---- Modo demo (localStorage) ----
  const users = getDemoUsers();
  if (users.some((u) => u.email === email)) {
    showToast("Ya existe una cuenta con ese email.", "error");
    return;
  }
  const newUser = { uid: `u-${Date.now().toString(36)}`, nombre, email, negocio, password };
  users.push(newUser);
  saveDemoUsers(users);
  setAuthUser({ uid: newUser.uid, nombre, email, negocio, provider: "password" }, { isNewUser: true });
});

/* ---------------------------- Google Sign-In ---------------------------- */
document.getElementById("googleBtn").addEventListener("click", () => {
  if (isFirebaseReady()) {
    const auth = initFirebase();
    const provider = new firebase.auth.GoogleAuthProvider();
    auth.signInWithPopup(provider)
      .then((result) => {
        const isNewUser = result.additionalUserInfo && result.additionalUserInfo.isNewUser;
        setAuthUser({
          uid: result.user.uid,
          nombre: result.user.displayName,
          email: result.user.email,
          foto: result.user.photoURL,
          provider: "google"
        }, { isNewUser });
      })
      .catch((err) => showToast(mapFirebaseError(err), "error"));
    return;
  }

  // ---- Modo demo: simula un ingreso con Google sin backend real ----
  showToast("Modo demo: simulando ingreso con Google. Configurá Firebase para usar Google real.", "success");
  const demoSeenKey = "boxly_demo_google_seen";
  const isNewDemoUser = !localStorage.getItem(demoSeenKey);
  localStorage.setItem(demoSeenKey, "true");
  const demoGoogleUser = {
    uid: "demo-google-user",
    nombre: "Usuario Google",
    email: "usuario.google@gmail.com",
    provider: "google"
  };
  setTimeout(() => setAuthUser(demoGoogleUser, { isNewUser: isNewDemoUser }), 900);
});

/* ---------------------------- Olvidé mi contraseña ---------------------------- */
document.getElementById("forgotPasswordBtn").addEventListener("click", () => {
  const email = document.getElementById("loginEmail").value.trim().toLowerCase();
  if (!email) {
    showToast("Escribí tu email arriba y volvé a tocar el enlace.", "error");
    return;
  }
  if (isFirebaseReady()) {
    initFirebase().sendPasswordResetEmail(email)
      .then(() => showToast("Te enviamos un email para restablecer tu contraseña.", "success"))
      .catch((err) => showToast(mapFirebaseError(err), "error"));
  } else {
    showToast("Modo demo: en producción esto te enviaría un email para restablecer la contraseña.", "success");
  }
});

/* ---------------------------- Ayuda (enlace inferior) ---------------------------- */
document.getElementById("helpLink").addEventListener("click", (e) => {
  e.preventDefault();
  showToast("Escribinos a soporte@boxlyapp.com o por WhatsApp, te respondemos a la brevedad.", "success");
});

/* ---------------------------- Errores de Firebase en español ---------------------------- */
function mapFirebaseError(err) {
  const map = {
    "auth/user-not-found": "No encontramos una cuenta con ese email.",
    "auth/wrong-password": "Contraseña incorrecta.",
    "auth/email-already-in-use": "Ya existe una cuenta con ese email.",
    "auth/weak-password": "La contraseña debe tener al menos 6 caracteres.",
    "auth/invalid-email": "El email no es válido.",
    "auth/popup-closed-by-user": "Cerraste la ventana de Google antes de completar el ingreso."
  };
  return map[err.code] || "Ocurrió un error. Probá de nuevo en unos segundos.";
}

document.addEventListener("DOMContentLoaded", () => {
  lucide.createIcons();
});
