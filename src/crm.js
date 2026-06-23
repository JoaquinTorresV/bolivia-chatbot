const API_KEY   = process.env.YCLOUD_API_KEY;
const BASE      = 'https://api.ycloud.com/v2';
const TAG_HUMAN = 'derivado-humano';

async function get(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { 'X-API-Key': API_KEY } });
  if (!res.ok) throw new Error(`YCloud GET ${path}: ${await res.text()}`);
  return res.json();
}

async function patch(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`YCloud PATCH ${path}: ${await res.text()}`);
  return res.json();
}

// busca contacto por numero (devuelve null si no existe)
async function findContact(phoneNumber) {
  const data = await get(`/contact/contacts?phoneNumber=${encodeURIComponent(phoneNumber)}`);
  return data.items?.[0] || null;
}

// busca contacto por id interno de YCloud (devuelve null si no existe)
export async function getContactById(id) {
  try {
    return await get(`/contact/contacts/${id}`);
  } catch {
    return null;
  }
}

// crea el contacto si no existe, o actualiza el nickname si ya existe sin uno
export async function upsertContact(phoneNumber, nickname) {
  const res = await fetch(`${BASE}/contact/contacts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
    body: JSON.stringify({ phoneNumber, nickname, tags: ['whatsapp-bot'] }),
  });

  // si ya existe (409), intentar actualizar el nickname si esta vacio
  if (res.status === 409) {
    if (!nickname) return;
    const contact = await findContact(phoneNumber);
    if (contact && !contact.nickname) {
      await patch(`/contact/contacts/${contact.id}`, { nickname });
    }
    return;
  }

  if (!res.ok) throw new Error(`CRM upsert: ${await res.text()}`);
}

// agrega o quita el tag derivado-humano en YCloud
export async function setHumanTag(phoneNumber, active) {
  const contact = await findContact(phoneNumber);
  if (!contact) return;

  const current = contact.tags || [];
  const tags = active
    ? [...new Set([...current, TAG_HUMAN])]
    : current.filter(t => t !== TAG_HUMAN);

  await patch(`/contact/contacts/${contact.id}`, { tags });
}
