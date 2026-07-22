const FIREBASE_CONFIG = {
  apiKey: "AIzaSyCtxeMSEYnG0rKPGwwEHyLrSffTP9e0664",
  authDomain: "boxly-io.firebaseapp.com",
  projectId: "boxly-io",
  storageBucket: "boxly-io.firebasestorage.app",
  messagingSenderId: "363119991513",
  appId: "1:363119991513:web:4efc156f3ed932b69d7cc8",
  measurementId: "G-5JD56M00QE"
};

let firebaseApp = null;
let firebaseAuthInstance = null;
let firestoreInstance = null;

/* true en cuanto el SDK de Firebase esté cargado y haya una apiKey configurada.
   (login.html / app.html ya incluyen los <script> del SDK antes que este archivo). */
function isFirebaseReady() {
  return !!(typeof firebase !== "undefined" && FIREBASE_CONFIG.apiKey);
}

function initFirebase() {
  if (!firebaseApp) {
    firebaseApp = firebase.apps.length ? firebase.apps[0] : firebase.initializeApp(FIREBASE_CONFIG);
    firebaseAuthInstance = firebase.auth();
    firestoreInstance = firebase.firestore();
  }
  return firebaseAuthInstance;
}

/* Acceso directo a Firestore ya inicializado, para usar desde app.js (6B en adelante)
   sin tener que repetir la inicialización en cada función. */
function getFirestoreDb() {
  if (!firestoreInstance) initFirebase();
  return firestoreInstance;
}
