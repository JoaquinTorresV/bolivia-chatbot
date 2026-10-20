import express from 'express';
import { handleMessage } from './bot.js';
import { initDb, saveLead, setTakeover, markContactadoIfNuevo, normalizePhone, getLead, setEstado } from './db.js';
import { setHumanTag } from './crm.js';
import { sendTemplate } from './zernio.js';
import { updateMeeting } from './calendar.js';

const app = express();
app.use(express.json());

// CORS: permite que la landing (otro dominio) haga POST a /register desde el navegador.
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── formulario web (landing Aurun) ──────────────────────────
// Acepta el formato de la landing (nombre/negocio/whatsapp/rubro/desafio)
// y el legacy (name/company/phone/niche/problem). Guarda el lead como 'nuevo',
// envía la plantilla del primer mensaje y lo marca 'contactado'.
// El bot conversacional se activa recién cuando la persona RESPONDE.
app.post('/register', async (req, res) => {
  const b = req.body || {};
  const rawPhone = b.whatsapp || b.phone;
  if (!rawPhone) return res.status(400).json({ error: 'whatsapp/phone requerido' });

  const phone = normalizePhone(rawPhone);
  if (!phone) return res.status(400).json({ error: 'teléfono inválido' });

  const name    = b.nombre  ?? b.name    ?? null;
  const company = b.negocio ?? b.company ?? null;
  const niche   = b.rubro   ?? b.niche   ?? null;
  const problem = b.desafio ?? b.problem ?? null;
  const email   = b.email   ?? null;

  try {
    await saveLead({ phone, name, company, niche, problem, email, source: 'web', estado: 'nuevo', fbp: b.fbp, fbc: b.fbc });
  } catch (err) {
    console.error('[register] saveLead error:', err.message);
    return res.status(500).json({ error: 'no se pudo guardar el lead' });
  }

  // primer mensaje saliente = plantilla aprobada (si está configurada).
  // markContactadoIfNuevo es atómico: solo un request "gana" y envía → evita doble plantilla por doble submit.
  const tpl = process.env.ZERNIO_TEMPLATE_NAME;
  if (tpl && await markContactadoIfNuevo(phone)) {
    try {
      const firstName = (name || '').trim().split(/\s+/)[0] || '';
      await sendTemplate(phone, tpl, [firstName, company || 'tu negocio']);
    } catch (err) {
      console.error('[register] sendTemplate error:', err.message); // no rompe el registro
    }
  }

  const waNumber = process.env.ZERNIO_PHONE_NUMBER?.replace('+', '');
  const preText  = encodeURIComponent('Hola, acabo de completar el formulario.');
  res.json({ success: true, waLink: waNumber ? `https://wa.me/${waNumber}?text=${preText}` : null });
});

// ── voice agent handoff ─────────────────────────────────────
// Recibe contexto del agente de voz (ElevenLabs) para un lead boliviano y lo procesa local.
app.post('/voice-lead', async (req, res) => {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
  if (token !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const payload = req.body?.parameters ?? req.body;
  console.log('[voice-lead] payload recibido:', JSON.stringify(payload));

  const { nombre, phone, nicho, problema } = payload;
  if (!phone) return res.status(400).json({ error: 'phone requerido' });

  const normalized = normalizePhone(phone);
  if (!normalized) return res.status(400).json({ error: 'phone inválido' });

  // Este ES el bot de Bolivia: procesa el lead local (no rerutea a ningún lado).
  try {
    await saveLead({ phone: normalized, name: nombre || null, niche: nicho || null, problem: problema || null, source: 'voice' });
  } catch (err) {
    console.error('[voice-lead] saveLead error:', err.message);
    return res.status(500).json({ error: 'no se pudo guardar' });
  }

  // primer mensaje saliente tras la llamada de voz = plantilla para agendar la reunión.
  // Usa ZERNIO_TEMPLATE_VOICE si existe (plantilla específica de voz), si no cae a la de la landing.
  // markContactadoIfNuevo es atómico: solo envía si el lead está 'nuevo' → evita doble plantilla.
  const tpl = process.env.ZERNIO_TEMPLATE_VOICE || process.env.ZERNIO_TEMPLATE_NAME;
  let messaged = false;
  if (tpl && await markContactadoIfNuevo(normalized)) {
    try {
      const firstName = (nombre || '').trim().split(/\s+/)[0] || '';
      await sendTemplate(normalized, tpl, [firstName, 'tu negocio']);
      messaged = true;
    } catch (err) {
      console.error('[voice-lead] sendTemplate error:', err.message); // no rompe el registro
    }
  }

  res.json({ success: true, routed: 'BO', messaged });
});

// ── reagendar (lo usa el dashboard) ─────────────────────────
// Mueve el evento en Google Calendar (mantiene el Meet) y actualiza la BD. Protegido por ADMIN_SECRET.
app.post('/reschedule', async (req, res) => {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
  if (token !== process.env.ADMIN_SECRET) return res.status(401).json({ error: 'unauthorized' });

  const { phone, meeting_at } = req.body || {};
  if (!phone || !meeting_at) return res.status(400).json({ error: 'phone y meeting_at requeridos' });

  const normalized = normalizePhone(phone);
  const when = new Date(meeting_at);
  if (!normalized || isNaN(when.getTime())) return res.status(400).json({ error: 'datos inválidos' });

  const lead = await getLead(normalized);
  if (!lead) return res.status(404).json({ error: 'lead no encontrado' });

  let meetLink = lead.meet_link || null;
  if (lead.event_id) {
    try {
      const r = await updateMeeting(lead.event_id, when.toISOString());
      meetLink = r.meetLink || meetLink;
    } catch (err) {
      console.error('[reschedule] calendar error:', err.message);
      return res.status(502).json({ error: `calendar: ${err.message}` });
    }
  }
  // actualiza fecha + resetea recordatorio (setEstado lo hace al pasar meeting_at)
  await setEstado(normalized, 'agendado', when.toISOString(), meetLink).catch(err => {
    console.error('[reschedule] setEstado error:', err.message);
  });

  res.json({ success: true, movedCalendar: !!lead.event_id });
});

// ── webhook Zernio ──────────────────────────────────────────
app.get('/webhook', (_req, res) => res.sendStatus(200));

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const event = req.body;
    console.log('[webhook] recibido:', JSON.stringify({ event: event?.event, platform: event?.message?.platform }));

    // Zernio entrega los mensajes entrantes como `message.received`.
    if (event?.event === 'message.received' && event?.message?.platform === 'whatsapp') {
      await handleMessage(event.message);
    }
  } catch (err) {
    console.error('webhook error:', err.message);
  }
});

// ── takeover manual (endpoint privado para el equipo) ───────
app.post('/admin/takeover', async (req, res) => {
  const { phone, active, secret } = req.body;
  if (secret !== process.env.ADMIN_SECRET) return res.status(401).json({ error: 'unauthorized' });
  if (!phone) return res.status(400).json({ error: 'phone requerido' });

  const normalized = phone.startsWith('+') ? phone : `+${phone}`;
  await setTakeover(normalized, active);
  await setHumanTag(normalized, active).catch(() => {});

  res.json({ success: true, phone: normalized, active });
});

// ── health ──────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
initDb()
  .catch(err => console.error('[initDb]', err.message))
  .finally(() => app.listen(PORT, () => console.log(`whatsapp-bot (Aurun) corriendo en :${PORT}`)));
