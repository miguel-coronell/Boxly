/**
 * /api/create-encargado.js
 * =============================================================================
 * REQUERIMIENTO 4 — Creación de encargados de sucursal.
 *
 * Por qué existe este endpoint:
 * En el navegador, llamar a firebase.auth().createUserWithEmailAndPassword()
 * inicia sesión automáticamente con el usuario recién creado, lo que cerraría
 * la sesión del Administrador logueado. Para evitar eso, la creación del
 * usuario se hace en el servidor con el Firebase Admin SDK (admin.auth().
 * createUser), que NO afecta ninguna sesión de cliente.
 *
 * Flujo:
 *   1) El Admin, logueado en el panel, llama a este endpoint con su ID token.
 *   2) Verificamos ese token y confirmamos que quien llama es Administrador.
 *   3) Creamos el usuario en Firebase Auth (email + password).
 *   4) Guardamos su perfil en Firestore: users/{uid} con rol "encargado"
 *      y el id de la sucursal asignada.
 *   5) (Opcional pero recomendado) seteamos Custom Claims para que las
 *      Firestore Rules puedan usar request.auth.token.rol / sucursalId.
 *
 * Requiere las variables de entorno (ver instrucciones al final de la
 * respuesta): FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY.
 * =============================================================================
 */

const admin = require("firebase-admin");

/* ---------------------------------------------------------------------------
   Inicialización del Admin SDK (patrón singleton: Vercel puede reutilizar el
   mismo proceso/lambda entre invocaciones, así que no hay que inicializar de
   nuevo si ya existe una app). */
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      // La private key llega desde Vercel con los saltos de línea escapados
      // como "\n" literales; hay que convertirlos de nuevo a saltos reales.
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n")
    })
  });
}

const db = admin.firestore();

/* Roles que tienen permiso para crear encargados. Ajustá el nombre si en tu
   Firestore usás otra convención (ej: "admin" en vez de "Administrador"). */
const ADMIN_ROLES = ["Administrador", "admin", "owner"];

module.exports = async function handler(req, res) {
  // CORS básico. Si tu frontend y esta función viven en el mismo dominio de
  // Vercel (recomendado) esto ni hace falta, pero lo dejamos por las dudas.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método no permitido. Usá POST." });
  }

  try {
    // ------------------------------------------------------------------
    // 1) Autenticar y autorizar al Administrador que hace la llamada
    // ------------------------------------------------------------------
    const authHeader = req.headers.authorization || "";
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!idToken) {
      return res.status(401).json({ error: "Falta el token de autenticación (Authorization: Bearer ...)." });
    }

    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(idToken);
    } catch (err) {
      return res.status(401).json({ error: "Token inválido o expirado." });
    }

    const callerUid = decoded.uid;
    const callerDoc = await db.collection("users").doc(callerUid).get();
    const callerData = callerDoc.exists ? callerDoc.data() : null;

    if (!callerData || !ADMIN_ROLES.includes(callerData.rol)) {
      return res.status(403).json({ error: "Solo un Administrador puede crear encargados de sucursal." });
    }

    // ------------------------------------------------------------------
    // 2) Validar el body
    // ------------------------------------------------------------------
    const { nombre, email, password, sucursalId } = req.body || {};

    if (!nombre || typeof nombre !== "string" || !nombre.trim()) {
      return res.status(400).json({ error: "Falta el nombre del encargado." });
    }
    if (!email || typeof email !== "string" || !/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ error: "El email no es válido." });
    }
    if (!password || typeof password !== "string" || password.length < 6) {
      return res.status(400).json({ error: "La contraseña debe tener al menos 6 caracteres." });
    }
    if (!sucursalId || typeof sucursalId !== "string") {
      return res.status(400).json({ error: "Falta la sucursal asignada." });
    }

    // Verificamos que la sucursal exista y pertenezca a la cuenta del Admin
    // que está creando el encargado (multi-tenant: cada Admin es dueño de
    // sus propias sucursales, identificadas por adminId == callerUid).
    const sucursalDoc = await db.collection("sucursales").doc(sucursalId).get();
    if (!sucursalDoc.exists || sucursalDoc.data().adminId !== callerUid) {
      return res.status(400).json({ error: "La sucursal indicada no existe o no te pertenece." });
    }

    // ------------------------------------------------------------------
    // 3) Crear el usuario en Firebase Auth (Admin SDK -> no toca la sesión
    //    del navegador del Administrador que está logueado)
    // ------------------------------------------------------------------
    let userRecord;
    try {
      userRecord = await admin.auth().createUser({
        email: email.trim().toLowerCase(),
        password,
        displayName: nombre.trim(),
        emailVerified: false,
        disabled: false
      });
    } catch (err) {
      if (err.code === "auth/email-already-exists") {
        return res.status(409).json({ error: "Ya existe un usuario con ese email." });
      }
      if (err.code === "auth/invalid-password") {
        return res.status(400).json({ error: "La contraseña no cumple los requisitos mínimos de Firebase." });
      }
      console.error("Error creando usuario en Firebase Auth:", err);
      return res.status(500).json({ error: "No se pudo crear el usuario en Firebase Auth." });
    }

    // ------------------------------------------------------------------
    // 4) Guardar su perfil en Firestore: colección "users"
    // ------------------------------------------------------------------
    await db.collection("users").doc(userRecord.uid).set({
      nombre: nombre.trim(),
      email: email.trim().toLowerCase(),
      rol: "encargado",
      sucursalId,
      negocioId: callerUid, // a qué negocio pertenece este encargado (el del Admin que lo crea)
      activo: true,
      creadoEn: admin.firestore.FieldValue.serverTimestamp()
    });

    // ------------------------------------------------------------------
    // 5) Custom Claims (opcional, muy recomendado): permite que las
    //    Firestore Security Rules lean request.auth.token.rol y
    //    request.auth.token.sucursalId sin tener que ir a buscar el doc.
    // ------------------------------------------------------------------
    await admin.auth().setCustomUserClaims(userRecord.uid, {
      rol: "encargado",
      sucursalId,
      adminId: callerUid
    });

    return res.status(200).json({ ok: true, uid: userRecord.uid });
  } catch (err) {
    console.error("Error inesperado en /api/create-encargado:", err);
    return res.status(500).json({ error: "Error interno del servidor." });
  }
};

/**
 * -----------------------------------------------------------------------
 * Ejemplo de Firestore Security Rule que aprovecha estos Custom Claims,
 * para que un encargado SOLO pueda leer/escribir movimientos de SU sucursal:
 *
 * match /movimientos/{movId} {
 *   allow read, write: if request.auth != null && (
 *     request.auth.token.rol == "Administrador" ||
 *     (request.auth.token.rol == "encargado" &&
 *      request.auth.token.sucursalId == resource.data.sucursalId)
 *   );
 * }
 * -----------------------------------------------------------------------
 */
