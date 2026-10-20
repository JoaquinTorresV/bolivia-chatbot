// Capa de mensajería WhatsApp vía Zernio (bot de Bolivia).
// Zernio trabaja por CONVERSACIONES, no por número: la plantilla abre/retoma la conversación
// (participantId = teléfono); el texto libre se envía a un conversationId (viene en el webhook).
const API_KEY    = process.env.ZERNIO_API_KEY;
const ACCOUNT_ID = process.env.ZERNIO_ACCOUNT_ID;   // id de la cuenta de WhatsApp en Zernio
const BASE       = 'https://zernio.com/api/v1';
const TEMPLATE_LANG = process.env.ZERNIO_TEMPLATE_LANG || 'es';

export const zernioReady = !!(API_KEY && ACCOUNT_ID);

function headers() {
  return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` };
}

async function zpost(path, body) {
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Zernio ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

// Envía una plantilla aprobada a un número (abre o retoma la conversación).
// params = valores de las variables {{1}},{{2}},... en orden. Equivale al sendTemplate de YCloud.
export function sendTemplate(to, name, params = [], lang = TEMPLATE_LANG) {
  return zpost('/inbox/conversations', {
    accountId: ACCOUNT_ID,
    participantId: String(to).replace(/^\+/, ''),   // Zernio espera el teléfono internacional
    templateName: name,
    templateLanguage: lang,
    templateParams: params.map(String),
  });
}

// Texto libre dentro de la ventana de 24h, en una conversación existente (conversationId del webhook).
export function sendMessage(conversationId, text) {
  return zpost(`/inbox/conversations/${encodeURIComponent(conversationId)}/messages`, {
    accountId: ACCOUNT_ID,
    message: text,
  });
}

// Indicador de "escribiendo..."; en WhatsApp también marca como leído el último entrante.
// Fire-and-forget: no bloquea ni rompe el flujo principal.
export function markReadWithTyping(conversationId) {
  if (!conversationId || !ACCOUNT_ID) return;
  fetch(`${BASE}/inbox/conversations/${encodeURIComponent(conversationId)}/typing`, {
    method: 'POST', headers: headers(), body: JSON.stringify({ accountId: ACCOUNT_ID }),
  }).catch(() => {});
}

// Descarga un adjunto de WhatsApp (audio, imagen…). La URL del webhook apunta a un endpoint
// autenticado de Zernio, así que hay que mandar el Bearer. Devuelve un Buffer.
export async function fetchMedia(mediaUrl) {
  const res = await fetch(mediaUrl, { headers: { 'Authorization': `Bearer ${API_KEY}` } });
  if (!res.ok) throw new Error(`Zernio media ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
