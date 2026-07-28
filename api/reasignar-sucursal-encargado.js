/**
 * /api/reasignar-sucursal-encargado.js
 * =============================================================================
 * Reasigna a un encargado a otra sucursal (o lo reincorpora a una sucursal
 * válida cuando quedó "huérfano" — por ejemplo, porque el Administrador
 * borró la sucursal a la que estaba asignado).
 *
 * Por qué esto no se puede hacer directo desde el navegador con un simple
 * update() a Firestore: la sucursal de un encargado no vive solo en su
 * documento users/{uid}.sucursalId — también vive en sus Custom Claims
 * (rol/sucursalId/negocioId), que es lo que usan firestore.rules para saber
 * qué puede leer/escribir (ver miSucursalClaim() en las reglas). Los Custom
 * Claims solo se pueden escribir con el Admin SDK — un usuario, ni siquiera
 * el propio Administrador, puede setearlos desde el cliente — así que hace
 * falta este endpoint.
 *
 * Nota: el encargado tiene que cerrar sesión y volver a entrar (o refrescar
 * su ID token) para que el cambio de Custom Claims tenga efecto en las
 * reglas de Firestore — es una limitación normal de Firebase Auth, no un bug.
 *
 * Body esperado: { uid: "<uid del encargado>", sucursalId: "<id de la nueva sucursal>" }
 * Requiere Authorization: Bearer <idToken> del Administrador dueño del negocio.
 * =============================================================================
 */

const admin = require("firebase-admin");

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n")
    })
  });
}

const db = admin.firestore();
const ADMIN_ROLES = ["Administrador", "admin", "owner"];

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método no permitido. Usá POST." });
  }

  try {
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
      return res.status(403).json({ error: "Solo un Administrador puede reasignar la sucursal de un encargado." });
    }
    const negocioId = callerData.negocioId || callerUid;

    const { uid, sucursalId } = req.body || {};
    if (!uid || typeof uid !== "string") {
      return res.status(400).json({ error: "Falta el uid del encargado." });
    }
    if (!sucursalId || typeof sucursalId !== "string") {
      return res.status(400).json({ error: "Falta la sucursal a asignar." });
    }

    const encargadoRef = db.collection("users").doc(uid);
    const encargadoDoc = await encargadoRef.get();
    if (!encargadoDoc.exists || encargadoDoc.data().negocioId !== negocioId || encargadoDoc.data().rol !== "encargado") {
      return res.status(403).json({ error: "Ese encargado no pertenece a tu negocio." });
    }

    // La sucursal tiene que existir realmente dentro del negocio (viven en
    // negocios/{negocioId}/sucursales/{sucursalId}, ver create-encargado.js).
    const sucursalDoc = await db.collection("negocios").doc(negocioId).collection("sucursales").doc(sucursalId).get();
    if (!sucursalDoc.exists) {
      return res.status(400).json({ error: "Esa sucursal no existe o no pertenece a tu negocio." });
    }

    await encargadoRef.set({ sucursalId }, { merge: true });
    await admin.auth().setCustomUserClaims(uid, {
      rol: "encargado",
      sucursalId,
      negocioId
    });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Error inesperado en /api/reasignar-sucursal-encargado:", err);
    return res.status(500).json({ error: "Error interno del servidor." });
  }
};
