import express from 'express';
import { handleMessage } from './bot.js';
import { saveLead, setTakeover, normalizePhone } from './db.js';
import { setHumanTag, getContactById } from './crm.js';

const app = express();
app.use(express.json());

// ── filtro web ──────────────────────────────────────────────
app.post('/register', (req, res) => {
  const { phone, name, company, niche, problem, budget, email } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone requerido' });

  const normalized = phone.startsWith('+') ? phone : `+${phone}`;
  saveLead({ phone: normalized, name, company, niche, problem, budget, email, source: 'web' });

  const waNumber = process.env.YCLOUD_PHONE_NUMBER?.replace('+', '');
  const preText  = encodeURIComponent('Hola, acabo de completar el formulario.');
  res.json({ success: true, waLink: `https://wa.me/${waNumber}?text=${preText}` });
});

// ── voice agent handoff ─────────────────────────────────────
// Recibe contexto del agente de voz (ElevenLabs) cuando termina de hablar con un visitante.
// El voice agent es UNO solo embebido en ambas webs (Chile + Bolivia), entonces este endpoint
// actua como router: si el phone es boliviano (+591) y BOLIVIA_VOICE_LEAD_URL esta configurado,
// reenvia el lead al bot de Bolivia. Si no, guarda local (es Chile).
app.post('/voice-lead', async (req, res) => {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
  if (token !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  // ElevenLabs puede mandar los params flat o anidados bajo "parameters"
  const payload = req.body?.parameters ?? req.body;
  console.log('[voice-lead] payload recibido:', JSON.stringify(payload));

  const { nombre, phone, nicho, problema } = payload;
  if (!phone) return res.status(400).json({ error: 'phone requerido' });

  const normalized = normalizePhone(phone);
  if (!normalized) return res.status(400).json({ error: 'phone inválido' });

  // routing por pais: si es boliviano y tenemos URL configurada, forward al bot Bolivia
  const BOLIVIA_URL    = process.env.BOLIVIA_VOICE_LEAD_URL;
  const BOLIVIA_SECRET = process.env.BOLIVIA_ADMIN_SECRET || process.env.ADMIN_SECRET;

  if (normalized.startsWith('+591') && BOLIVIA_URL) {
    console.log(`[voice-lead] routing → Bolivia: ${normalized}`);
    try {
      const r = await fetch(BOLIVIA_URL, {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${BOLIVIA_SECRET}`,
        },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        const errText = await r.text();
        console.error(`[voice-lead] forward Bolivia fallo ${r.status}: ${errText}`);
        return res.status(502).json({ error: 'bolivia forward failed' });
      }
      return res.json({ success: true, routed: 'BO' });
    } catch (err) {
      console.error(`[voice-lead] forward Bolivia error: ${err.message}`);
      return res.status(502).json({ error: 'bolivia unreachable' });
    }
  }

  // pais Chile (o cualquier otro): guarda local
  saveLead({ phone: normalized, name: nombre || null, niche: nicho || null, problem: problema || null, source: 'voice' });
  res.json({ success: true, routed: 'CL' });
});

// ── webhook YCloud ──────────────────────────────────────────
app.get('/webhook', (_req, res) => res.sendStatus(200));

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const event = req.body;

    // log temporal — para diagnosticar entrega de YCloud
    console.log('[webhook] recibido:', JSON.stringify({
      type: event?.type,
      keys: Object.keys(event || {}),
    }));

    // mensaje entrante de WhatsApp
    if (event?.type === 'whatsapp.inbound_message.received') {
      await handleMessage(event);
      return;
    }

    // cambio de atributos de contacto (tag agregado/quitado en YCloud)
    if (event?.type === 'contact.updated' || event?.type === 'contact.attributes_changed') {
      // estructura legacy: contacto completo embebido
      let contact = event.contact;

      // estructura real de YCloud v2: solo trae id + changedAttributes
      if (!contact && event.contactAttributesChanged?.id) {
        const changed = event.contactAttributesChanged.changedAttributes || {};
        const changedKeys = Object.keys(changed);

        // log diagnostico: que atributos cambiaron exactamente
        console.log(`[contact.attrs] cambiaron: ${changedKeys.join(', ') || '(ninguno)'}`);

        // skip si solo cambio last_seen (fires en cada lectura, no necesita sync)
        const onlyLastSeen = changedKeys.length === 1 && changedKeys[0] === 'last_seen';
        if (onlyLastSeen) return;

        contact = await getContactById(event.contactAttributesChanged.id);
      }

      if (!contact?.phoneNumber) {
        console.log('[takeover] no se pudo obtener phoneNumber del contacto');
        return;
      }

      const phone  = contact.phoneNumber;
      const tags   = contact.tags || [];
      const active = tags.includes('derivado-humano');

      // sincronizar BD con el estado del tag en YCloud
      setTakeover(phone, active);
      console.log(`[takeover] sync YCloud → BD: ${phone} → ${active ? 'ON' : 'OFF'} (tags: [${tags.join(', ')}])`);
    }
  } catch (err) {
    console.error('webhook error:', err.message);
  }
});

// ── takeover manual (endpoint privado para el equipo) ───────
// POST /admin/takeover { phone, active: true/false, secret }
app.post('/admin/takeover', async (req, res) => {
  const { phone, active, secret } = req.body;
  if (secret !== process.env.ADMIN_SECRET) return res.status(401).json({ error: 'unauthorized' });
  if (!phone) return res.status(400).json({ error: 'phone requerido' });

  const normalized = phone.startsWith('+') ? phone : `+${phone}`;
  setTakeover(normalized, active);
  await setHumanTag(normalized, active).catch(() => {});

  res.json({ success: true, phone: normalized, active });
});

// ── health ──────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`whatsapp-bot corriendo en :${PORT}`));
