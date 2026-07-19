# Boxly — Cómo activar Firebase

Esta app ya viene lista para conectarse a Firebase. Mientras no la configures,
funciona en **modo demo** (usuarios y sesión guardados en el navegador con
`localStorage`), así podés probar todo el flujo de login/registro y el resto
del panel sin backend.

## Pasos

1. Entrá a https://console.firebase.google.com y creá un proyecto (o usá uno
   existente).
2. En **Authentication → Sign-in method**, habilitá:
   - Correo electrónico/contraseña
   - Google
3. (Opcional, recomendado) Activá **Firestore Database** para guardar en la
   nube el perfil de usuario, productos, movimientos, etc. en vez de
   `localStorage`.
4. Andá a **Configuración del proyecto → Tus apps → SDK de Firebase** y copiá
   el objeto de configuración.
5. Pegalo en `firebase-config.js`, reemplazando el objeto `FIREBASE_CONFIG`.
6. En `login.html` y en `app.html`, descomentá las 3 etiquetas `<script>` del
   SDK de Firebase que están arriba de `firebase-config.js`:
   ```html
   <script src="https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js"></script>
   <script src="https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js"></script>
   <script src="https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore-compat.js"></script>
   ```
7. ¡Listo! `login.js` y `app.js` detectan automáticamente que Firebase está
   configurado (función `isFirebaseReady()`) y a partir de ahí usan
   Authentication real — Google y email/contraseña — en vez del modo demo.
   No hace falta tocar nada más del código.

## Estructura sugerida en Firestore

```
users/{uid}
  - nombre, email, rol, negocioId, fotoURL, creadoEn

negocios/{negocioId}
  - nombreNegocio, moneda, stockMinimoDefault, logoBase64 (o URL en Storage),
    direccion, telefono, email, fiscal

negocios/{negocioId}/productos/{productId}
negocios/{negocioId}/movimientos/{movId}
```

Esto te permite tener multi-usuario y multi-negocio manteniendo la misma
forma de datos que ya usa `STORE` en `app.js` (`products`, `movements`,
`users`, `settings`).

## Archivos involucrados

| Archivo             | Qué hace |
|---------------------|----------|
| `login.html`         | Pantalla de inicio de sesión / registro, con botón de Google y panel publicitario a la derecha (solo desktop). |
| `login.js`           | Lógica de login/registro. Usa Firebase si está listo; si no, cae en modo demo con `localStorage`. |
| `firebase-config.js` | Config de Firebase + `isFirebaseReady()` / `initFirebase()`. Se carga en `login.html` y en `app.html`. |
| `app.html` / `app.js`| Panel principal. Al cargar, si no hay sesión (`boxly_auth_user` en `localStorage`), redirige a `login.html`. El botón de "Cerrar sesión" del sidebar limpia la sesión y también llama a `firebase.auth().signOut()` si Firebase está activo. |

## Notas

- El tour de bienvenida se dispara automáticamente para usuarios que se
  **registran** (no para los que solo inician sesión), y se puede volver a
  ver desde **Ayuda y soporte → Ver tour de bienvenida**.
- Los datos de producto/inventario siguen viviendo en `localStorage`
  (`STORE`) hasta que decidas migrarlos a Firestore siguiendo la estructura
  de arriba.
