/**
 * /api/diagnostico-temporal.js
 * =============================================================================
 * SOLO PARA DEBUG — borrar este archivo cuando terminemos de diagnosticar.
 * Es de solo lectura: no modifica nada en Firestore ni en Auth.
 * Corre en Vercel (donde las credenciales de Firebase Admin sí están bien
 * configuradas), a diferencia de correrlo en tu PC local.
 *
 * Protegido con una clave simple en la URL (?clave=...) solo para que no
 * quede totalmente abierto mientras esté desplegado. Borrar el archivo
 * apenas terminemos de mirar el resultado.
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
const CLAVE_TEMPORAL = "boxly-debug-2026";

module.exports = async function handler(req, res) {
  if (req.query.clave !== CLAVE_TEMPORAL) {
    return res.status(403).json({ error: "Clave incorrecta." });
  }

  try {
    const resultado = { users: [], negocios: [] };

    const usersSnap = await db.collection("users").get();
    usersSnap.forEach((doc) => {
      const d = doc.data();
      resultado.users.push({
        uid: doc.id,
        email: d.email || null,
        rol: d.rol || null,
        negocioId: d.negocioId || null,
        sucursalId: d.sucursalId || null
      });
    });

    const negociosSnap = await db.collection("negocios").get();
    const negociosIds = new Set(negociosSnap.docs.map((d) => d.id));

    // FIX: si el documento negocios/{id} nunca se creó formalmente (solo se
    // crearon sucursales adentro con .add()), Firestore no lo devuelve en
    // negocios.get() — pero la subcolección igual existe y es válida. Con
    // collectionGroup buscamos TODAS las sucursales de toda la base, sin
    // depender de que el "padre" exista.
    const todasSucursalesSnap = await db.collectionGroup("sucursales").get();
    const sucursalesPorNegocio = {};
    todasSucursalesSnap.forEach((doc) => {
      const negocioId = doc.ref.parent.parent ? doc.ref.parent.parent.id : "(sin padre)";
      if (!sucursalesPorNegocio[negocioId]) sucursalesPorNegocio[negocioId] = [];
      sucursalesPorNegocio[negocioId].push({ id: doc.id, nombre: doc.data().nombre || null });
    });

    const todosLosNegocioIds = new Set([...negociosIds, ...Object.keys(sucursalesPorNegocio)]);
    for (const negocioId of todosLosNegocioIds) {
      resultado.negocios.push({
        negocioId,
        negocioDocExiste: negociosIds.has(negocioId),
        sucursales: sucursalesPorNegocio[negocioId] || []
      });
    }

    return res.status(200).json(resultado);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
};
