import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';

mkdirSync('./data', { recursive: true });
const db = new Database('./data/conversations.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS leads (
    phone          TEXT PRIMARY KEY,
    name           TEXT,
    company        TEXT,
    niche          TEXT,
    problem        TEXT,
    budget         TEXT,
    email          TEXT,
    source         TEXT NOT NULL DEFAULT 'organic',
    human_takeover INTEGER NOT NULL DEFAULT 0,
    registered     INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS conversations (
    phone    TEXT PRIMARY KEY,
    history  TEXT NOT NULL DEFAULT '[]',
    updated  INTEGER NOT NULL DEFAULT (unixepoch())
  );
`);

const MAX_MESSAGES = 30;

// ── utils ──────────────────────────────────────────────────

export function normalizePhone(raw) {
  const digits = String(raw).replace(/\D/g, '');
  return digits ? `+${digits}` : null;
}

// ── leads ──────────────────────────────────────────────────

export function saveLead({ phone, name, company, niche, problem, budget, email, source = 'organic' }) {
  db.prepare(`
    INSERT INTO leads (phone, name, company, niche, problem, budget, email, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(phone) DO UPDATE SET
      name     = COALESCE(excluded.name, name),
      company  = COALESCE(excluded.company, company),
      niche    = COALESCE(excluded.niche, niche),
      problem  = COALESCE(excluded.problem, problem),
      budget   = COALESCE(excluded.budget, budget),
      email    = COALESCE(excluded.email, email),
      source   = excluded.source,
      registered = unixepoch()
  `).run(phone, name||null, company||null, niche||null, problem||null, budget||null, email||null, source);
}

export function saveLeadEmail(phone, email) {
  db.prepare(`
    INSERT INTO leads (phone, email)
    VALUES (?, ?)
    ON CONFLICT(phone) DO UPDATE SET email = excluded.email
  `).run(phone, email);
}

export function getLead(phone) {
  return db.prepare('SELECT * FROM leads WHERE phone = ?').get(phone) || null;
}

// ── human takeover ─────────────────────────────────────────

export function setTakeover(phone, active) {
  // si el lead no existe aun, crearlo con solo el flag
  db.prepare(`
    INSERT INTO leads (phone, human_takeover)
    VALUES (?, ?)
    ON CONFLICT(phone) DO UPDATE SET human_takeover = excluded.human_takeover
  `).run(phone, active ? 1 : 0);
}

export function isTakeover(phone) {
  const row = db.prepare('SELECT human_takeover FROM leads WHERE phone = ?').get(phone);
  return row?.human_takeover === 1;
}

// ── conversaciones ─────────────────────────────────────────

export function getHistory(phone) {
  const row = db.prepare('SELECT history FROM conversations WHERE phone = ?').get(phone);
  return row ? JSON.parse(row.history) : [];
}

export function saveHistory(phone, history) {
  const trimmed = history.slice(-MAX_MESSAGES);
  db.prepare(`
    INSERT INTO conversations (phone, history, updated)
    VALUES (?, ?, unixepoch())
    ON CONFLICT(phone) DO UPDATE SET history = excluded.history, updated = excluded.updated
  `).run(phone, JSON.stringify(trimmed));
}

export function clearHistory(phone) {
  db.prepare('DELETE FROM conversations WHERE phone = ?').run(phone);
}
