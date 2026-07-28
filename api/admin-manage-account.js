/**
 * /api/admin-manage-account.js
 * =============================================================================
 * PANEL CREADOR — deshabilitar, reactivar o eliminar CUALQUIER cuenta de
 * CUALQUIER negocio de Boxly (Administrador o encargado).
 *
 * Por qué existe este endpoint aparte de /api/disable-encargado.js:
 * disable-encargado.js a propósito solo deja a un Administrador tocar
 * encargados de SU PROPIO negocio (negocioId === callerData.negocioId) — está
 * bien que así sea, ese endpoint es para el uso normal del día a día de un
 * negocio. Este endpoint es distinto: es la herramienta de soporte técnico de
 * la cuenta creadora (miguelcoronell94@gmail.com) para administrar CUALQUIER
 * cuenta de CUALQUIER negocio (por ejemplo, si hay que dar de baja a un
 * cliente que dejó de pagar, o resolver un abuso). Por eso valida el email
 * del que llama en vez de su rol/negocioId.
 *
 * Body esperado: { uid: "<uid objetivo>", action: "disable" | "enable" | "delete" }
 * Requiere Authorization: Bearer <idToken> de la cuenta creadora.
 *
 * Requiere las mismas variables de entorno que el resto de /api:
 * FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY.
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

// Mismo email que usa isCreator() en firestore.rules y isCreatorAccount() en
// app.js — si en algún momento cambia, hay que actualizarlo en los tres lugares.
const CREATOR_EMAIL = "miguelcoronell94@gmail.com";

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método no permitido. Usá POST." });
  }

  try {
    // ------------------------------------------------------------------
    // 1) Autenticar y confirmar que quien llama es la cuenta creadora
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

    if (decoded.email !== CREATOR_EMAIL || !decoded.email_verified) {
      return res.status(403).json({ error: "Solo la cuenta creadora puede administrar cuentas de otros negocios." });
    }

    // ------------------------------------------------------------------
    // 2) Validar el body
    // ------------------------------------------------------------------
    const { uid, action } = req.body || {};
    if (!uid || typeof uid !== "string") {
      return res.status(400).json({ error: "Falta el uid de la cuenta objetivo." });
    }
    if (!["disable", "enable", "delete"].includes(action)) {
      return res.status(400).json({ error: "Acción inválida. Usá disable, enable o delete." });
    }
    if (uid === decoded.uid) {
      return res.status(400).json({ error: "No podés aplicar esta acción sobre tu propia cuenta creadora." });
    }

    const targetRef = db.collection("users").doc(uid);
    const targetDoc = await targetRef.get();
    if (!targetDoc.exists) {
      return res.status(404).json({ error: "No se encontró esa cuenta en Firestore." });
    }
    const targetData = targetDoc.data();

    // ------------------------------------------------------------------
    // 3) Deshabilitar / reactivar: no borra nada, solo bloquea/desbloquea
    //    el login en Firebase Auth y refleja el estado en Firestore.
    // ------------------------------------------------------------------
    if (action === "disable" || action === "enable") {
      const disabled = action === "disable";
      await admin.auth().updateUser(uid, { disabled });
      await targetRef.set({ activo: !disabled }, { merge: true });
      return res.status(200).json({ ok: true });
    }

    // ------------------------------------------------------------------
    // 4) Eliminar cuenta por completo.
    //    - Si es un encargado: se borra su usuario de Auth y su doc en Firestore.
    //    - Si es el Administrador dueño de un negocio: además se borran TODOS
    //      los encargados de ese negocio (Auth + Firestore) y toda la data del
    //      negocio (negocios/{negocioId} y sus subcolecciones), vía
    //      recursiveDelete — es una baja completa de cliente, no reversible.
    // ------------------------------------------------------------------
    if (targetData.rol === "Administrador") {
      const negocioId = targetData.negocioId || uid;

      const encargadosSnap = await db.collection("users").where("negocioId", "==", negocioId).where("rol", "==", "encargado").get();
      for (const doc of encargadosSnap.docs) {
        await admin.auth().deleteUser(doc.id).catch((err) => {
          // Si ya no existe en Auth (borrado a mano antes), seguimos igual con Firestore.
          if (err.code !== "auth/user-not-found") throw err;
        });
        await doc.ref.delete();
      }

      const negocioRef = db.collection("negocios").doc(negocioId);
      const negocioDoc = await negocioRef.get();
      if (negocioDoc.exists) {
        await db.recursiveDelete(negocioRef);
      }
    }

    await admin.auth().deleteUser(uid).catch((err) => {
      if (err.code !== "auth/user-not-found") throw err;
    });
    await targetRef.delete();

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Error inesperado en /api/admin-manage-account:", err);
    return res.status(500).json({ error: "Error interno del servidor." });
  }
};
