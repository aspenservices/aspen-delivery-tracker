/* Aspen Delivery Tracker — Service Worker
 * Strategy: NETWORK-FIRST for the app document (index.html) so techs always get the freshest
 * deploy when they have signal, with a cached fallback so the app still OPENS offline. Static
 * assets (icons) are cache-first. Firebase / Google APIs are never cached — they must always
 * hit the network (and are handled by the app's own offline queue when there's no signal).
 *
 * IMPORTANT: bump CACHE_VERSION whenever you want to force-refresh the cached shell. You do NOT
 * normally need to — index.html is network-first, so new deploys are picked up automatically
 * while online. Bumping just clears the offline fallback copy.
 */
const CACHE_VERSION = 'aspen-delivery-v16'; // 2026-08-13 - build 81: el cache de arranque (aspen_dt_cache_v1) solo lleva el trabajo VIVO. Medido: 977 KB de los cuales `added` eran 769 y el 70% de esos eran entregas YA CERRADAS (delivered 54 reg/542 KB frente a upcoming 53/129 -- una cerrada pesa ~10 KB y una viva ~2,4). Ahora se guardan todas las vivas + las 12 cerradas mas recientes: 977 -> ~490 KB. Ademas el margen de seguridad baja de 4,2 M de caracteres (=8,4 MB, tope pensado para una app duena de toda la cuota) a 1,2 M: localStorage es POR ORIGEN y en aspenservices.github.io viven cinco apps. NOTA: este bump NO era imprescindible -- el documento va network-first, asi que el build 81 lo recogen solos los equipos con senal; el bump solo tira la copia offline vieja del shell. // Historico de v15, 2026-08-07 - build 80: prep.html YA NO se guarda como si fuera el app (ver el comentario del manejador fetch). // Historico de v14, 2026-07-31 - build 79: ACTUALIZACION FORZADA que no depende de las reglas. La app ya tenia auto-update via el nodo app_meta/build, pero la Fase D lo cerro a staff===true: un equipo con build viejo y sesion anonima no podia leerlo, asi que no se enteraba de que habia version nueva y se quedaba con la app abierta y sin datos, sin salida. Ahora el build tambien se pregunta a la Cloud Function deliveryVersion, que responde SIN sesion: al arrancar, al volver a primer plano y cada 10 min. El listener de RTDB sigue como via rapida para los conectados, y ambos usan el mismo _forceUpdateTo (guarda borradores, avisa, y recarga con ?v= anti-cache; guard de sessionStorage contra bucles). Verificado con 13 escenarios: sin red, respuesta vacia, build no numerico y consulta duplicada NO recargan.
const CACHE_PREFIX = 'aspen-delivery-';
const APP_SHELL = './index.html';

self.addEventListener('install', (e) => {
  // Pre-cache the app shell so the very first offline open works.
  e.waitUntil(
    caches.open(CACHE_VERSION).then((c) => c.addAll([APP_SHELL, './manifest.json']).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  // Drop old caches from previous versions.
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE_VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Never intercept Firebase, Google, or any cross-origin API/data traffic.
  const bypass = [
    'firebaseio.com', 'firebasedatabase.app', 'googleapis.com', 'google.com',
    'gstatic.com', 'googleusercontent.com', 'accounts.google.com', 'apis.google.com'
  ];
  if (bypass.some((h) => url.hostname.includes(h))) return;

  const isDoc = req.mode === 'navigate' ||
                req.destination === 'document' ||
                url.pathname.endsWith('/') ||
                url.pathname.endsWith('index.html');

  /* BUILD 80 - BUG ARREGLADO: antes CUALQUIER navegacion que saliera bien se
     guardaba bajo la clave APP_SHELL ('./index.html'). Como register('sw.js') da
     alcance a toda la carpeta, prep.html cae dentro: bastaba con que un empleado
     abriera UNA vez el link del cliente para que la copia offline del app pasara
     a ser el formulario del cliente, y a la siguiente apertura sin senal el
     service worker le servia ese formulario en lugar del app.
     Ahora solo se guarda como shell lo que ES el shell, y el respaldo offline
     solo se sirve a quien pidio el shell. */
  const esShell = url.origin === self.location.origin &&
                  (url.pathname === new URL(APP_SHELL, self.location.href).pathname ||
                   url.pathname.endsWith('/'));

  if (isDoc) {
    // NETWORK-FIRST: try the network, fall back to the cached shell when offline.
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok && esShell) {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((c) => c.put(APP_SHELL, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() =>
          caches.match(req).then((r) => r || (esShell ? caches.match(APP_SHELL) : undefined))
             .then((r) => r || new Response(
               '<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">' +
               '<div style="font:16px/1.5 system-ui;padding:40px;text-align:center;color:#334155">' +
               '<div style="font-size:38px">&#128246;</div><h2 style="margin:10px 0 6px">No connection</h2>' +
               '<p>This page needs internet. Check your signal and reload.</p></div>',
               { headers: { 'Content-Type': 'text/html; charset=utf-8' }, status: 503 }))
        )
    );
    return;
  }

  // STATIC ASSETS: cache-first with background refresh.
  e.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
