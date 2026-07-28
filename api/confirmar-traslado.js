/**
 * /api/confirmar-traslado.js
 * =============================================================================
 * Confirma la recepción física de un traslado (remisión) entre sucursales.
 *
 * Por qué existe este endpoint aparte de hacerlo directo desde el navegador:
 * cuando confirma el encargado de la sucursal DESTINO, hay que descontar el
 * stock de la sucursal ORIGEN (que no es la suya) y sumarlo en la propia.
 * firestore.rules a propósito solo deja a un encargado tocar el
 * stockPorSucursal de SU PROPIA sucursal (ver negocios/{id}/productos/{id})
 * — eso está bien para el uso normal del día a día, pero un traslado es
 * justo la excepción: mueve stock entre dos sucursales a la vez. Abrir esa
 * excepción directo en las reglas de Firestore significaría dejar que
 * cualquier encargado edite el stock de cualquier sucursal ajena desde la
 * consola del navegador, así que en cambio esto corre acá con el Admin SDK
 * (sin esa restricción) y valida a mano, en el propio código, que quien
 * llama tiene permiso real sobre ESTE traslado puntual: o es el
 * Administrador del negocio, o es el encargado de la sucursal destino de
 * ESE traslado.
 *
 * El stock se descuenta del origen recién acá (al confirmar recepción), no
 * al crear el traslado — así que hasta que esto no se llama, no se mueve
 * ni una unidad de stock.
 *
 * Body esperado: {
 *   trasladoId: "<id>",
 *   recepciones: [{ productId, cantidadRecibida, motivoDiferencia? }, ...]
 * }
 * Requiere Authorization: Bearer <idToken>.
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
    // ------------------------------------------------------------------
    // 1) Autenticar a quien llama
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
    if (!callerData) {
      return res.status(403).json({ error: "No se encontró tu perfil de usuario." });
    }
    const negocioId = callerData.negocioId || callerUid;
    const esAdmin = ADMIN_ROLES.includes(callerData.rol);

    // ------------------------------------------------------------------
    // 2) Validar el body
    // ------------------------------------------------------------------
    const { trasladoId, recepciones } = req.body || {};
    if (!trasladoId || typeof trasladoId !== "string") {
      return res.status(400).json({ error: "Falta el id del traslado." });
    }
    if (!Array.isArray(recepciones) || !recepciones.length) {
      return res.status(400).json({ error: "Falta el detalle de lo recibido." });
    }
    for (const r of recepciones) {
      if (!r || typeof r.productId !== "string" || typeof r.cantidadRecibida !== "number" || r.cantidadRecibida < 0) {
        return res.status(400).json({ error: "Cada producto necesita un id válido y una cantidad recibida (0 o más)." });
      }
    }

    // ------------------------------------------------------------------
    // 3) Buscar el traslado y confirmar que quien llama puede recibirlo
    // ------------------------------------------------------------------
    const trasladoRef = db.collection("negocios").doc(negocioId).collection("traslados").doc(trasladoId);
    const trasladoDoc = await trasladoRef.get();
    if (!trasladoDoc.exists) {
      return res.status(404).json({ error: "Ese traslado no existe." });
    }
    const traslado = trasladoDoc.data();

    const esEncargadoDelDestino = callerData.rol === "encargado" && callerData.sucursalId === traslado.sucursalDestinoId;
    if (!esAdmin && !esEncargadoDelDestino) {
      return res.status(403).json({ error: "Solo el Administrador o el encargado de la sucursal destino puede confirmar este traslado." });
    }
    if (traslado.estado !== "pendiente") {
      return res.status(409).json({ error: "Este traslado ya fue procesado." });
    }

    // Todos los productos enviados en el body tienen que pertenecer al remito.
    const productosEsperados = new Map((traslado.productos || []).map((p) => [p.productId, p]));
    for (const r of recepciones) {
      if (!productosEsperados.has(r.productId)) {
        return res.status(400).json({ error: "Uno de los productos no pertenece a este traslado." });
      }
    }

    const nombreQuienConfirma =
      callerData.nombre || decoded.name || (decoded.email ? decoded.email.split("@")[0] : "Usuario");

    // ------------------------------------------------------------------
    // 4) Transacción: actualizar stock de ambas sucursales, registrar los
    //    movimientos de auditoría (salida en origen / entrada en destino) y
    //    cerrar el traslado como "recibido".
    // ------------------------------------------------------------------
    // Declarado afuera de la transacción para poder informarlo en la respuesta;
    // se reinicia al principio de cada intento porque Firestore puede volver a
    // ejecutar el callback de la transacción si hay conflictos de concurrencia.
    let clampeoOrigenPorProducto = {};

    await db.runTransaction(async (transaction) => {
      clampeoOrigenPorProducto = {};
      // Firestore exige que TODAS las lecturas de una transacción sucedan
      // antes que cualquier escritura.
      const productRefs = recepciones.map((r) =>
        db.collection("negocios").doc(negocioId).collection("productos").doc(r.productId)
      );
      const productSnaps = await Promise.all(productRefs.map((ref) => transaction.get(ref)));

      // clampeoOrigenPorProducto (declarado arriba, fuera de la transacción):
      // guarda, por producto, si hubo que "frenar" el descuento de origen
      // porque el stock real disponible ya era menor a lo que decía el
      // remito (puede pasar si entre que se creó el traslado y se confirmó
      // hubo otro movimiento en esa sucursal) — se usa después para dejar
      // constancia en el movimiento y en el propio remito, en vez de dejar
      // pasar un stock negativo en silencio.

      productSnaps.forEach((snap, i) => {
        // Si el producto se borró mientras el traslado estaba pendiente, no hay
        // stock que actualizar — igual queda la constancia de lo recibido en el remito.
        if (!snap.exists) return;
        const r = recepciones[i];
        const enviado = productosEsperados.get(r.productId);
        const cantidadEnviada = enviado ? enviado.cantidadEnviada : 0;
        const data = snap.data();
        const stockPorSucursal = data.stockPorSucursal || {};
        const sinDiscriminar = Object.keys(stockPorSucursal).length === 0;
        // Si el producto todavía no tenía stock discriminado por sucursal (por
        // ejemplo, se cargó todo en "stock" general antes de usar sucursales),
        // se toma ese total como si estuviera en el origen, y desde acá el
        // producto queda discriminado por sucursal de ahí en adelante.
        const stockOrigenActual = sinDiscriminar ? (data.stock || 0) : (stockPorSucursal[traslado.sucursalOrigenId] || 0);
        const stockDestinoActual = sinDiscriminar ? 0 : (stockPorSucursal[traslado.sucursalDestinoId] || 0);
        // FIX (stock negativo): un producto físico no puede quedar en -2, -5,
        // etc. Si el stock de origen ya era menor a lo enviado (normalmente
        // porque el formulario ya lo validó antes de crear el traslado, pero
        // esto es la última barrera del lado del servidor), se frena en 0 en
        // vez de restar de más, y se deja anotado para que el Administrador
        // lo revise.
        const nuevoStockOrigen = stockOrigenActual - cantidadEnviada;
        if (nuevoStockOrigen < 0) {
          clampeoOrigenPorProducto[r.productId] = { stockOrigenActual, cantidadEnviada, faltante: -nuevoStockOrigen };
        }
        transaction.update(productRefs[i], {
          [`stockPorSucursal.${traslado.sucursalOrigenId}`]: Math.max(0, nuevoStockOrigen),
          [`stockPorSucursal.${traslado.sucursalDestinoId}`]: stockDestinoActual + r.cantidadRecibida
        });
      });

      const ahora = new Date().toISOString();
      recepciones.forEach((r) => {
        const enviado = productosEsperados.get(r.productId);
        const cantidadEnviada = enviado ? enviado.cantidadEnviada : 0;
        const diferencia = cantidadEnviada - r.cantidadRecibida;

        const salidaRef = db.collection("negocios").doc(negocioId).collection("movimientos").doc();
        const clampInfo = clampeoOrigenPorProducto[r.productId];
        transaction.set(salidaRef, {
          tipo: "salida",
          productId: r.productId,
          cantidad: cantidadEnviada,
          nota: `Traslado ${traslado.numero} → ${traslado.sucursalDestinoNombre || ""}${
            clampInfo ? ` · ⚠ el stock de origen ya era menor a lo enviado (tenía ${clampInfo.stockOrigenActual}, faltaron ${clampInfo.faltante}) — quedó en 0, revisar` : ""
          }`.trim(),
          sucursalId: traslado.sucursalOrigenId,
          montoTotal: 0,
          esTraslado: true,
          trasladoId,
          creadoPorUid: traslado.creadoPorUid,
          creadoPorNombre: traslado.creadoPorNombre,
          fecha: ahora
        });

        const entradaRef = db.collection("negocios").doc(negocioId).collection("movimientos").doc();
        transaction.set(entradaRef, {
          tipo: "entrada",
          productId: r.productId,
          cantidad: r.cantidadRecibida,
          nota: `Traslado ${traslado.numero} ← ${traslado.sucursalOrigenNombre || ""}${
            diferencia !== 0 ? ` · diferencia ${diferencia > 0 ? "-" : "+"}${Math.abs(diferencia)} (${r.motivoDiferencia || "sin motivo indicado"})` : ""
          }`.trim(),
          sucursalId: traslado.sucursalDestinoId,
          montoTotal: 0,
          esTraslado: true,
          trasladoId,
          creadoPorUid: callerUid,
          creadoPorNombre: nombreQuienConfirma,
          fecha: ahora
        });
      });

      transaction.update(trasladoRef, {
        estado: "recibido",
        recepcion: {
          fecha: ahora,
          recibidoPorUid: callerUid,
          recibidoPorNombre: nombreQuienConfirma,
          productos: recepciones.map((r) => {
            const enviado = productosEsperados.get(r.productId);
            const cantidadEnviada = enviado ? enviado.cantidadEnviada : 0;
            return {
              productId: r.productId,
              cantidadRecibida: r.cantidadRecibida,
              diferencia: cantidadEnviada - r.cantidadRecibida,
              motivoDiferencia: r.motivoDiferencia || ""
            };
          })
        }
      });
    });

    const productosConFaltante = Object.keys(clampeoOrigenPorProducto);
    return res.status(200).json({
      ok: true,
      advertencia: productosConFaltante.length
        ? `El stock de origen ya era menor a lo enviado en ${productosConFaltante.length} producto(s) del remito — se dejó en 0 en vez de quedar negativo. Revisá el inventario de esa sucursal.`
        : null
    });
  } catch (err) {
    console.error("Error inesperado en /api/confirmar-traslado:", err);
    return res.status(500).json({ error: "Error interno del servidor." });
  }
};
