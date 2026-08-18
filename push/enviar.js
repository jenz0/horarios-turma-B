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
 *
 * JANELA DE RECUPERAÇÃO
 * O agendamento do GitHub Actions é "melhor esforço": execuções atrasam
 * e às vezes são descartadas. Por isso a fila inclui também aulas que já
 * deveriam ter sido avisadas (até ATRASO min depois do início) e o script
 * guarda em push/estado/enviados.json o que já saiu hoje, para não repetir.
 * Sem esse arquivo o comportamento é o de antes: só a janela para a frente.
 */
const fs = require('fs');
const path = require('path');
// web-push só é carregado no envio real (o modo --seco roda sem a lib)

const RAIZ = path.join(__dirname, '..');
const FUSO = -3;                 // Salvador, sem horário de verão
const ANTECEDENCIA = 15;         // avisar N min antes
const JANELA = 15;               // largura da janela (= intervalo do cron)
const ATRASO = 30;               // recuperar aula perdida até N min após o início
const HORA_FERIADO = 7 * 60;     // aviso de feriado entregue às 07:00 em ponto
/* Ícones: o mesmo arquivo serve as duas turmas — usa o que existir no repo. */
const achar = (...nomes) => nomes.find(n => fs.existsSync(path.join(RAIZ, n)));
const ICONE = './' + (achar('icon-192-a.png', 'icone-512.png', 'icon-512-a.png') || 'icone-512.png');
const BADGE = './' + (achar('badge-a.png', 'icon-192-a.png', 'icone-512.png') || 'icone-512.png');
const ESTADO = process.env.ESTADO_PATH || path.join(RAIZ, 'push', 'estado', 'enviados.json');
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
    FERIADOS:  pega(/\nconst FERIADOS=(\{[\s\S]*?\});/, 'FERIADOS'),
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
const hhmm = n => String(Math.floor(n / 60)).padStart(2, '0') + ':' +
                  String(n % 60).padStart(2, '0');

/* ---------- estado: o que já foi enviado hoje ---------- */
function lerEstado(hoje) {
  try {
    const e = JSON.parse(fs.readFileSync(ESTADO, 'utf8'));
    if (e && e.dia === hoje && Array.isArray(e.tags)) return new Set(e.tags);
  } catch (_) { /* primeira execução do dia, ou cache ainda vazio */ }
  return new Set();
}
function gravarEstado(hoje, tags) {
  try {
    fs.mkdirSync(path.dirname(ESTADO), { recursive: true });
    fs.writeFileSync(ESTADO, JSON.stringify({ dia: hoje, tags: [...tags] }));
  } catch (e) {
    console.error('aviso: não consegui gravar o estado —', e.message);
  }
}

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
function pendentes({ DADOS, BLOCOS, CARROSSEL, FERIADOS }) {
  const ag = agoraLocal();
  const hojeMs = Date.UTC(ag.getUTCFullYear(), ag.getUTCMonth(), ag.getUTCDate());
  const minAgora = ag.getUTCHours() * 60 + ag.getUTCMinutes();
  const ate  = minAgora + ANTECEDENCIA + JANELA;   // limite para a frente
  const desde = minAgora - ATRASO;                 // recuperação para trás
  const dentro = ini => ini >= desde && ini < ate;
  const fila = [];

  /* Feriado: nenhuma notificação de aula, apenas um aviso às 07:00.
     A janela vai de 07:00 até 07:45 para absorver o atraso típico do
     agendamento do GitHub Actions. A unicidade no dia vem de duas
     camadas: enviados.json (quando o estado persiste entre execuções)
     e a tag `feriado-DD/MM/AAAA`, que faz o iOS SUBSTITUIR a notificação
     em vez de empilhar caso ela saia mais de uma vez. */
  const hojeStr = `${String(ag.getUTCDate()).padStart(2,'0')}/${String(ag.getUTCMonth()+1).padStart(2,'0')}/${ag.getUTCFullYear()}`;
  const feriado = FERIADOS[hojeStr];

  if (feriado && minAgora >= HORA_FERIADO && minAgora < HORA_FERIADO + JANELA + ATRASO)
    fila.push({
      title: 'Feriado',
      body: `${feriado} — não há aula hoje.`,
      tag: `feriado-${hojeStr}`,
      atrasado: false,
      data: { tipo: 'feriado' },
    });

  if (!feriado) for (const w of DADOS)
    for (const i of w.itens) {
      if (pData(i.data) !== hojeMs) continue;
      const ini = min(i.hor);
      if (!dentro(ini)) continue;
      fila.push({
        title: i.materia,
        body: `${i.hor}${i.sala ? ' · Sala ' + i.sala : ''}\n${i.prof}`,
        tag: `aula-${i.data}-${ini}`,
        atrasado: ini < minAgora + ANTECEDENCIA,
        data: { tipo: 'aula', sem: w.sem, materia: i.materia },
      });
    }

  const sem = semanaEstudo(DADOS, hojeMs);
  if (sem !== null)
    for (const b of BLOCOS) {
      if (b.dia !== DIA7[ag.getUTCDay()]) continue;
      const ini = min(b.hora);
      if (!dentro(ini)) continue;
      const t = textoBloco(b, sem, CARROSSEL);
      fila.push({
        title: `Estudo · ${b.titulo}`,
        body: `${b.hora} · ${b.dur}${t ? '\n' + t : ''}`,
        tag: `estudo-${sem}-${b.id}`,
        atrasado: ini < minAgora + ANTECEDENCIA,
        data: { tipo: 'estudo', sem, bloco: b.id },
      });
    }
  return fila;
}

