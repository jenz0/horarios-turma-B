/* Horários 7º — Service Worker
   Escopo: SOMENTE Web Push. Não há handler de 'fetch', portanto este arquivo
   NÃO intercepta requisições, NÃO faz cache e NÃO altera o funcionamento
   offline do app (que continua sendo um HTML autônomo).

   Payload esperado do serviço de push (JSON):
   {
     "title": "Consolidação em 10 min",
     "body":  "Teórica e laboratório da manhã de quinta + Urologia",
     "icon":  "./icon-192-a.png",       // opcional
     "badge": "./badge-a.png",          // opcional
     "tag":   "estudo-s3-qui",          // opcional, agrupa/substitui
     "data":  { "tipo": "estudo", "sem": 3, "url": "./" }
   }
   O campo data.tipo identifica a natureza da notificação (aula, estudo,
   presenca, aviso) para o app decidir o que fazer ao ser aberto. */

const VERSAO = 'h7-sw-1';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let p = {};
  if (e.data) {
    try { p = e.data.json(); }
    catch (_) { p = { body: e.data.text() }; }
  }
  const titulo = p.title || 'Horários 7º';
  const opcoes = {
    body:  p.body  || '',
    icon:  p.icon  || './icon-192.png',
    badge: p.badge || './badge.png',
    tag:   p.tag   || (p.data && p.data.tipo) || 'h7',
    renotify: p.renotify === true,
    requireInteraction: p.requireInteraction === true,
    data: Object.assign({ url: './', tipo: 'geral' }, p.data || {})
  };
  e.waitUntil(self.registration.showNotification(titulo, opcoes));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const destino = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(lista => {
        for (const c of lista) {
          if ('focus' in c) {
            c.postMessage({ tipo: 'notificacao-aberta', data: e.notification.data });
            return c.focus();
          }
        }
        if (self.clients.openWindow) return self.clients.openWindow(destino);
      })
  );
});

/* Se a inscrição for invalidada pelo navegador, o app volta a se inscrever
   na próxima abertura (ver reinscrever() no index.html). */
self.addEventListener('pushsubscriptionchange', e => {
  e.waitUntil(
    self.clients.matchAll({ includeUncontrolled: true })
      .then(l => l.forEach(c => c.postMessage({ tipo: 'reinscrever' })))
  );
});
