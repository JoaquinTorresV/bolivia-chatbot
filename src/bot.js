import Anthropic from '@anthropic-ai/sdk';
import { getHistory, saveHistory, clearHistory, getLead, saveLead, saveLeadEmail, isTakeover, setTakeover, setEstado } from './db.js';
import { getAvailableSlots, createMeeting, updateMeeting, cancelMeeting, checkSlot, nearbyFreeSlots, nowInBolivia } from './calendar.js';
import { sendMessage, markReadWithTyping } from './zernio.js';
import { upsertContact, setHumanTag } from './crm.js';
import { transcribeAudio } from './media.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE_PROMPT = readFileSync(join(__dirname, '../prompts/system.md'), 'utf-8');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-haiku-4-5';

const TOOLS = [
  {
    name: 'save_lead_context',
    description: `Guarda la información que recopilaste del usuario durante la conversación.
Úsala cuando tengas el rubro y el problema del usuario. El nombre es ideal pero opcional.
Úsala una sola vez por conversación, en cuanto tengas rubro + problema.

**IMPORTANTE — guardado silencioso:** este tool corre en background, NO lo anuncies al usuario. NUNCA digas "déjame guardar esto", "voy a registrar", "déjame anotar" ni nada similar. En el MISMO mensaje en que llamas a este tool, escribes la respuesta completa al usuario (acknowledgment + conexión con el servicio + propuesta de reunión). El usuario nunca debe percibir que estás guardando algo.`,
    input_schema: {
      type: 'object',
      properties: {
        name:    { type: 'string', description: 'Nombre del usuario' },
        niche:   { type: 'string', description: 'Tipo de negocio o rubro (ej: restaurante, clínica, ecommerce)' },
        problem: { type: 'string', description: 'Problema o necesidad principal que mencionó' },
      },
      required: ['niche', 'problem'],
    },
  },
  {
    name: 'check_availability',
    description: `Verifica si una fecha y hora PUNTUAL está libre para la reunión. Úsala en cuanto el prospecto proponga un día y una hora (ej: "mañana a las 16:00").
Devuelve "DISPONIBLE" si está libre, o "NO DISPONIBLE" con una lista de horarios cercanos libres para ofrecerle.
Construye el ISO con la fecha actual que tienes en el prompt; si está en el pasado o mal, el sistema te lo dice y lo corriges.`,
    input_schema: {
      type: 'object',
      properties: {
        startIso: { type: 'string', description: 'Fecha y hora propuesta por el prospecto, en ISO 8601 hora Bolivia (ej: "2026-10-02T16:00:00-03:00")' },
      },
      required: ['startIso'],
    },
  },
  {
    name: 'get_available_slots',
    description: 'Lista horarios libres (repartidos en ~2 semanas). Úsala SOLO si el prospecto pide expresamente "qué horarios tienes" o no tiene preferencia de hora. Si propuso una hora concreta, usa check_availability en su lugar.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'schedule_meeting',
    description: `Agenda la reunión en Google Calendar y genera el link de Google Meet. Úsala cuando el prospecto haya elegido un horario y dado su email.

**La forma segura de pasar la fecha es el campo "iso" que devuelve get_available_slots, tal cual.** Si el prospecto pide un día u hora que no está en esa lista, llama primero a get_available_slots para conocer la fecha real de ese día — nunca deduzcas el año ni el mes de memoria.

Si construyes un ISO a mano, **incluye siempre el offset de Bolivia** (ej: "2026-09-09T12:30:00-03:00"). Sin offset se asume hora de Bolivia, pero es mejor ser explícito.

El sistema valida antes de agendar y rechaza: fechas en el pasado, menos de 1 hora de anticipación, fines de semana, horas fuera de 9:00–18:00 hora Bolivia, y horarios ya ocupados. Si te rechaza, te dice por qué — corrige y vuelve a intentar con una fecha válida, sin alarmar al prospecto.`,
    input_schema: {
      type: 'object',
      properties: {
        startIso:      { type: 'string', description: 'Fecha y hora de inicio en ISO 8601 con zona horaria de Bolivia, ej: "2026-05-27T12:30:00-04:00"' },
        attendeeEmail: { type: 'string', description: 'Email del prospecto' },
        summary:       { type: 'string', description: 'Título del evento (ej: "Reunión con Juan - Restaurante El Sol")' },
      },
      required: ['startIso', 'attendeeEmail', 'summary'],
    },
  },
  {
    name: 'reschedule_meeting',
    description: `Mueve una reunión YA agendada a una nueva hora. Úsala cuando un prospecto con reunión agendada pide cambiarla de día u hora, o cuando avisa que llegará MÁS de 15 minutos tarde (un atraso de 15 minutos o menos NO se reagenda: se mantiene la reunión y le dices que lo esperamos).

Mantiene el mismo link de Google Meet; solo cambia la hora. El sistema valida el nuevo horario igual que al agendar (no en el pasado, al menos 1h de anticipación, día hábil, 9:00–18:00 hora Bolivia, libre). Pasa el nuevo horario como el campo "iso" que devuelve get_available_slots, o un ISO con offset de Bolivia.`,
    input_schema: {
      type: 'object',
      properties: {
        startIso: { type: 'string', description: 'Nueva fecha y hora en ISO 8601 con offset de Bolivia, ej: "2026-10-20T15:00:00-03:00"' },
      },
      required: ['startIso'],
    },
  },
  {
    name: 'cancel_meeting',
    description: `Cancela la reunión agendada y la quita del calendario, marcando el lead como perdido. Úsala SOLO cuando el prospecto dice claramente que NO va a asistir y NO quiere reagendar. Antes de usarla, SIEMPRE ofrécele reagendar una vez.`,
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Motivo breve de la cancelación (para registro interno)' },
      },
      required: ['reason'],
    },
  },
  {
    name: 'transfer_to_human',
    description: `Transfiere esta conversación a un agente humano del equipo.
Úsala cuando:
- El usuario pide explícitamente hablar con una persona (con cualquier fraseo)
- La pregunta o situación está fuera de tu alcance o conocimiento
- Detectas frustración, enojo o insatisfacción real del usuario
- Se necesita tomar una decisión comercial que solo puede hacer el equipo
- No tienes información suficiente para dar una respuesta precisa y útil`,
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Motivo breve de la transferencia (para registro interno)' },
      },
      required: ['reason'],
    },
  },
];

