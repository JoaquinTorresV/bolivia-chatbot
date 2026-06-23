import { google } from 'googleapis';

// CALENDAR_ID: para OAuth se puede usar 'primary' (calendar default del usuario que autorizo)
// o un calendar especifico al que tenga acceso. Para service account es el calendar compartido.
const CALENDAR_ID       = process.env.GOOGLE_CALENDAR_ID || 'primary';
const MEET_DURATION_MIN = 30;
const TIMEZONE          = 'America/Santiago';
const WORK_START_HOUR   = 9;   // inclusive
const WORK_END_HOUR     = 18;  // exclusive (ultimo slot empieza 17:00)
const MAX_SLOTS         = 10;  // suficiente para mostrar opciones reales del dia
const MAX_PER_DAY       = 8;   // permite mostrar todo el dia si esta libre

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

// devuelve el offset en horas para una fecha dada en una timezone (ej: -3 para Chile en verano)
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

// devuelve la "fecha local Chile" (anio, mes, dia, hora) para un Date dado
function toChileParts(date) {
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

// construye un Date UTC que representa la hora "Y-M-D H:M" en zona Chile
function chileToUtc(year, month, day, hour, minute = 0) {
  // armar fecha "naive" y luego corregir por el offset de Chile en esa fecha
  const naive = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const offset = getTimezoneOffsetHours(naive, TIMEZONE);
  return new Date(naive.getTime() - offset * 3600_000);
}

export async function getAvailableSlots() {
  const auth     = getAuth();
  const calendar = google.calendar({ version: 'v3', auth });

  const now = new Date();
  const end = new Date(now);
  end.setDate(end.getDate() + 10); // ventana de busqueda: 10 dias

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
  const perDay = {};

  // iterar dia por dia en hora Chile
  let cursor = new Date(now);
  for (let d = 0; d < 10 && slots.length < MAX_SLOTS; d++) {
    const chile = toChileParts(cursor);
    const dayKey = `${chile.year}-${chile.month}-${chile.day}`;

    // saltar fines de semana
    if (chile.weekday >= 1 && chile.weekday <= 5) {
      for (let h = WORK_START_HOUR; h < WORK_END_HOUR; h++) {
        if (slots.length >= MAX_SLOTS) break;
        if ((perDay[dayKey] || 0) >= MAX_PER_DAY) break;

        const slotStart = chileToUtc(chile.year, chile.month, chile.day, h, 0);
        const slotEnd   = new Date(slotStart.getTime() + MEET_DURATION_MIN * 60_000);

        // solo slots futuros (al menos 1h desde ahora)
        if (slotStart < new Date(now.getTime() + 60 * 60_000)) continue;

        const overlap = busy.some(b => b.start < slotEnd && b.end > slotStart);
        if (overlap) continue;

        slots.push(slotStart);
        perDay[dayKey] = (perDay[dayKey] || 0) + 1;
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

function extractMeetLink(eventData) {
  return eventData?.hangoutLink
    || eventData?.conferenceData?.entryPoints?.find(e => e.entryPointType === 'video')?.uri
    || null;
}

export async function createMeeting({ summary, description, attendeeEmail, startIso }) {
  const auth     = getAuth();
  const calendar = google.calendar({ version: 'v3', auth });

  const start = new Date(startIso);
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
