import { google } from 'googleapis';

// CALENDAR_ID: para OAuth se puede usar 'primary' (calendar default del usuario que autorizo)
// o un calendar especifico al que tenga acceso. Para service account es el calendar compartido.
const CALENDAR_ID       = process.env.GOOGLE_CALENDAR_ID || 'primary';
const MEET_DURATION_MIN = 30;
const TIMEZONE          = 'America/La_Paz';
const WORK_START_HOUR   = 9;   // inclusive
const WORK_END_HOUR     = 18;  // exclusive (ultimo slot empieza 17:00)
const MAX_SLOTS         = 12;  // total de horarios a devolver (repartidos en varios dias)
const MAX_PER_DAY       = 3;   // pocos por dia -> los cupos se reparten en ~4-5 dias, alcanza la proxima semana

// USE_OAUTH: si tenemos refresh token, usamos OAuth (permite Meet auto + attendees con email invite).
// Sin OAuth, usamos service account (limitado: no attendees, no Meet auto → cae a STATIC_MEET_LINK).
const USE_OAUTH = !!process.env.GOOGLE_OAUTH_REFRESH_TOKEN;

function loadCreds() {
  // opcion 1 (recomendada): JSON en base64 — evita problemas de escapeo de \n en EasyPanel
  if (process.env.GOOGLE_SERVICE_ACCOUNT_B64) {
    const decoded = Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_B64, 'base64').toString('utf-8');
    return JSON.parse(decoded);
  }
  // opcion 2: JSON crudo
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  }
  // opcion 3: variables separadas (legacy)
  return {
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    private_key:  process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  };
}

function getAuth() {
  if (USE_OAUTH) {
    const oauth2 = new google.auth.OAuth2(
      process.env.GOOGLE_OAUTH_CLIENT_ID,
      process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    );
    oauth2.setCredentials({ refresh_token: process.env.GOOGLE_OAUTH_REFRESH_TOKEN });
    return oauth2;
  }
  const creds = loadCreds();
  return new google.auth.JWT({
    email:  creds.client_email,
    key:    creds.private_key,
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
}

// devuelve el offset en horas para una fecha dada en una timezone (ej: -3 para Bolivia en verano)
function getTimezoneOffsetHours(date, tz) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: 'numeric', hour12: false,
  });
  const tzHour  = parseInt(formatter.format(date), 10);
  const utcHour = date.getUTCHours();
  let diff = tzHour - utcHour;
  if (diff > 12)  diff -= 24;
  if (diff < -12) diff += 24;
  return diff;
}

