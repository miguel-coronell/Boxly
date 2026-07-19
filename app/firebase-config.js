/* =========================================================================
   BOXLY — Configuración de Firebase
   =========================================================================
   Este archivo deja todo preparado para conectar Boxly a un proyecto real
   de Firebase (Authentication + Firestore). Mientras no lo completes, la
   app funciona en "modo demo" usando localStorage, así podés probar todo
   el flujo de login/registro sin backend.

   PASOS PARA ACTIVAR FIREBASE DE VERDAD
   --------------------------------------
   1) Entrá a https://console.firebase.google.com y creá un proyecto (o usá
      uno existente).
   2) En "Authentication" > "Sign-in method", habilitá los proveedores:
        - Correo electrónico/contraseña
        - Google
   3) (Opcional pero recomendado) Activá "Firestore Database" para guardar
      el perfil del usuario, el inventario, movimientos, etc. en la nube en
      vez de localStorage.
   4) Andá a "Configuración del proyecto" > "Tus apps" > "SDK de Firebase"
      y copiá el objeto de configuración. Pegalo acá abajo, reemplazando
      FIREBASE_CONFIG.
   5) En login.html y app.html, descomentá las 3 etiquetas <script> del
      SDK de Firebase que están arriba de este archivo (firebase-app-compat,
      firebase-auth-compat y firebase-firestore-compat).
   6) ¡Listo! login.js y app.js ya están escritos para usar Firebase
      automáticamente en cuanto detecten que está disponible y configurado
      (ver isFirebaseReady() más abajo). Si no lo configurás, todo sigue
      funcionando en modo demo con localStorage.

   ESTRUCTURA SUGERIDA EN FIRESTORE
   --------------------------------------
   users/{uid}
     - nombre, email, rol, negocioId, fotoURL, creadoEn

   negocios/{negocioId}
     - nombreNegocio, moneda, stockMinimoDefault, logoBase64 (o URL en
       Storage), direccion, telefono, email, fiscal

   negocios/{negocioId}/productos/{productId}
   negocios/{negocioId}/movimientos/{movId}

   Esto te permite tener multi-usuario y multi-negocio manteniendo la misma
   estructura de datos que ya usa STORE en app.js.
   ========================================================================= */

const FIREBASE_CONFIG = {
  apiKey: "TU_API_KEY",
  authDomain: "tu-proyecto.firebaseapp.com",
  projectId: "tu-proyecto",
  storageBucket: "tu-proyecto.appspot.com",
  messagingSenderId: "000000000000",
  appId: "1:000000000000:web:xxxxxxxxxxxxxxxxxx"
};

let firebaseApp = null;
let firebaseAuthInstance = null;
let firestoreInstance = null;

/* Devuelve true solo si el SDK de Firebase está cargado (script descomentado)
   Y ya reemplazaste FIREBASE_CONFIG por los datos reales de tu proyecto. */
function isFirebaseReady() {
  return typeof firebase !== "undefined" && FIREBASE_CONFIG.apiKey !== "TU_API_KEY";
}

function initFirebase() {
  if (!isFirebaseReady()) {
    console.info("[Boxly] Firebase no está configurado todavía — usando modo demo (localStorage). Ver firebase-config.js.");
    return null;
  }
  if (!firebaseApp) {
    firebaseApp = firebase.initializeApp(FIREBASE_CONFIG);
    firebaseAuthInstance = firebase.auth();
    if (firebase.firestore) firestoreInstance = firebase.firestore();
  }
  return firebaseAuthInstance;
}

// Se intenta inicializar apenas carga el script (no falla si no está configurado).
initFirebase();