function fechaActualBlock() {
  return '\n\n## Fecha y hora actual\n\n'
    + `Ahora en Bolivia es **${nowInBolivia()}**.\n\n`
    + 'Cuando el prospecto diga "el miercoles", "manana" o "la proxima semana", resuelvelo contra ESTA fecha.\n'
    + 'Nunca inventes el año ni el mes. Lo seguro es llamar `get_available_slots` y usar el campo `iso` tal cual viene: '
    + 'si construyes un ISO a mano y te equivocas de año, el sistema lo va a rechazar.';
}

// Bloque de contexto cuando el lead ya tiene una reunión agendada: le da a Maya la hora
// exacta y las reglas para manejar la respuesta al recordatorio (confirma / tarde / reagendar).
function reunionBlock(lead) {
  if (lead?.estado !== 'agendado' || !lead?.meeting_at) return '';
  const cuando = new Intl.DateTimeFormat('es-CL', {
    weekday: 'long', day: 'numeric', month: 'long',
    hour: '2-digit', minute: '2-digit', hour12: false,
    timeZone: 'America/La_Paz',
  }).format(new Date(lead.meeting_at));
  return '\n\n## Reunión agendada de este prospecto\n'
    + `Ya tiene una reunión agendada para **${cuando}** (hora Bolivia). Le llega un recordatorio automático 1 hora antes. Si su mensaje tiene que ver con esa reunión, aplica estas reglas:\n`
    + '- Confirma que asiste ("sí", "ahí estaré", "en una hora", "en un rato", 👍) → mantienes la reunión y le dices que lo esperas. NO reagendas.\n'
    + '- Avisa que llegará un poco tarde, **15 minutos o menos** → mantienes la reunión, le dices que tranquilo, que lo esperamos. NO reagendas.\n'
    + '- Avisa que llegará **más de 15 minutos** tarde → le propones moverla para que la aproveche completa; le ofreces un horario cercano o tomas el que proponga, y usas `reschedule_meeting`.\n'
    + '- Pide cambiar de día u hora, o no puede a esa hora → reagendas con `reschedule_meeting` (ofrece horarios con `get_available_slots` o toma su propuesta).\n'
    + '- Dice que no va a asistir → le ofreces reagendar UNA vez; si insiste en que no, usas `cancel_meeting`.\n'
    + '**Clave:** "en una hora" o "en un rato" = llega a la hora de la reunión (el recordatorio salió 1h antes). Es confirmación, NO reagendamiento.';
}