// devuelve la "fecha local Bolivia" (anio, mes, dia, hora) para un Date dado
function toBoliviaParts(date) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map(p => [p.type, p.value]));
  return {
    year:   +parts.year,
    month:  +parts.month,
    day:    +parts.day,
    hour:   +parts.hour,
    minute: +parts.minute,
    weekday: new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00Z`).getUTCDay(),
  };
}

// construye un Date UTC que representa la hora "Y-M-D H:M" en zona Bolivia
function chileToUtc(year, month, day, hour, minute = 0) {
  // armar fecha "naive" y luego corregir por el offset de Bolivia en esa fecha
  const naive = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const offset = getTimezoneOffsetHours(naive, TIMEZONE);
  return new Date(naive.getTime() - offset * 3600_000);
}

// elige hasta n elementos repartidos uniformemente (primero, ...medio..., último)
// para que las opciones incluyan mañana Y tarde, no solo las primeras horas.
function pickSpread(arr, n) {
  if (arr.length <= n) return arr;
  const picked = [];
  for (let i = 0; i < n; i++) {
    picked.push(arr[Math.round((i * (arr.length - 1)) / (n - 1))]);
  }
  return [...new Set(picked)];
}

export async function getAvailableSlots() {
  const auth     = getAuth();
  const calendar = google.calendar({ version: 'v3', auth });

  const now = new Date();
  const end = new Date(now);
  end.setDate(end.getDate() + 14); // ventana de busqueda: 14 dias (2 semanas)

  const { data } = await calendar.freebusy.query({
    requestBody: {
      timeMin: now.toISOString(),
      timeMax: end.toISOString(),
      items: [{ id: CALENDAR_ID }],
    },
  });

  const busy = (data.calendars?.[CALENDAR_ID]?.busy || []).map(b => ({
    start: new Date(b.start), end: new Date(b.end),
  }));

  const slots = [];

  // iterar dia por dia en hora Bolivia
  let cursor = new Date(now);
  for (let d = 0; d < 14 && slots.length < MAX_SLOTS; d++) {
    const chile = toBoliviaParts(cursor);

    // saltar fines de semana
    if (chile.weekday >= 1 && chile.weekday <= 5) {
      // recolectar TODAS las horas libres del dia (9 a 17)
      const freeHours = [];
      for (let h = WORK_START_HOUR; h < WORK_END_HOUR; h++) {
        const slotStart = chileToUtc(chile.year, chile.month, chile.day, h, 0);
        const slotEnd   = new Date(slotStart.getTime() + MEET_DURATION_MIN * 60_000);

        // solo slots futuros (al menos 1h desde ahora)
        if (slotStart < new Date(now.getTime() + 60 * 60_000)) continue;

        const overlap = busy.some(b => b.start < slotEnd && b.end > slotStart);
        if (overlap) continue;

        freeHours.push(slotStart);
      }

      // elegir hasta MAX_PER_DAY repartidos en el dia (mañana / mediodia / tarde)
      for (const s of pickSpread(freeHours, MAX_PER_DAY)) {
        if (slots.length >= MAX_SLOTS) break;
        slots.push(s);
      }
    }

    cursor = new Date(cursor.getTime() + 24 * 3600_000);
  }

  return slots.map(s => ({
    iso:   s.toISOString(),
    label: s.toLocaleString('es-CL', {
      weekday: 'long', day: 'numeric', month: 'long',
      hour: '2-digit', minute: '2-digit', timeZone: TIMEZONE,
    }),
  }));
}

// devuelve hasta n horarios libres CERCANOS a la fecha/hora pedida (mismo dia, ordenados por
// cercania a la hora pedida; si ese dia no tiene cupos, salta al proximo dia habil con cupos).
export async function nearbyFreeSlots(startIso, n = 3) {
  const norm   = normalizeIso(startIso);
  const target = norm.ok ? norm.date : new Date(startIso);
  if (isNaN(target.getTime())) return [];

  const auth     = getAuth();
  const calendar = google.calendar({ version: 'v3', auth });
  const now      = new Date();

  async function freeForDay(baseDate) {
    const chile = toBoliviaParts(baseDate);
    if (chile.weekday < 1 || chile.weekday > 5) return []; // fin de semana
    const dayStart = chileToUtc(chile.year, chile.month, chile.day, WORK_START_HOUR, 0);
    const dayEnd   = chileToUtc(chile.year, chile.month, chile.day, WORK_END_HOUR, 0);
    let busy = [];
    try {
      const { data } = await calendar.freebusy.query({
        requestBody: { timeMin: dayStart.toISOString(), timeMax: dayEnd.toISOString(), items: [{ id: CALENDAR_ID }] },
      });
      busy = (data.calendars?.[CALENDAR_ID]?.busy || []).map(b => ({ start: new Date(b.start), end: new Date(b.end) }));
    } catch (err) {
      console.warn('[calendar] nearbyFreeSlots freebusy fallo:', err.message);
    }
    const free = [];
    for (let h = WORK_START_HOUR; h < WORK_END_HOUR; h++) {
      const s = chileToUtc(chile.year, chile.month, chile.day, h, 0);
      const e = new Date(s.getTime() + MEET_DURATION_MIN * 60_000);
      if (s < new Date(now.getTime() + 60 * 60_000)) continue;
      if (busy.some(b => b.start < e && b.end > s)) continue;
      free.push(s);
    }
    return free;
  }

  const targetHour = toBoliviaParts(target).hour;
  let free = await freeForDay(target);
  free.sort((a, b) => Math.abs(toBoliviaParts(a).hour - targetHour) - Math.abs(toBoliviaParts(b).hour - targetHour));

  // si el dia pedido no tiene cupos, buscar el proximo dia habil con disponibilidad
  let probe = new Date(target), guard = 0;
  while (free.length === 0 && guard < 14) {
    probe = new Date(probe.getTime() + 24 * 3600_000);
    free = await freeForDay(probe);
    guard++;
  }

  return free.slice(0, n).map(s => ({
    iso:   s.toISOString(),
    label: s.toLocaleString('es-CL', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: TIMEZONE }),
  }));
}

// ─────────────────────────────────────────────────────────────
// validacion de slot — el modelo construye ISOs a mano y puede
// equivocarse de año/mes, asi que nada se agenda sin pasar por aca
// ─────────────────────────────────────────────────────────────

// texto legible de "ahora" en Bolivia, para devolverle contexto al modelo
export function nowInBolivia() {
  return new Intl.DateTimeFormat('es-CL', {
    timeZone: TIMEZONE, weekday: 'long', day: 'numeric', month: 'long',
    year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date());
}

const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

// El modelo suele mandar el ISO sin offset ("2026-09-09T10:00:00"). Node lo
// interpretaria como hora local del proceso, y el contenedor corre en UTC:
// 10:00 se volveria 07:00 en Bolivia. Si falta el offset, lo asumimos Bolivia.
const ISO_SHAPE  = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/;
const HAS_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/;

export function normalizeIso(startIso) {
  const raw = String(startIso || '').trim();
  const m = raw.match(ISO_SHAPE);
  if (!m) return { ok: false };
  if (HAS_OFFSET.test(raw)) return { ok: true, date: new Date(raw), assumedBolivia: false };

  const [, y, mo, d, h, mi] = m.map(Number);
  return { ok: true, date: chileToUtc(y, mo, d, h, mi), assumedBolivia: true };
}

// valida fecha + horario laboral + disponibilidad real.
// devuelve { ok: true } o { ok: false, error: '<mensaje para el modelo>' }
export async function checkSlot(startIso) {
  const norm = normalizeIso(startIso);
  if (!norm.ok || isNaN(norm.date.getTime())) {
    return { ok: false, error: `"${startIso}" no es una fecha ISO 8601 valida. Usa get_available_slots y toma el campo "iso" tal cual.` };
  }
  const start = norm.date;
  if (norm.assumedBolivia) {
    console.log(`[calendar] ISO sin offset ("${startIso}") — interpretado como hora Bolivia: ${start.toISOString()}`);
  }

  const now = Date.now();
  const MIN_LEAD_MS = 60 * 60_000; // 1 hora

  if (start.getTime() < now) {
    return { ok: false, error: `esa fecha ya paso (${start.toISOString()}). Ahora en Bolivia es ${nowInBolivia()}. Revisa el AÑO y el MES: no inventes la fecha, llama get_available_slots y usa el campo "iso" que devuelve.` };
  }
  if (start.getTime() < now + MIN_LEAD_MS) {
    return { ok: false, error: `esa hora es en menos de 1 hora. Ahora en Bolivia es ${nowInBolivia()}. Ofrece un horario mas adelante.` };
  }

  const p = toBoliviaParts(start);
  if (p.weekday < 1 || p.weekday > 5) {
    return { ok: false, error: `esa fecha cae ${DIAS[p.weekday]} y solo se atiende de lunes a viernes. Ofrecele un dia habil.` };
  }
  if (p.hour < WORK_START_HOUR || p.hour >= WORK_END_HOUR) {
    return { ok: false, error: `las ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')} esta fuera del horario laboral (${WORK_START_HOUR}:00 a ${WORK_END_HOUR}:00 hora Bolivia). Ofrecele una hora dentro del rango.` };
  }

  // choque con algo ya agendado
  try {
    const auth     = getAuth();
    const calendar = google.calendar({ version: 'v3', auth });
    const end      = new Date(start.getTime() + MEET_DURATION_MIN * 60_000);
    const { data } = await calendar.freebusy.query({
      requestBody: {
        timeMin: start.toISOString(), timeMax: end.toISOString(),
        items: [{ id: CALENDAR_ID }],
      },
    });
    const busy = data.calendars?.[CALENDAR_ID]?.busy || [];
    if (busy.length) {
      return { ok: false, error: `esa hora ya esta ocupada. Llama get_available_slots y ofrecele uno de los horarios libres.` };
    }
  } catch (err) {
    // si freebusy falla no bloqueamos el agendamiento, solo lo dejamos anotado
    console.warn('[calendar] checkSlot freebusy fallo, se agenda sin verificar choque:', err.message);
  }

  return { ok: true };
}

