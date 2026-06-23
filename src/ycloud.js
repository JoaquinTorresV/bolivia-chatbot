const API_KEY = process.env.YCLOUD_API_KEY;
const FROM    = process.env.YCLOUD_PHONE_NUMBER;
const BASE    = 'https://api.ycloud.com/v2';

async function ycloudfetch(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`YCloud ${path}: ${await res.text()}`);
  return res.json();
}

export function sendWhatsApp(to, text) {
  return ycloudfetch('/whatsapp/messages/sendDirectly', {
    from: FROM, to, type: 'text', text: { body: text },
  });
}

// marca el mensaje entrante como leido y muestra typing indicator (check azul + "escribiendo...")
// requiere el wamid del mensaje entrante, no solo el numero
// fire-and-forget: no bloquea el flujo principal
export function markReadWithTyping(wamid) {
  if (!wamid) return;
  fetch(`${BASE}/whatsapp/inboundMessages/${encodeURIComponent(wamid)}/markAsRead`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
    body: JSON.stringify({ typingIndicator: { type: 'text' } }),
  }).catch(() => {});
}

export function sendImage(to, imageUrl, caption = '') {
  return ycloudfetch('/whatsapp/messages/sendDirectly', {
    from: FROM, to, type: 'image',
    image: { link: imageUrl, caption },
  });
}

export function sendDocument(to, docUrl, filename) {
  return ycloudfetch('/whatsapp/messages/sendDirectly', {
    from: FROM, to, type: 'document',
    document: { link: docUrl, filename },
  });
}
