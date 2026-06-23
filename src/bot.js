import Anthropic from '@anthropic-ai/sdk';
import { getHistory, saveHistory, clearHistory, getLead, saveLead, saveLeadEmail, isTakeover, setTakeover } from './db.js';
import { getAvailableSlots, createMeeting } from './calendar.js';
import { sendWhatsApp, markReadWithTyping } from './ycloud.js';
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
    name: 'get_available_slots',
    description: 'Obtiene los próximos horarios disponibles para agendar una reunión. Úsala cuando el prospecto quiera agendar o preguntar cuándo pueden reunirse.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'schedule_meeting',
    description: `Agenda la reunión en Google Calendar y genera el link de Google Meet. Úsala cuando el prospecto haya elegido un horario y dado su email.

Acepta cualquier hora dentro del horario laboral (lunes a viernes, 9:00 a 18:00 hora Chile). Puedes:
- Usar el "iso" que devolvió get_available_slots (ideal cuando el usuario elige uno de los slots ofrecidos)
- Construir un ISO custom si el usuario propone otra hora razonable (ej: 12:30, 14:30) — siempre dentro del horario laboral y al menos 1 hora en el futuro.

Si el usuario propone un horario fuera del laboral, ofrécele alternativas. Si la hora está ocupada, el sistema te avisará.`,
    input_schema: {
      type: 'object',
      properties: {
        startIso:      { type: 'string', description: 'Fecha y hora de inicio en ISO 8601 con zona horaria de Chile, ej: "2026-05-27T12:30:00-04:00"' },
        attendeeEmail: { type: 'string', description: 'Email del prospecto' },
        summary:       { type: 'string', description: 'Título del evento (ej: "Reunión con Juan - Restaurante El Sol")' },
      },
      required: ['startIso', 'attendeeEmail', 'summary'],
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

function buildSystemPrompt(lead) {
  if (!lead) return BASE_PROMPT;

  const lines = [];
  if (lead.name)    lines.push(`- Nombre: ${lead.name}`);
  if (lead.company) lines.push(`- Empresa: ${lead.company}`);
  if (lead.niche)   lines.push(`- Rubro: ${lead.niche}`);
  if (lead.problem) lines.push(`- Problema principal: "${lead.problem}"`);
  if (lead.email)   lines.push(`- Email: ${lead.email}`);

  if (!lines.length) return BASE_PROMPT;

  const origin = lead.source === 'voice'
    ? 'Este usuario habló primero con Sofía en el agente de voz de la web. Ya sabes lo siguiente — NO repitas estas preguntas:'
    : 'Este usuario llegó con contexto previo. Ya sabes:';

  return BASE_PROMPT + `\n\n## Contexto del prospecto\n${origin}\n${lines.join('\n')}\nSalúdalo por su nombre desde el primer mensaje y adapta la conversación a su rubro y problema.`;
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

export async function handleMessage(event) {
  const msg = event.whatsappInboundMessage;
  if (!msg) return;

  const phone = msg.from;
  const wamid = msg.wamid || msg.id;

  // takeover activo → bot no interviene
  if (isTakeover(phone)) return;

  // fire-and-forget: marcar como leido + typing indicator inmediato (no bloquea)
  markReadWithTyping(wamid);

  // try/catch global: cualquier error inesperado → fallback al usuario en vez de dejarlo en el visto
  try {
    // extraer contenido segun tipo de mensaje
    const userContent = await extractContent(msg, phone);
    if (!userContent) return;

    const lead = getLead(phone);
    const displayName = lead?.name || msg.customerProfile?.name || null;

    // fire-and-forget: sync contacto a YCloud CRM en paralelo (no bloquea)
    if (displayName) upsertContact(phone, displayName).catch(() => {});

    // comando reset (testing)
    if (typeof userContent === 'string' && userContent.toLowerCase() === '/reset') {
      await clearHistory(phone);
      await sendWhatsApp(phone, 'Conversación reiniciada.');
      return;
    }

    const history = getHistory(phone);
    history.push({ role: 'user', content: userContent });

    let response;
    try {
      response = await callClaude(buildSystemPrompt(lead), history);
    } catch (err) {
      console.error('[claude] error:', err.message);
      await sendWhatsApp(phone, 'Tuve un problema procesando tu mensaje. ¿Puedes repetirlo?');
      return;
    }

    await processResponse(phone, lead, displayName, history, response);
  } catch (err) {
    console.error('[handleMessage] error inesperado:', err.message, err.stack);
    // ultimo recurso: avisar al usuario que algo se rompio
    try {
      await sendWhatsApp(phone, 'Tuve un problema técnico procesando tu mensaje. ¿Puedes intentar de nuevo?');
    } catch { /* si ni esto funciona, ya fue */ }
  }
}

// ─────────────────────────────────────────────────────────────
// extraccion de contenido por tipo de mensaje
// ─────────────────────────────────────────────────────────────

async function extractContent(msg, phone) {
  switch (msg.type) {
    case 'text':
      return msg.text?.body?.trim() || null;

    case 'audio': {
      const link = msg.audio?.link;
      if (!link) {
        console.warn('[audio] mensaje sin link de audio');
        await sendWhatsApp(phone, 'No pude descargar el audio. ¿Puedes escribirlo?');
        return null;
      }
      const transcript = await transcribeAudio(link);
      if (!transcript) {
        await sendWhatsApp(phone, 'No pude entender el audio (puede ser muy largo). ¿Puedes resumirlo por texto?');
        return null;
      }
      return `[Audio transcrito]: ${transcript}`;
    }

    case 'image':
      return msg.image?.caption?.trim() || '[El usuario envió una imagen sin texto]';

    case 'video':
      return msg.video?.caption?.trim() || '[El usuario envió un video sin texto]';

    case 'document':
      return `[El usuario envió un documento: ${msg.document?.filename || 'archivo'}]`;

    case 'location':
      return `[El usuario compartió su ubicación: lat ${msg.location?.latitude}, lng ${msg.location?.longitude}]`;

    case 'sticker':
    case 'reaction':
      return null;

    default:
      return null;
  }
}

// ─────────────────────────────────────────────────────────────
// procesamiento de la respuesta de Claude (tool calls + texto)
// ─────────────────────────────────────────────────────────────

async function processResponse(phone, lead, displayName, history, response) {
  for (const block of response.content) {
    if (block.type !== 'tool_use') continue;

    switch (block.name) {

      case 'save_lead_context': {
        const { name: n, niche, problem } = block.input;
        saveLead({ phone, name: n || displayName, niche, problem, source: 'organic' });
        if (n && n !== displayName) upsertContact(phone, n).catch(() => {});
        break; // continua para que Claude responda en el mismo turno
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

        return continueWithToolResult(phone, lead, history, response.content, block.id, slotText);
      }

      case 'schedule_meeting': {
        const { startIso, attendeeEmail, summary } = block.input;
        saveLeadEmail(phone, attendeeEmail);

        const leadData = getLead(phone);
        const description = [
          leadData?.company ? `Empresa: ${leadData.company}` : '',
          leadData?.niche   ? `Rubro: ${leadData.niche}`     : '',
          leadData?.problem ? `Necesidad: ${leadData.problem}` : '',
          leadData?.budget  ? `Presupuesto: ${leadData.budget}` : '',
        ].filter(Boolean).join('\n');

        let confirmMsg;
        try {
          const { meetLink } = await createMeeting({ summary, description, attendeeEmail, startIso });
          confirmMsg = meetLink
            ? `✅ Reunión agendada. Guarda este link de Google Meet para conectarte:\n${meetLink}\n\nTe lo recordaré antes de la reunión.`
            : `✅ Reunión agendada. El equipo te enviará el link de Google Meet antes de la hora.`;
        } catch (err) {
          console.error('[calendar] schedule error:', err.message);
          confirmMsg = 'No pude completar el agendamiento. ¿Quieres que te conecte con el equipo para coordinarlo?';
        }

        history.push({ role: 'assistant', content: confirmMsg });
        saveHistory(phone, history);
        await sendWhatsApp(phone, confirmMsg);
        return;
      }

      case 'transfer_to_human': {
        console.log(`[takeover] ${phone} — ${block.input?.reason}`);
        setTakeover(phone, true);
        setHumanTag(phone, true).catch(() => {});
        const farewell = 'Un momento, te conecto con nuestro equipo ahora mismo. En breve te responden 👋';
        history.push({ role: 'assistant', content: farewell });
        saveHistory(phone, history);
        await sendWhatsApp(phone, farewell);
        return;
      }
    }
  }

  // respuesta normal de texto
  const reply = response.content.find(b => b.type === 'text')?.text;
  if (!reply) return;

  history.push({ role: 'assistant', content: reply });
  saveHistory(phone, history);
  await sendWhatsApp(phone, reply);
}

// helper: continua la conversacion despues de un tool call con su resultado
async function continueWithToolResult(phone, lead, history, prevContent, toolUseId, toolResult) {
  history.push({ role: 'assistant', content: prevContent });
  history.push({
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: toolUseId, content: toolResult }],
  });

  let followUp;
  try {
    followUp = await callClaude(buildSystemPrompt(lead), history);
  } catch (err) {
    console.error('[claude] follow-up error:', err.message);
    await sendWhatsApp(phone, 'Tuve un problema procesando los horarios. ¿Puedes intentar de nuevo?');
    return;
  }

  await processResponse(phone, lead, lead?.name, history, followUp);
}