function extractMeetLink(eventData) {
  return eventData?.hangoutLink
    || eventData?.conferenceData?.entryPoints?.find(e => e.entryPointType === 'video')?.uri
    || null;
}

export async function createMeeting({ summary, description, attendeeEmail, startIso }) {
  const auth     = getAuth();
  const calendar = google.calendar({ version: 'v3', auth });

  const norm  = normalizeIso(startIso);
  const start = norm.ok ? norm.date : new Date(startIso);
  const end   = new Date(start.getTime() + MEET_DURATION_MIN * 60_000);

  const baseBody = {
    summary,
    description: description || '',
    start: { dateTime: start.toISOString(), timeZone: TIMEZONE },
    end:   { dateTime: end.toISOString(),   timeZone: TIMEZONE },
  };

  let data;

  if (USE_OAUTH) {
    // OAuth: full features — Meet auto + attendees con email invite
    const res = await calendar.events.insert({
      calendarId:            CALENDAR_ID,
      conferenceDataVersion: 1,
      sendUpdates:           'all',
      requestBody: {
        ...baseBody,
        attendees: attendeeEmail ? [{ email: attendeeEmail }] : [],
        conferenceData: {
          createRequest: {
            requestId:             `jqs-${Date.now()}`,
            conferenceSolutionKey: { type: 'hangoutsMeet' },
          },
        },
      },
    });
    data = res.data;
  } else {
    // service account: sin attendees (DWD requerido), conferenceData con fallback sin él si falla
    const fullDescription = [
      attendeeEmail ? `Email del prospecto: ${attendeeEmail}` : '',
      baseBody.description,
    ].filter(Boolean).join('\n\n');
    const saBody = { ...baseBody, description: fullDescription };

    try {
      const res = await calendar.events.insert({
        calendarId:            CALENDAR_ID,
        conferenceDataVersion: 1,
        requestBody: {
          ...saBody,
          conferenceData: {
            createRequest: {
              requestId:             `jqs-${Date.now()}`,
              conferenceSolutionKey: { type: 'hangoutsMeet' },
            },
          },
        },
      });
      data = res.data;
    } catch (err) {
      console.warn('[calendar] conferenceData rejected, retrying without it:', err.message);
      const res = await calendar.events.insert({
        calendarId:  CALENDAR_ID,
        requestBody: saBody,
      });
      data = res.data;
    }
  }

  let meetLink = extractMeetLink(data);

  // a veces Google genera el Meet link async — refetch despues de un momento
  if (!meetLink && data.id) {
    await new Promise(r => setTimeout(r, 1500));
    try {
      const { data: refetched } = await calendar.events.get({
        calendarId: CALENDAR_ID,
        eventId:    data.id,
      });
      meetLink = extractMeetLink(refetched);
    } catch (err) {
      console.error('[calendar] refetch error:', err.message);
    }
  }

  // fallback final: link estatico (para casos donde la service account no puede generar Meet)
  if (!meetLink && process.env.STATIC_MEET_LINK) {
    meetLink = process.env.STATIC_MEET_LINK;
  }

  return { eventId: data.id, meetLink, htmlLink: data.htmlLink };
}