/* ---------- envio ---------- */
function enviar(fila, hoje, jaEnviados) {
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
      icon:  ICONE,
      badge: BADGE,
      tag:   n.tag,
      data:  Object.assign({ url: './' }, n.data),
    }))
    .then(() => {
      console.log('enviado:', n.title, n.atrasado ? '(recuperado)' : '');
      if (n.tag !== 'teste') jaEnviados.add(n.tag);
    })
    .catch(e => {
      console.error('falhou:', n.title, e.statusCode || e.message);
      // 404/410 = inscrição expirada: refazer pelo app e atualizar PUSH_SUB
      if (e.statusCode === 404 || e.statusCode === 410)
        console.error('>> inscrição expirada. Reative no app e atualize o secret PUSH_SUB.');
      // não marca como enviado: a próxima execução tenta de novo
    })
  )).then(() => { if (!teste) gravarEstado(hoje, jaEnviados); });
}

/* ---------- main ---------- */
const ag = agoraLocal();
const hoje = `${String(ag.getUTCDate()).padStart(2,'0')}/${String(ag.getUTCMonth()+1).padStart(2,'0')}/${ag.getUTCFullYear()}`;
const minAgora = ag.getUTCHours() * 60 + ag.getUTCMinutes();
const jaEnviados = teste ? new Set() : lerEstado(hoje);

let fila = teste
  ? [{ title: 'Horários 7º', body: 'Notificação de teste — está funcionando.',
       tag: 'teste', atrasado: false, data: { tipo: 'teste' } }]
  : pendentes(ler());

const repetidos = fila.filter(n => jaEnviados.has(n.tag)).length;
fila = fila.filter(n => !jaEnviados.has(n.tag));

console.log(`hora local ${hhmm(minAgora)}` +
            ` · janela ${hhmm(Math.max(0, minAgora - ATRASO))}–${hhmm(minAgora + ANTECEDENCIA + JANELA)}` +
            ` · ${fila.length} lembrete(s)` +
            (repetidos ? ` · ${repetidos} já enviado(s)` : ''));

if (!fila.length) process.exit(0);
if (seco) { fila.forEach(n => console.log('  [seco]', n.tag, '|', n.title, '|', n.body.replace(/\n/g, ' · '), n.atrasado ? '(recuperado)' : '')); process.exit(0); }
enviar(fila, hoje, jaEnviados);
