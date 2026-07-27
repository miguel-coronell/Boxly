/**
 * diagnostico.js
 * -----------------------------------------------------------------------
 * Script de SOLO LECTURA para revisar, directo desde Firestore (con el
 * Admin SDK, sin pasar por las Rules del cliente), qué usuarios existen,
 * a qué negocioId pertenece cada uno, y qué sucursales tiene cada negocio.
 *
 * No modifica nada. Corré con:
 *   node diagnostico.js
 * -----------------------------------------------------------------------
 */

require("dotenv").config({ path: ".env.local" });
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

async function main() {
  console.log("=== USERS ===");
  const usersSnap = await db.collection("users").get();
  if (usersSnap.empty) {
    console.log("(no hay documentos en la colección 'users')");
  }
  usersSnap.forEach((doc) => {
    const d = doc.data();
    console.log(`- uid: ${doc.id}`);
    console.log(`  email: ${d.email || "(sin email)"}`);
    console.log(`  rol: ${d.rol || "(sin rol)"}`);
    console.log(`  negocioId: ${d.negocioId || "(sin negocioId)"}`);
    console.log(`  sucursalId: ${d.sucursalId || "(ninguna, o es Administrador)"}`);
    console.log("");
  });

  console.log("=== NEGOCIOS Y SUS SUCURSALES ===");
  const negociosSnap = await db.collection("negocios").get();
  if (negociosSnap.empty) {
    console.log("(no hay documentos en la colección 'negocios')");
  }
  for (const negocioDoc of negociosSnap.docs) {
    console.log(`- negocioId: ${negocioDoc.id}`);
    const sucursalesSnap = await db.collection("negocios").doc(negocioDoc.id).collection("sucursales").get();
    if (sucursalesSnap.empty) {
      console.log("  (sin sucursales)");
    } else {
      sucursalesSnap.forEach((s) => {
        console.log(`  - sucursalId: ${s.id} | nombre: ${s.data().nombre || "(sin nombre)"}`);
      });
    }
    console.log("");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Error corriendo el diagnóstico:", err);
    process.exit(1);
  });
