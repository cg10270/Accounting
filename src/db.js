import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

export const db = new DatabaseSync(config.dbFile);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
-- Buchhaltungsperiode (in der Regel ein Monat)
CREATE TABLE IF NOT EXISTS periods (
  id         INTEGER PRIMARY KEY,
  year       INTEGER NOT NULL,
  month      INTEGER NOT NULL,
  label      TEXT    NOT NULL,
  status     TEXT    NOT NULL DEFAULT 'offen',   -- offen | in_arbeit | abgeschlossen
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (year, month)
);

-- Wiederverwendbare Aufgabenvorlage; wird pro Periode instanziiert
CREATE TABLE IF NOT EXISTS task_templates (
  id          INTEGER PRIMARY KEY,
  position    INTEGER NOT NULL DEFAULT 0,
  title       TEXT    NOT NULL,
  description TEXT    NOT NULL DEFAULT '',
  prompt      TEXT    NOT NULL DEFAULT '',
  category    TEXT    NOT NULL DEFAULT 'allgemein',
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Konkrete Aufgabe innerhalb einer Periode
CREATE TABLE IF NOT EXISTS tasks (
  id          INTEGER PRIMARY KEY,
  period_id   INTEGER NOT NULL REFERENCES periods(id) ON DELETE CASCADE,
  template_id INTEGER REFERENCES task_templates(id) ON DELETE SET NULL,
  position    INTEGER NOT NULL DEFAULT 0,
  title       TEXT    NOT NULL,
  description TEXT    NOT NULL DEFAULT '',
  prompt      TEXT    NOT NULL DEFAULT '',
  category    TEXT    NOT NULL DEFAULT 'allgemein',
  status      TEXT    NOT NULL DEFAULT 'offen',  -- offen | in_arbeit | wartet | erledigt
  done_at     TEXT,
  done_by     TEXT,
  notes       TEXT    NOT NULL DEFAULT '',
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tasks_period ON tasks(period_id);

-- Zugangsdaten je Aufgabe; secret_enc ist AES-256-GCM-verschluesselt
CREATE TABLE IF NOT EXISTS credentials (
  id         INTEGER PRIMARY KEY,
  task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  label      TEXT    NOT NULL,
  url        TEXT    NOT NULL DEFAULT '',
  username   TEXT    NOT NULL DEFAULT '',
  secret_enc TEXT,
  has_mfa    INTEGER NOT NULL DEFAULT 0,
  notes      TEXT    NOT NULL DEFAULT '',
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_credentials_task ON credentials(task_id);

-- Beleg/Datei. Physisch liegt sie im Storage (lokal oder Google Drive),
-- die Uebersicht in der Oberflaeche ist rein virtuell.
CREATE TABLE IF NOT EXISTS artifacts (
  id            INTEGER PRIMARY KEY,
  period_id     INTEGER NOT NULL REFERENCES periods(id) ON DELETE CASCADE,
  task_id       INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  filename      TEXT    NOT NULL,
  mime          TEXT    NOT NULL DEFAULT 'application/octet-stream',
  size          INTEGER NOT NULL DEFAULT 0,
  checksum      TEXT    NOT NULL DEFAULT '',
  storage_path  TEXT    NOT NULL DEFAULT '',
  storage_id    TEXT    NOT NULL DEFAULT '',
  source        TEXT    NOT NULL DEFAULT 'manuell', -- manuell | ki | eigenbeleg
  vendor        TEXT    NOT NULL DEFAULT '',        -- fuer den Bankabgleich
  amount_cents  INTEGER,
  doc_date      TEXT,
  uploaded_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_artifacts_period ON artifacts(period_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_task ON artifacts(task_id);

-- Importierter Bankauszug
CREATE TABLE IF NOT EXISTS bank_statements (
  id          INTEGER PRIMARY KEY,
  period_id   INTEGER NOT NULL REFERENCES periods(id) ON DELETE CASCADE,
  filename    TEXT    NOT NULL,
  account     TEXT    NOT NULL DEFAULT '',
  currency    TEXT    NOT NULL DEFAULT 'EUR',
  tx_count    INTEGER NOT NULL DEFAULT 0,
  imported_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Einzelbuchung
CREATE TABLE IF NOT EXISTS bank_tx (
  id           INTEGER PRIMARY KEY,
  statement_id INTEGER NOT NULL REFERENCES bank_statements(id) ON DELETE CASCADE,
  period_id    INTEGER NOT NULL REFERENCES periods(id) ON DELETE CASCADE,
  booking_date TEXT    NOT NULL DEFAULT '',
  value_date   TEXT    NOT NULL DEFAULT '',
  counterparty TEXT    NOT NULL DEFAULT '',
  purpose      TEXT    NOT NULL DEFAULT '',
  amount_cents INTEGER NOT NULL DEFAULT 0,
  currency     TEXT    NOT NULL DEFAULT 'EUR',
  group_key    TEXT    NOT NULL DEFAULT '',
  group_label  TEXT    NOT NULL DEFAULT '',
  tag          TEXT    NOT NULL DEFAULT '',
  note         TEXT    NOT NULL DEFAULT '',
  raw          TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_bank_tx_period ON bank_tx(period_id);
CREATE INDEX IF NOT EXISTS idx_bank_tx_group ON bank_tx(period_id, group_key);

-- Kuerzel -> Empfaenger (z.B. az -> az@lexaid.net)
CREATE TABLE IF NOT EXISTS shortcodes (
  id      INTEGER PRIMARY KEY,
  code    TEXT NOT NULL UNIQUE,
  email   TEXT NOT NULL,
  name    TEXT NOT NULL DEFAULT ''
);

-- Logbuch: append-only. Eintraege werden nie geloescht, nur im Status fortgeschrieben.
CREATE TABLE IF NOT EXISTS logbook (
  id          INTEGER PRIMARY KEY,
  period_id   INTEGER REFERENCES periods(id) ON DELETE SET NULL,
  task_id     INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  tx_id       INTEGER REFERENCES bank_tx(id) ON DELETE SET NULL,
  ticket      TEXT    NOT NULL UNIQUE,        -- Referenz im Mail-Betreff
  type        TEXT    NOT NULL,               -- belegabruf | ki_lauf | upload | status
  subject     TEXT    NOT NULL DEFAULT '',
  recipient   TEXT    NOT NULL DEFAULT '',
  body        TEXT    NOT NULL DEFAULT '',
  status      TEXT    NOT NULL DEFAULT 'offen', -- offen | gesendet | erledigt | fehlgeschlagen | storniert
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  resolution  TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_logbook_period ON logbook(period_id);

-- Unveraenderlicher Verlauf zu jedem Logbucheintrag
CREATE TABLE IF NOT EXISTS logbook_events (
  id         INTEGER PRIMARY KEY,
  logbook_id INTEGER NOT NULL REFERENCES logbook(id) ON DELETE CASCADE,
  at         TEXT    NOT NULL DEFAULT (datetime('now')),
  event      TEXT    NOT NULL,
  detail     TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_logbook_events ON logbook_events(logbook_id);

-- Lieferant: die zentrale Einheit der Monatsarbeit. Zu jedem Lieferanten
-- gehoeren Zugangsdaten, die Adresse seines Portals und die Muster, an denen
-- seine Buchungen im Kontoauszug erkannt werden.
CREATE TABLE IF NOT EXISTS lieferanten (
  id             INTEGER PRIMARY KEY,
  name           TEXT    NOT NULL UNIQUE,
  url            TEXT    NOT NULL DEFAULT '',
  rechnungen_url TEXT    NOT NULL DEFAULT '',   -- direkter Weg zur Rechnungsliste
  username       TEXT    NOT NULL DEFAULT '',
  secret_enc     TEXT,
  has_mfa        INTEGER NOT NULL DEFAULT 0,
  -- Optionale CSS-Selektoren, falls die automatische Formularerkennung
  -- bei diesem Portal nicht greift.
  sel_benutzer   TEXT    NOT NULL DEFAULT '',
  sel_passwort   TEXT    NOT NULL DEFAULT '',
  sel_absenden   TEXT    NOT NULL DEFAULT '',
  erwartet       INTEGER NOT NULL DEFAULT 0,     -- uebliche Belegzahl je Monat, 0 = unbekannt
  notizen        TEXT    NOT NULL DEFAULT '',
  aktiv          INTEGER NOT NULL DEFAULT 1,
  position       INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Textmuster, an denen Buchungen diesem Lieferanten zugeordnet werden.
CREATE TABLE IF NOT EXISTS lieferant_muster (
  id           INTEGER PRIMARY KEY,
  lieferant_id INTEGER NOT NULL REFERENCES lieferanten(id) ON DELETE CASCADE,
  muster       TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_muster_lieferant ON lieferant_muster(lieferant_id);

-- Stand eines Lieferanten in einem Monat. Abgehakt wird von Hand.
CREATE TABLE IF NOT EXISTS lieferant_monat (
  id           INTEGER PRIMARY KEY,
  lieferant_id INTEGER NOT NULL REFERENCES lieferanten(id) ON DELETE CASCADE,
  period_id    INTEGER NOT NULL REFERENCES periods(id) ON DELETE CASCADE,
  status       TEXT    NOT NULL DEFAULT 'offen',   -- offen | erledigt | entfaellt
  erledigt_am  TEXT,
  erledigt_von TEXT,
  notiz        TEXT    NOT NULL DEFAULT '',
  UNIQUE (lieferant_id, period_id)
);

-- Die Checkliste: Bereiche gliedern, Positionen werden abgehakt.
-- Ein Lieferant kann mehrere Positionen tragen (Stripe liefert Rechnungen,
-- Gutschriften, Payout Report ... aus einem einzigen Portal), eine Position
-- kann auch ganz ohne Lieferanten stehen (z.B. "Monatspruefung").
CREATE TABLE IF NOT EXISTS bereiche (
  id       INTEGER PRIMARY KEY,
  nummer   INTEGER NOT NULL,
  name     TEXT    NOT NULL UNIQUE,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS positionen (
  id           INTEGER PRIMARY KEY,
  bereich_id   INTEGER NOT NULL REFERENCES bereiche(id) ON DELETE CASCADE,
  lieferant_id INTEGER REFERENCES lieferanten(id) ON DELETE SET NULL,
  name         TEXT    NOT NULL,
  hinweis      TEXT    NOT NULL DEFAULT '',
  position     INTEGER NOT NULL DEFAULT 0,
  aktiv        INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_positionen_bereich ON positionen(bereich_id);

CREATE TABLE IF NOT EXISTS position_monat (
  id           INTEGER PRIMARY KEY,
  position_id  INTEGER NOT NULL REFERENCES positionen(id) ON DELETE CASCADE,
  period_id    INTEGER NOT NULL REFERENCES periods(id) ON DELETE CASCADE,
  status       TEXT    NOT NULL DEFAULT 'offen',   -- offen | erledigt | entfaellt
  erledigt_am  TEXT,
  erledigt_von TEXT,
  notiz        TEXT    NOT NULL DEFAULT '',
  UNIQUE (position_id, period_id)
);

-- Merkt, welcher Mailanhang schon uebernommen wurde. Ohne das entstuenden
-- bei jedem Durchlauf des Postfachs Dubletten.
CREATE TABLE IF NOT EXISTS postfach_import (
  id            INTEGER PRIMARY KEY,
  message_id    TEXT    NOT NULL,
  attachment_id TEXT    NOT NULL,
  artifact_id   INTEGER REFERENCES artifacts(id) ON DELETE SET NULL,
  period_id     INTEGER REFERENCES periods(id) ON DELETE CASCADE,
  absender      TEXT    NOT NULL DEFAULT '',
  betreff       TEXT    NOT NULL DEFAULT '',
  imported_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (message_id, attachment_id)
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

// Nachtraeglich ergaenzte Spalten: CREATE TABLE IF NOT EXISTS zieht bestehende
// Datenbanken nicht mit, deshalb hier gezielt nachruesten.
for (const [tabelle, spalte, definition] of [
  ['artifacts', 'web_url', "TEXT NOT NULL DEFAULT ''"],
  ['artifacts', 'lieferant_id', 'INTEGER REFERENCES lieferanten(id) ON DELETE SET NULL'],
  ['bank_tx', 'lieferant_id', 'INTEGER REFERENCES lieferanten(id) ON DELETE SET NULL'],
  ['artifacts', 'position_id', 'INTEGER REFERENCES positionen(id) ON DELETE SET NULL'],
]) {
  const vorhanden = db.prepare(`PRAGMA table_info(${tabelle})`).all().some((s) => s.name === spalte);
  if (!vorhanden) db.exec(`ALTER TABLE ${tabelle} ADD COLUMN ${spalte} ${definition}`);
}

export const all = (sql, ...params) => db.prepare(sql).all(...params);
export const get = (sql, ...params) => db.prepare(sql).get(...params);
export const run = (sql, ...params) => db.prepare(sql).run(...params);

export function setSetting(key, value) {
  run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value));
}
export function getSetting(key, fallback = null) {
  const row = get('SELECT value FROM settings WHERE key = ?', key);
  return row ? row.value : fallback;
}
