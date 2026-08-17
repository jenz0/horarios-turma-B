#!/usr/bin/env node
/* Horários 7º — remetente de lembretes (GitHub Actions)
 *
 * Lê a grade do PRÓPRIO index.html, então o remetente nunca fica
 * dessincronizado do app: atualizou a grade, atualizou o lembrete.
 *
 * Secrets necessários no repositório:
 *   VAPID_PUBLIC   chave pública  (a mesma que está no index.html)
 *   VAPID_PRIVATE  chave privada  (NUNCA vai para o código)
 *   VAPID_SUBJECT  mailto:seu@email.com
 *   PUSH_SUB       JSON da inscrição (botão "Copiar inscrição" no app)
 *
 * Uso:
 *   node push/enviar.js           -> envia o que estiver na janela
 *   node push/enviar.js --teste   -> envia uma notificação de teste
 *   node push/enviar.js --seco    -> só mostra o que enviaria
 */
const fs = require('fs');
const path = require('path');
// web-push só é carregado no envio real (o modo --seco roda sem a lib)

const RAIZ = path.join(__dirname, '..');
const FUSO = -3;                 // Salvador, sem horário de verão
const ANTECEDENCIA = 15;         // avisar N min antes
const JANELA = 15;               // largura da janela (= intervalo do cron)
const DIA7 = ['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'];

const teste = process.argv.includes('--teste');
const seco  = process.argv.includes('--seco');

/* ---------- lê a grade e os blocos de estudo direto do app ---------- */
function ler() {
  const html = fs.readFileSync(path.join(RAIZ, 'index.html'), 'utf8');
  const pega = (re, nome) => {
    const m = html.match(re);
    if (!m) throw new Error('não encontrei ' + nome + ' no index.html');
    return JSON.parse(m[1]);
  };
  return {
    DADOS:  pega(/const DADOS=(\[[\s\S]*?\]),\nBLOCOS=/, 'DADOS'),
    BLOCOS: pega(/\nBLOCOS=(\[[\s\S]*?\]),\nCARROSSEL=/, 'BLOCOS'),
    CARROSSEL: pega(/\nCARROSSEL=(\{[\s\S]*?\});/, 'CARROSSEL'),
  };
}

/* ---------- relógio local ---------- */
function agoraLocal() {
  const d = new Date();
  return new Date(d.getTime() + FUSO * 3600e3);   // trabalha em "UTC deslocado"
}
const min = t => +t.slice(0, 2) * 60 + +t.slice(3, 5);
const pData = s => { const [d, m, a] = s.split('/').map(Number);
                     return Date.UTC(a, m - 1, d); };

/* ---------- semana de estudo: ancorada na segunda ---------- */
function semanaEstudo(DADOS, hojeMs) {
  for (const s of DADOS) {
    const seg = pData(s.seg);
    if (hojeMs >= seg && hojeMs <= seg + 6 * 864e5) return s.sem;
  }
  return null;
}

function textoBloco(b, sem, CARROSSEL) {
  const c = CARROSSEL[String(sem)] || [];
  if (b.id === 'sabA') return c[0] || '';
  if (b.id === 'domB') return c[1] || '';
  return b.padrao || '';
}

/* ---------- monta a fila ---------- */
function pendentes({ DADOS, BLOCOS, CARROSSEL }) {
  const ag = agoraLocal();
  const hojeMs = Date.UTC(ag.getUTCFullYear(), ag.getUTCMonth(), ag.getUTCDate());
  const minAgora = ag.getUTCHours() * 60 + ag.getUTCMinutes();
  const de = minAgora + ANTECEDENCIA, ate = de + JANELA;
  const fila = [];

  for (const w of DADOS)
    for (const i of w.itens) {
      if (pData(i.data) !== hojeMs) continue;
      const ini = min(i.hor);
      if (ini < de || ini >= ate) continue;
      fila.push({
        title: i.materia,
        body: `${i.hor}${i.sala ? ' · Sala ' + i.sala : ''}\n${i.prof}`,
        tag: `aula-${i.data}-${ini}`,
        data: { tipo: 'aula', sem: w.sem, materia: i.materia },
      });
    }

  const sem = semanaEstudo(DADOS, hojeMs);
  if (sem !== null)
    for (const b of BLOCOS) {
      if (b.dia !== DIA7[ag.getUTCDay()]) continue;
      const ini = min(b.hora);
      if (ini < de || ini >= ate) continue;
      const t = textoBloco(b, sem, CARROSSEL);
      fila.push({
        title: `Estudo · ${b.titulo}`,
        body: `${b.hora} · ${b.dur}${t ? '\n' + t : ''}`,
        tag: `estudo-${sem}-${b.id}`,
        data: { tipo: 'estudo', sem, bloco: b.id },
      });
    }
  return fila;
}

/* ---------- envio ---------- */
function enviar(fila) {
  const webpush = require('web-push');
  const { VAPID_PUBLIC, VAPID_PRIVATE, VAPID_SUBJECT, PUSH_SUB } = process.env;
  for (const [k, v] of Object.entries({ VAPID_PUBLIC, VAPID_PRIVATE, VAPID_SUBJECT, PUSH_SUB }))
    if (!v) { console.error('secret ausente:', k); process.exit(1); }

  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
  const sub = JSON.parse(PUSH_SUB);

  return Promise.all(fila.map(n =>
    webpush.sendNotification(sub, JSON.stringify({
      title: n.title,
      body:  n.body,
      icon:  './icon-192-a.png',
      badge: './badge-a.png',
      tag:   n.tag,
      data:  Object.assign({ url: './' }, n.data),
    }))
    .then(() => console.log('enviado:', n.title))
    .catch(e => {
      console.error('falhou:', n.title, e.statusCode || e.message);
      // 404/410 = inscrição expirada: refazer pelo app e atualizar PUSH_SUB
      if (e.statusCode === 404 || e.statusCode === 410)
        console.error('>> inscrição expirada. Reative no app e atualize o secret PUSH_SUB.');
    })
  ));
}

/* ---------- main ---------- */
const fila = teste
  ? [{ title: 'Horários 7º', body: 'Notificação de teste — está funcionando.',
       tag: 'teste', data: { tipo: 'teste' } }]
  : pendentes(ler());

const ag = agoraLocal();
console.log(`hora local ${String(ag.getUTCHours()).padStart(2,'0')}:${String(ag.getUTCMinutes()).padStart(2,'0')}` +
            ` · janela +${ANTECEDENCIA} a +${ANTECEDENCIA + JANELA} min · ${fila.length} lembrete(s)`);

if (!fila.length) process.exit(0);
if (seco) { fila.forEach(n => console.log('  [seco]', n.title, '|', n.body.replace(/\n/g, ' · '))); process.exit(0); }
enviar(fila);
