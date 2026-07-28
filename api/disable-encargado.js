/**
 * /api/disable-encargado.js
 * =============================================================================
 * Deshabilita, reactiva o elimina definitivamente a un encargado de sucursal
 * DE TU PROPIO NEGOCIO (para dar de baja cuentas de otros negocios existe
 * /api/admin-manage-account.js, que es la herramienta de soporte de la cuenta
 * creadora — este endpoint es el de uso normal del día a día del Administrador
 * sobre sus propios encargados).
 *
 * create-encargado.js ya dejaba anotado que quitar un encargado de la lista
 * en el panel no borraba su usuario real de Firebase Auth — este endpoint es
 * esa pieza que faltaba, con tres acciones posibles:
 *   - "disable": bloquea el login (admin.auth().updateUser(uid,{disabled:true}))
 *     y marca el perfil como inactivo en Firestore. No borra nada — el
 *     encargado se puede reactivar después.
 *   - "enable": lo contrario de "disable".
 *   - "delete": baja definitiva y no reversible. Borra el usuario de Firebase
 *     Auth y su documento en Firestore. Ojo: esto es DISTINTO de deshabilitar
 *     — una vez eliminado, habría que volver a crear al encargado desde cero
 *     con create-encargado.js si hace falta que vuelva a entrar.
 *
 * Body esperado: { uid: "<uid del encargado>", action: "disable"|"enable"|"delete" }
 * (por compatibilidad también acepta el formato viejo { uid, disabled: true|false }
 * cuando no se manda "action").
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
      return res.status(403).json({ error: "Solo un Administrador puede administrar encargados." });
    }
    const negocioId = callerData.negocioId || callerUid;

    const body = req.body || {};
    const { uid } = body;
    // Compatibilidad: si no viene "action", se infiere de "disabled" (formato viejo).
    const action = body.action || (typeof body.disabled === "boolean" ? (body.disabled ? "disable" : "enable") : null);

    if (!uid || typeof uid !== "string") {
      return res.status(400).json({ error: "Falta el uid del encargado." });
    }
    if (!["disable", "enable", "delete"].includes(action)) {
      return res.status(400).json({ error: "Acción inválida. Usá disable, enable o delete." });
    }

    // Confirmamos que el encargado pertenece al negocio de quien llama —
    // un Administrador no puede tocar encargados de otro negocio — y que la
    // cuenta objetivo es realmente un encargado (no se puede usar esto para
    // tocar la cuenta de otro Administrador).
    const encargadoRef = db.collection("users").doc(uid);
    const encargadoDoc = await encargadoRef.get();
    if (!encargadoDoc.exists || encargadoDoc.data().negocioId !== negocioId || encargadoDoc.data().rol !== "encargado") {
      return res.status(403).json({ error: "Ese encargado no pertenece a tu negocio." });
    }

    if (action === "delete") {
      await admin.auth().deleteUser(uid).catch((err) => {
        // Si ya no existe en Auth (borrado a mano antes), seguimos igual con Firestore.
        if (err.code !== "auth/user-not-found") throw err;
      });
      await encargadoRef.delete();
      return res.status(200).json({ ok: true });
    }

    const disabled = action === "disable";
    await admin.auth().updateUser(uid, { disabled });
    await encargadoRef.set({ activo: !disabled }, { merge: true });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Error inesperado en /api/disable-encargado:", err);
    return res.status(500).json({ error: "Error interno del servidor." });
  }
};