function buildSystemPrompt(lead) {
  // El modelo no sabe que dia es hoy: sin esto construye ISOs con el año equivocado.
  // Caso real (2026-09-07): el prospecto pidio "miercoles a las 10" y agendo el
  // miercoles 8 de enero de 2025 — 607 dias en el pasado.
  let prompt = BASE_PROMPT + fechaActualBlock();

  if (!lead) return prompt;

  const lines = [];
  if (lead.name)    lines.push(`- Nombre: ${lead.name}`);
  if (lead.company) lines.push(`- Empresa: ${lead.company}`);
  if (lead.niche)   lines.push(`- Rubro: ${lead.niche}`);
  if (lead.problem) lines.push(`- Problema principal: "${lead.problem}"`);
  if (lead.email)   lines.push(`- Email: ${lead.email}`);

  if (lines.length) {
    const origin = lead.source === 'voice'
      ? 'Este usuario ya habló contigo en el agente de voz de la web — eres la misma Maya, solo cambió el canal. Ya sabes lo siguiente — NO repitas estas preguntas ni le recites estos datos de vuelta:'
      : 'Este usuario llegó con contexto previo. Ya sabes:';
    prompt += `\n\n## Contexto del prospecto\n${origin}\n${lines.join('\n')}\nSalúdalo por su nombre desde el primer mensaje y adapta la conversación a su rubro y problema. Menciona su tema en media línea, haz como máximo UNA pregunta corta y propón la reunión — nada de recapitular lo que ya sabes.`;
  }

  prompt += reunionBlock(lead);
  return prompt;
}

async function callClaude(systemPrompt, messages) {
  return anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: systemPrompt,
    messages,
    tools: TOOLS,
  });
}

// Zernio entrega el teléfono sin '+'; lo pasamos a formato internacional.
function phoneFromSender(raw) {
  if (!raw) return null;
  const d = String(raw).replace(/\D/g, '');
  return d ? `+${d}` : null;
}

// `msg` es el objeto `message` del webhook `message.received` de Zernio.
export async function handleMessage(msg) {
  if (!msg || msg.direction === 'outgoing') return;   // ignora el eco de lo que enviamos

  const phone          = phoneFromSender(msg.sender?.id);
  const conversationId = msg.conversationId;
  if (!phone || !conversationId) return;

  // takeover activo → bot no interviene
  if (await isTakeover(phone)) return;

  // fire-and-forget: typing (en WhatsApp también marca como leído) — por conversación
  markReadWithTyping(conversationId);

  // try/catch global: cualquier error inesperado → fallback al usuario en vez de dejarlo en el visto
  try {
    const userContent = await extractContent(msg, conversationId);
    if (!userContent) return;

    const lead = await getLead(phone);
    const displayName = lead?.name || msg.sender?.name || null;

    // Lead directo (escribió sin venir de landing/voz): regístralo YA como 'incompleto' para no
    // perderlo. Pasa a 'respondió' cuando dé rubro+problema.
    if (!lead) {
      await saveLead({ phone, name: displayName, source: 'organic', estado: 'incompleto' }).catch(() => {});
    }

    // embudo: si el lead venía de la plantilla (nuevo/contactado) y ahora RESPONDE → 'respondio'
    if (lead && ['nuevo', 'contactado'].includes(lead.estado)) {
      await setEstado(phone, 'respondio').catch(() => {});
    }

    // fire-and-forget: sync contacto al CRM en paralelo (no bloquea; no-op si no hay CRM)
    if (displayName) upsertContact(phone, displayName).catch(() => {});

    // comando reset (testing)
    if (typeof userContent === 'string' && userContent.toLowerCase() === '/reset') {
      await clearHistory(phone);
      await sendMessage(conversationId, 'Conversación reiniciada.');
      return;
    }

    const history = await getHistory(phone);
    history.push({ role: 'user', content: userContent });

    let response;
    try {
      response = await callClaude(buildSystemPrompt(lead), history);
    } catch (err) {
      console.error('[claude] error:', err.message);
      await sendMessage(conversationId, 'Tuve un problema procesando tu mensaje. ¿Puedes repetirlo?');
      return;
    }

    await processResponse(phone, conversationId, lead, displayName, history, response);
  } catch (err) {
    console.error('[handleMessage] error inesperado:', err.message, err.stack);
    try {
      await sendMessage(conversationId, 'Tuve un problema técnico procesando tu mensaje. ¿Puedes intentar de nuevo?');
    } catch { /* si ni esto funciona, ya fue */ }
  }
}

