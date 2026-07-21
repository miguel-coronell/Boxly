/**
 * /api/paypal-webhook.js
 * =============================================================================
 * REQUERIMIENTO 5 — Automatización de suscripciones con PayPal.
 *
 * Este endpoint es la URL que configurás como "Webhook" en tu app de PayPal
 * (Dashboard de desarrollador > Apps y credenciales > tu app > Webhooks).
 * PayPal le hace un POST cada vez que pasa algo con una suscripción:
 * se activa, se cancela, falla un pago, etc. Nunca confíes en lo que pasa
 * en el navegador (onApprove de los botones) para dar acceso real: la
 * fuente de verdad del plan de cada Administrador es SIEMPRE este webhook,
 * verificado con la firma de PayPal.
 *
 * Eventos que manejamos:
 *   - BILLING.SUBSCRIPTION.ACTIVATED   -> activa/actualiza el plan
 *   - BILLING.SUBSCRIPTION.CANCELLED   -> baja el plan a "básico" (o lo que definas)
 *   - BILLING.SUBSCRIPTION.SUSPENDED   -> igual que cancelado, pausa el acceso
 *   - BILLING.SUBSCRIPTION.EXPIRED     -> igual que cancelado
 *   - PAYMENT.SALE.COMPLETED           -> (opcional) actualizar "próximo pago"
 *
 * Variables de entorno necesarias (ver instrucciones al final de la respuesta):
 * FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY,
 * PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_WEBHOOK_ID, PAYPAL_API_BASE
 * (usá https://api-m.sandbox.paypal.com en pruebas y
 *  https://api-m.paypal.com en producción).
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

const PAYPAL_API_BASE = process.env.PAYPAL_API_BASE || "https://api-m.sandbox.paypal.com";

/* Mapea el Plan ID de PayPal (el "P-XXXXXXXXX" que creaste en el dashboard de
   PayPal) al tier interno de Boxly y sus límites. Completá con tus Plan IDs
   reales; deben coincidir con los que usás en PAYPAL_PLAN_IDS en app.js. */
const PAYPAL_PLAN_TO_TIER = {
  "P-2U160925B7282271CNJPSM3A": { tier: "basico", maxSucursales: 1, maxProductos: 100, maxDocumentos: 200 },
  "P-40H79840DY636180TNJPSLYY": { tier: "pro", maxSucursales: 5, maxProductos: 1000, maxDocumentos: 2000 },
  "P-93064402D0889823NNJPSKWQ": { tier: "premium", maxSucursales: Infinity, maxProductos: Infinity, maxDocumentos: Infinity }
};

/* Vercel no necesita configuración especial para recibir el body como JSON
   ya parseado (a diferencia de Stripe, PayPal no exige el raw body para
   verificar la firma: la API de verificación recibe el JSON tal cual). */

/* ---------------------------------------------------------------------------
   Pide un access token OAuth2 a PayPal usando client_id + secret (Client
   Credentials flow). Se usa tanto para verificar la firma del webhook como
   para, opcionalmente, consultar detalles de la suscripción. */
async function getPayPalAccessToken() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  const basicAuth = Buffer.from(`${clientId}:${secret}`).toString("base64");

  const resp = await fetch(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: "grant_type=client_credentials"
  });
  if (!resp.ok) throw new Error(`No se pudo obtener el token de PayPal (${resp.status}).`);
  const data = await resp.json();
  return data.access_token;
}

/* ---------------------------------------------------------------------------
   Verifica que el webhook realmente venga de PayPal (y no sea un POST
   falsificado por un tercero), usando el endpoint oficial de verificación
   de firma. Esto es CRÍTICO: sin esto, cualquiera podría pegarle a esta URL
   simulando "pago aprobado" y activar un plan gratis. */
async function verifyWebhookSignature(req, accessToken) {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  const verificationPayload = {
    auth_algo: req.headers["paypal-auth-algo"],
    cert_url: req.headers["paypal-cert-url"],
    transmission_id: req.headers["paypal-transmission-id"],
    transmission_sig: req.headers["paypal-transmission-sig"],
    transmission_time: req.headers["paypal-transmission-time"],
    webhook_id: webhookId,
    webhook_event: req.body
  };

  const resp = await fetch(`${PAYPAL_API_BASE}/v1/notifications/verify-webhook-signature`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(verificationPayload)
  });
  if (!resp.ok) return false;
  const data = await resp.json();
  return data.verification_status === "SUCCESS";
}

/* Actualiza el documento usuarios/{uid} del Administrador dueño de la
   suscripción con su nuevo plan, límites y próximo pago. */
