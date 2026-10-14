// Capa de datos en Postgres. Comparte la BD con el panel de métricas (aurun-dashboard).
// Esquema unificado: columnas en español (nombre/negocio/rubro/desafio) + estado del embudo.
// getLead devuelve alias en inglés (name/company/niche/problem) para no tocar la lógica del bot.
import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
});

const MAX_MESSAGES = 30;

// ── esquema (idempotente) ──────────────────────────────────
export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS leads (
      id          BIGSERIAL PRIMARY KEY,
      phone       TEXT UNIQUE NOT NULL,
      nombre      TEXT,
      negocio     TEXT,
      rubro       TEXT,
      desafio     TEXT,
      email       TEXT,
      source      TEXT NOT NULL DEFAULT 'web',
      estado      TEXT NOT NULL DEFAULT 'nuevo',
      fbp         TEXT,
      fbc         TEXT,
      meeting_at  TIMESTAMPTZ,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS human_takeover BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS meet_link TEXT;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS recordatorio_enviado_at TIMESTAMPTZ;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS event_id TEXT;
    CREATE TABLE IF NOT EXISTS conversations (
      phone   TEXT PRIMARY KEY,
      history JSONB NOT NULL DEFAULT '[]',
      updated TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS lead_events (
      id     BIGSERIAL PRIMARY KEY,
      phone  TEXT NOT NULL,
      estado TEXT NOT NULL,
      at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

// ── utils ──────────────────────────────────────────────────
export function normalizePhone(raw) {
  const digits = String(raw).replace(/\D/g, '');
  return digits ? `+${digits}` : null;
}

// ── leads ──────────────────────────────────────────────────
// Acepta los nombres internos del bot (name/company/niche/problem) y los mapea a las columnas.
export async function saveLead({ phone, name, company, niche, problem, email, source = 'web', estado, fbp, fbc }) {
  await pool.query(
    `INSERT INTO leads (phone, nombre, negocio, rubro, desafio, email, source, estado, fbp, fbc)
     VALUES ($1,$2,$3,$4,$5,$6,$7, COALESCE($8,'nuevo'), $9,$10)
     ON CONFLICT (phone) DO UPDATE SET
       nombre  = COALESCE(EXCLUDED.nombre,  leads.nombre),
       negocio = COALESCE(EXCLUDED.negocio, leads.negocio),
       rubro   = COALESCE(EXCLUDED.rubro,   leads.rubro),
       desafio = COALESCE(EXCLUDED.desafio, leads.desafio),
       email   = COALESCE(EXCLUDED.email,   leads.email),
       source  = EXCLUDED.source,
       fbp     = COALESCE(EXCLUDED.fbp, leads.fbp),
       fbc     = COALESCE(EXCLUDED.fbc, leads.fbc),
       updated_at = now()`,
    [phone, name||null, company||null, niche||null, problem||null, email||null, source, estado||null, fbp||null, fbc||null]
  );
}

export async function saveLeadEmail(phone, email) {
  await pool.query(
    `INSERT INTO leads (phone, email) VALUES ($1,$2)
     ON CONFLICT (phone) DO UPDATE SET email = EXCLUDED.email, updated_at = now()`,
    [phone, email]
  );
}

export async function getLead(phone) {
  const { rows } = await pool.query(
    `SELECT phone,
            nombre  AS name,
            negocio AS company,
            rubro   AS niche,
            desafio AS problem,
            email, source, estado, meeting_at, meet_link, event_id, human_takeover
       FROM leads WHERE phone = $1`,
    [phone]
  );
  return rows[0] || null;
}

// ── estado del embudo ──────────────────────────────────────
// nuevo → contactado → respondio → agendado → cerrado | perdido | no_show
export async function setEstado(phone, estado, meetingAt = null, meetLink = null, eventId = null) {
  await pool.query(
    `INSERT INTO leads (phone, estado) VALUES ($1,$2)
     ON CONFLICT (phone) DO UPDATE SET
       estado = $2,
       updated_at = now(),
       meeting_at = COALESCE($3::timestamptz, leads.meeting_at),
       meet_link  = COALESCE($4, leads.meet_link),
       event_id   = COALESCE($5, leads.event_id),
       recordatorio_enviado_at = CASE WHEN $3 IS NOT NULL THEN NULL ELSE leads.recordatorio_enviado_at END`,
    [phone, estado, meetingAt, meetLink, eventId]
  );
  await pool.query(`INSERT INTO lead_events (phone, estado) VALUES ($1,$2)`, [phone, estado]);
}

// Marca 'contactado' SOLO si el lead está en 'nuevo' (atómico). Devuelve true si este
// request fue el que lo cambió → úsalo para enviar la plantilla una sola vez (evita doble envío).
export async function markContactadoIfNuevo(phone) {
  const { rowCount } = await pool.query(
    `UPDATE leads SET estado='contactado', updated_at=now() WHERE phone=$1 AND estado='nuevo'`,
    [phone]
  );
  if (rowCount) {
    await pool.query(`INSERT INTO lead_events (phone, estado) VALUES ($1,'contactado')`, [phone]);
  }
  return rowCount > 0;
}

// ── human takeover ─────────────────────────────────────────
export async function setTakeover(phone, active) {
  await pool.query(
    `INSERT INTO leads (phone, human_takeover) VALUES ($1,$2)
     ON CONFLICT (phone) DO UPDATE SET human_takeover = EXCLUDED.human_takeover, updated_at = now()`,
    [phone, !!active]
  );
}

export async function isTakeover(phone) {
  const { rows } = await pool.query('SELECT human_takeover FROM leads WHERE phone = $1', [phone]);
  return rows[0]?.human_takeover === true;
}

// ── conversaciones ─────────────────────────────────────────
export async function getHistory(phone) {
  const { rows } = await pool.query('SELECT history FROM conversations WHERE phone = $1', [phone]);
  return rows[0] ? rows[0].history : [];
}

export async function saveHistory(phone, history) {
  const trimmed = history.slice(-MAX_MESSAGES);
  await pool.query(
    `INSERT INTO conversations (phone, history, updated) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (phone) DO UPDATE SET history = EXCLUDED.history, updated = now()`,
    [phone, JSON.stringify(trimmed)]
  );
}

export async function clearHistory(phone) {
  await pool.query('DELETE FROM conversations WHERE phone = $1', [phone]);
}