// ─────────────────────────────────────────────────────────────
// extraccion de contenido del mensaje de Zernio (texto / adjuntos)
// ─────────────────────────────────────────────────────────────

async function extractContent(msg, conversationId) {
  // texto plano (incluye el caption si vino con un adjunto)
  if (msg.text && msg.text.trim()) return msg.text.trim();

  const att = (msg.attachments || [])[0];
  if (!att) return null;

  switch (att.type) {
    case 'audio': {
      // la URL del audio es un endpoint autenticado de Zernio; transcribeAudio baja con Bearer
      const transcript = await transcribeAudio(att.url);
      if (!transcript) {
        await sendMessage(conversationId, 'No pude entender el audio (puede ser muy largo). ¿Puedes resumirlo por texto?');
        return null;
      }
      return `[Audio transcrito]: ${transcript}`;
    }
    case 'image':
      return '[El usuario envió una imagen sin texto]';
    case 'video':
      return '[El usuario envió un video sin texto]';
    case 'file':
      return '[El usuario envió un documento]';
    default:
      return null;
  }
}

// ─────────────────────────────────────────────────────────────
// procesamiento de la respuesta de Claude (tool calls + texto)
// ─────────────────────────────────────────────────────────────

async function processResponse(phone, conversationId, lead, displayName, history, response, depth = 0) {
  const toolUses = response.content.filter(b => b.type === 'tool_use');

  // sin tools → respuesta de texto normal
  if (!toolUses.length) return sendText(phone, conversationId, history, response);

  // transfer_to_human corta la conversacion, no necesita follow-up
  const transfer = toolUses.find(b => b.name === 'transfer_to_human');
  if (transfer) {
    console.log(`[takeover] ${phone} — ${transfer.input?.reason}`);
    await setTakeover(phone, true);
    setHumanTag(phone, true).catch(() => {});
    const farewell = 'Un momento, te conecto con nuestro equipo ahora mismo. En breve te responden 👋';
    history.push({ role: 'assistant', content: farewell });
    await saveHistory(phone, history);
    await sendMessage(conversationId, farewell);
    return;
  }

  // ejecutar TODOS los tools del turno y juntar TODOS los tool_results.
  // Antes solo se devolvia el de get_available_slots: si el modelo llamaba
  // dos tools en el mismo turno, la API rechazaba el follow-up con 400.
  const results = [];
  let confirmMsg = null;

  for (const block of toolUses) {
    switch (block.name) {

      case 'save_lead_context': {
        const { name: n, niche, problem } = block.input;
        await saveLead({ phone, name: n || displayName, niche, problem, source: lead?.source || 'organic' });
        if (n && n !== displayName) upsertContact(phone, n).catch(() => {});
        // ya dio contexto (rubro+problema): deja de estar 'incompleto' → 'respondió'
        if (!lead || ['incompleto', 'nuevo', 'contactado'].includes(lead.estado)) {
          await setEstado(phone, 'respondio').catch(() => {});
        }
        results.push({ type: 'tool_result', tool_use_id: block.id, content: 'guardado' });
        break;
      }

      case 'check_availability': {
        const { startIso } = block.input;
        const check = await checkSlot(startIso);
        if (check.ok) {
          results.push({
            type: 'tool_result', tool_use_id: block.id,
            content: `DISPONIBLE. Pídele el email (si no lo tienes) y agenda con schedule_meeting usando este mismo startIso: ${startIso}`,
          });
        } else {
          let nearby = [];
          try { nearby = await nearbyFreeSlots(startIso, 3); } catch (err) { console.error('[calendar] nearby error:', err.message); }
          const near = nearby.length
            ? 'Horarios cercanos libres para ofrecer:\n' + nearby.map((s, i) => `${i + 1}. ${s.label} (iso: ${s.iso})`).join('\n')
            : 'No encontré horarios cercanos libres; pídele que te diga otro día.';
          results.push({
            type: 'tool_result', tool_use_id: block.id,
            content: `NO DISPONIBLE: ${check.error}\n${near}`,
          });
        }
        break;
      }

      case 'get_available_slots': {
        let slotText;
        try {
          const slots = await getAvailableSlots();
          slotText = slots.length
            ? slots.map((s, i) => `${i + 1}. ${s.label} (iso: ${s.iso})`).join('\n')
            : 'No hay horarios disponibles esta semana.';
        } catch (err) {
          console.error('[calendar] slots error:', err.message);
          slotText = 'Hubo un problema consultando los horarios. Intenta de nuevo en unos minutos.';
        }
        results.push({ type: 'tool_result', tool_use_id: block.id, content: slotText });
        break;
      }

      case 'schedule_meeting': {
        const { startIso, attendeeEmail, summary } = block.input;

        // Nada se agenda sin validar la fecha. El modelo construye ISOs a mano
        // y ya agendo una reunion 607 dias en el pasado.
        const check = await checkSlot(startIso);
        if (!check.ok) {
          console.warn(`[calendar] slot rechazado (${startIso}): ${check.error}`);
          results.push({
            type: 'tool_result', tool_use_id: block.id, is_error: true,
            content: `No se agendo: ${check.error}`,
          });
          break;
        }

        await saveLeadEmail(phone, attendeeEmail);
        const leadData = await getLead(phone);
        const description = [
          leadData?.company ? `Empresa: ${leadData.company}` : '',
          leadData?.niche   ? `Rubro: ${leadData.niche}`     : '',
          leadData?.problem ? `Necesidad: ${leadData.problem}` : '',
          leadData?.budget  ? `Presupuesto: ${leadData.budget}` : '',
        ].filter(Boolean).join('\n');

        try {
          const { meetLink, eventId } = await createMeeting({ summary, description, attendeeEmail, startIso });
          // embudo: reunión creada → estado 'agendado' + guarda fecha, link de Meet y el id del
          // evento (el link va en el recordatorio 1h antes; el event_id permite reagendar después)
          await setEstado(phone, 'agendado', startIso, meetLink, eventId).catch(() => {});
          confirmMsg = meetLink
            ? `✅ Reunión agendada. Guarda este link de Google Meet para conectarte:\n${meetLink}\n\nTe lo recordaré antes de la reunión.`
            : `✅ Reunión agendada. El equipo te enviará el link de Google Meet antes de la hora.`;
          results.push({ type: 'tool_result', tool_use_id: block.id, content: 'agendado' });
        } catch (err) {
          console.error('[calendar] schedule error:', err.message);
          results.push({
            type: 'tool_result', tool_use_id: block.id, is_error: true,
            content: `Google Calendar rechazo el evento: ${err.message}`,
          });
        }
        break;
      }

      case 'reschedule_meeting': {
        const { startIso } = block.input;
        const current = lead || await getLead(phone);
        if (!current?.event_id) {
          // Reunión sin evento registrado (agendada antes de guardar event_id). No se puede mover:
          // la tratamos como agendamiento nuevo y le avisamos a Maya que NO confirme un reagendo.
          console.warn(`[reschedule] ${phone} sin event_id — se trata como agendamiento nuevo`);
          results.push({
            type: 'tool_result', tool_use_id: block.id, is_error: true,
            content: 'Este prospecto NO tiene un evento de calendario registrado (reunión antigua o sin agendar). NO le digas que quedó reagendado. Trátalo como un agendamiento nuevo: confirma la hora que quiere y usa schedule_meeting (pídele el email si no lo tienes).',
          });
          break;
        }
        const check = await checkSlot(startIso);
        if (!check.ok) {
          let nearby = [];
          try { nearby = await nearbyFreeSlots(startIso, 3); } catch (e) { console.error('[calendar] nearby error:', e.message); }
          const near = nearby.length
            ? 'Horarios cercanos libres para ofrecer:\n' + nearby.map((s, i) => `${i + 1}. ${s.label} (iso: ${s.iso})`).join('\n')
            : 'Pídele que te diga otro horario.';
          results.push({
            type: 'tool_result', tool_use_id: block.id, is_error: true,
            content: `No se pudo mover (NO le confirmes al cliente): ${check.error}\n${near}`,
          });
          break;
        }
        try {
          const { meetLink } = await updateMeeting(current.event_id, startIso);
          // nueva hora → resetea el recordatorio para que se reenvíe 1h antes de la nueva reunión
          await setEstado(phone, 'agendado', startIso, meetLink).catch(e => console.error('[reschedule] setEstado:', e.message));
          const cuando = new Intl.DateTimeFormat('es-CL', {
            weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
            hour12: false, timeZone: 'America/La_Paz',
          }).format(new Date(startIso));
          // confirmación FIJA: solo se envía si updateMeeting tuvo éxito (evita confirmar un reagendo que falló)
          confirmMsg = `✅ Listo, moví tu reunión para el ${cuando} (hora Bolivia). Es el mismo link de Google Meet. Te espero.`;
          results.push({ type: 'tool_result', tool_use_id: block.id, content: 'reagendado' });
        } catch (err) {
          console.error('[calendar] reschedule error:', err.message);
          results.push({
            type: 'tool_result', tool_use_id: block.id, is_error: true,
            content: `No se pudo mover la reunión (NO le confirmes al cliente que quedó): ${err.message}. Discúlpate y pídele que proponga otra hora.`,
          });
        }
        break;
      }

      case 'cancel_meeting': {
        const current = lead || await getLead(phone);
        if (current?.event_id) {
          try { await cancelMeeting(current.event_id); }
          catch (err) { console.error('[calendar] cancel error:', err.message); }
        }
        await setEstado(phone, 'perdido').catch(() => {});
        results.push({ type: 'tool_result', tool_use_id: block.id, content: 'cancelado' });
        break;
      }
    }
  }

  // agendo bien → mensaje fijo de confirmacion, sin gastar otra llamada
  if (confirmMsg) {
    history.push({ role: 'assistant', content: confirmMsg });
    await saveHistory(phone, history);
    await sendMessage(conversationId, confirmMsg);
    return;
  }

  // solo guardados silenciosos y el modelo ya escribio texto → responder tal cual
  const soloSilenciosos = toolUses.every(b => b.name === 'save_lead_context');
  const texto = response.content.find(b => b.type === 'text')?.text;
  if (soloSilenciosos && texto) return sendText(phone, conversationId, history, response);

  // resto → devolver los tool_results y dejar que el modelo redacte
  return continueWithToolResults(phone, conversationId, lead, displayName, history, response.content, results, depth);
}