async function activarPlan({ uid, tier, limits, subscriptionId, nextBillingTime }) {
  await db.collection("usuarios").doc(uid).set(
    {
      plan: {
        tier,
        estado: "activo",
        maxSucursales: limits.maxSucursales === Infinity ? -1 : limits.maxSucursales, // Firestore no guarda Infinity
        maxProductos: limits.maxProductos === Infinity ? -1 : limits.maxProductos,
        maxDocumentos: limits.maxDocumentos === Infinity ? -1 : limits.maxDocumentos,
        subscriptionId,
        proximoPago: nextBillingTime ? new Date(nextBillingTime) : null,
        actualizadoEn: admin.firestore.FieldValue.serverTimestamp()
      }
    },
    { merge: true }
  );
}

async function cancelarPlan({ uid, subscriptionId, motivo }) {
  await db.collection("usuarios").doc(uid).set(
    {
      plan: {
        tier: "basico",
        estado: motivo, // "cancelado" | "suspendido" | "expirado"
        subscriptionId,
        actualizadoEn: admin.firestore.FieldValue.serverTimestamp()
      }
    },
    { merge: true }
  );
}

/* Busca al Admin (uid de Firestore) a partir del custom_id que mandamos al
   crear la suscripción en el frontend (ver createSubscription() en app.js,
   sección Mi Plan: le pasamos custom_id: CURRENT_USER.uid). Si tu integración
   real de Firebase Auth usa el mismo uid como id del doc en "usuarios",
   esto alcanza; si no, ajustá esta función a tu esquema. */
function resolveAdminUid(resource) {
  return resource.custom_id || (resource.subscriber && resource.subscriber.payer_id) || null;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método no permitido." });
  }

  try {
    const accessToken = await getPayPalAccessToken();

    const isValid = await verifyWebhookSignature(req, accessToken);
    if (!isValid) {
      console.warn("Webhook de PayPal con firma inválida. Ignorado.");
      return res.status(400).json({ error: "Firma de webhook inválida." });
    }

    const event = req.body;
    const eventType = event.event_type;
    const resource = event.resource || {};

    console.log(`Webhook de PayPal recibido: ${eventType}`);

    switch (eventType) {
      case "BILLING.SUBSCRIPTION.ACTIVATED": {
        const uid = resolveAdminUid(resource);
        const planId = resource.plan_id;
        const tierInfo = PAYPAL_PLAN_TO_TIER[planId];

        if (!uid || !tierInfo) {
          console.warn("No se pudo resolver uid o plan_id en ACTIVATED:", { uid, planId });
          break;
        }

        await activarPlan({
          uid,
          tier: tierInfo.tier,
          limits: tierInfo,
          subscriptionId: resource.id,
          nextBillingTime: resource.billing_info && resource.billing_info.next_billing_time
        });
        break;
      }

      case "BILLING.SUBSCRIPTION.CANCELLED":
      case "BILLING.SUBSCRIPTION.SUSPENDED":
      case "BILLING.SUBSCRIPTION.EXPIRED": {
        const uid = resolveAdminUid(resource);
        if (!uid) {
          console.warn(`No se pudo resolver uid en ${eventType}`);
          break;
        }
        const motivoMap = {
          "BILLING.SUBSCRIPTION.CANCELLED": "cancelado",
          "BILLING.SUBSCRIPTION.SUSPENDED": "suspendido",
          "BILLING.SUBSCRIPTION.EXPIRED": "expirado"
        };
        await cancelarPlan({ uid, subscriptionId: resource.id, motivo: motivoMap[eventType] });
        break;
      }

      case "PAYMENT.SALE.COMPLETED": {
        // Opcional: acá podrías refrescar "próximo pago" en cada cobro recurrente
        // consultando GET /v1/billing/subscriptions/{id} para traer next_billing_time
        // actualizado, si te interesa mostrarlo con precisión en "Mi Plan".
        break;
      }

      default:
        // Otros eventos (PAYMENT.SALE.DENIED, BILLING.SUBSCRIPTION.PAYMENT.FAILED, etc.)
        // podés agregarlos acá a medida que los necesites.
        break;
    }

    // PayPal solo necesita un 200 rápido para no reintentar el webhook.
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("Error procesando webhook de PayPal:", err);
    // Ojo: devolver 500 hace que PayPal reintente el webhook más tarde, lo cual
    // está bien si el error fue transitorio (ej: Firestore caído un instante).
    return res.status(500).json({ error: "Error interno procesando el webhook." });
  }
};