// Mueve un evento existente a una nueva hora. Mantiene el mismo link de Meet y los
// asistentes (solo cambia start/end). Con OAuth, Google avisa al asistente del cambio.
export async function updateMeeting(eventId, startIso) {
  const auth     = getAuth();
  const calendar = google.calendar({ version: 'v3', auth });

  const norm  = normalizeIso(startIso);
  const start = norm.ok ? norm.date : new Date(startIso);
  const end   = new Date(start.getTime() + MEET_DURATION_MIN * 60_000);

  const res = await calendar.events.patch({
    calendarId:  CALENDAR_ID,
    eventId,
    sendUpdates: USE_OAUTH ? 'all' : 'none',
    requestBody: {
      start: { dateTime: start.toISOString(), timeZone: TIMEZONE },
      end:   { dateTime: end.toISOString(),   timeZone: TIMEZONE },
    },
  });
  const data = res.data;
  const meetLink = extractMeetLink(data) || process.env.STATIC_MEET_LINK || null;
  return { eventId: data.id, meetLink, htmlLink: data.htmlLink };
}

// Elimina el evento del calendario (libera el horario). Con OAuth avisa al asistente.
export async function cancelMeeting(eventId) {
  const auth     = getAuth();
  const calendar = google.calendar({ version: 'v3', auth });
  await calendar.events.delete({
    calendarId:  CALENDAR_ID,
    eventId,
    sendUpdates: USE_OAUTH ? 'all' : 'none',
  });
}
