/**
 * /api/disable-encargado.js
 * =============================================================================
 * Deshabilita (o reactiva) el acceso de un encargado de sucursal.
 *
 * create-encargado.js ya dejaba anotado que quitar un encargado de la lista
 * en el panel no borraba su usuario real de Firebase Auth — este endpoint
 * es esa pieza que faltaba: usa el Admin SDK para deshabilitar el login
 * (admin.auth().updateUser(uid, { disabled: true })) y marca su perfil en
 * Firestore como inactivo, sin tocar la sesión de nadie más.
 *
 * Body esperado: { uid: "<uid del encargado>", disabled: true|false }
 * Requiere el mismo Authorization: Bearer <idToken> del Administrador.
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
      return res.status(403).json({ error: "Solo un Administrador puede deshabilitar encargados." });
    }
    const negocioId = callerData.negocioId || callerUid;

    const { uid, disabled } = req.body || {};
    if (!uid || typeof uid !== "string") {
      return res.status(400).json({ error: "Falta el uid del encargado." });
    }

    // Confirmamos que el encargado pertenece al negocio de quien llama —
    // un Administrador no puede deshabilitar encargados de otro negocio.
    const encargadoDoc = await db.collection("users").doc(uid).get();
    if (!encargadoDoc.exists || encargadoDoc.data().negocioId !== negocioId) {
      return res.status(403).json({ error: "Ese encargado no pertenece a tu negocio." });
    }

    await admin.auth().updateUser(uid, { disabled: !!disabled });
    await db.collection("users").doc(uid).set({ activo: !disabled }, { merge: true });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Error inesperado en /api/disable-encargado:", err);
    return res.status(500).json({ error: "Error interno del servidor." });
  }
};