// envia el bloque de texto de una respuesta y lo guarda en el historial
async function sendText(phone, conversationId, history, response) {
  const reply = response.content.find(b => b.type === 'text')?.text;
  if (!reply) {
    console.warn(`[bot] turno sin texto (stop_reason: ${response.stop_reason}) — nada que enviar`);
    return;
  }
  history.push({ role: 'assistant', content: reply });
  await saveHistory(phone, history);
  await sendMessage(conversationId, reply);
}

const MAX_TOOL_DEPTH = 3;

// continua la conversacion devolviendo todos los tool_results del turno
async function continueWithToolResults(phone, conversationId, lead, displayName, history, prevContent, results, depth) {
  if (depth >= MAX_TOOL_DEPTH) {
    console.warn(`[bot] profundidad de tools agotada (${depth}) para ${phone}`);
    await sendMessage(conversationId, 'Se me complico procesar eso. ¿Lo intentamos de nuevo?');
    return;
  }

  history.push({ role: 'assistant', content: prevContent });
  history.push({ role: 'user', content: results });

  let followUp;
  try {
    followUp = await callClaude(buildSystemPrompt(lead), history);
  } catch (err) {
    console.error('[claude] follow-up error:', err.message);
    await sendMessage(conversationId, 'Tuve un problema procesando los horarios. ¿Puedes intentar de nuevo?');
    return;
  }

  return processResponse(phone, conversationId, lead, displayName, history, followUp, depth + 1);
}
