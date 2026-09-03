import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config, ROOT, aiEnabled } from './config.js';
import { all, get, run } from './db.js';
import { Router, json, fehler, leseJson, leseBody } from './http.js';
import { storage, sanitize } from './services/storage/index.js';
import { speichereDatei, leseDatei } from './services/ablage.js';
import { mailer } from './services/mail/index.js';
import { encryptSecret, maskSecret, vaultEnabled } from './services/vault.js';
import { generiereAufgaben } from './services/llm.js';
import { parseStatement } from './services/bank/csv.js';
import { buildGroups, groupKeyFor, labelFor } from './services/bank/grouping.js';
import * as logbuch from './services/logbook.js';
import { laufeAufgabe } from './services/agent.js';
import { erstelleBewirtungsbeleg, erstelleSpesenabrechnung, kombiniere } from './services/docgen.js';
import { analysiereQuittung } from './services/beleganalyse.js';

const router = new Router();
const STATUS_WERTE = ['offen', 'in_arbeit', 'wartet', 'erledigt'];
const MONATE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

// --- Systemstatus -----------------------------------------------------------

router.get('/api/status', (req, res) => json(res, {
  ki: { aktiv: aiEnabled, modell: config.model },
  tresor: { aktiv: vaultEnabled },
  ablage: storage.describe(),
  mail: mailer.describe(),
  buchhaltungspostfach: config.accountingInbox,
  kuerzel_domain: config.shortcodeDomain,
}));

// --- Perioden ---------------------------------------------------------------

router.get('/api/periods', (req, res) => json(res, all(`
  SELECT p.*,
         (SELECT COUNT(*) FROM tasks t WHERE t.period_id = p.id) AS aufgaben,
         (SELECT COUNT(*) FROM tasks t WHERE t.period_id = p.id AND t.status = 'erledigt') AS erledigt
  FROM periods p ORDER BY p.year DESC, p.month DESC`)));

router.post('/api/periods', async (req, res) => {
  const { year, month, aus_vorlagen = true } = await leseJson(req);
  const jahr = Number(year);
  const monat = Number(month);
  if (!Number.isInteger(jahr) || jahr < 2000 || jahr > 2100) throw new Error('Ungültiges Jahr.');
  if (!Number.isInteger(monat) || monat < 1 || monat > 12) throw new Error('Ungültiger Monat.');
  if (get('SELECT id FROM periods WHERE year = ? AND month = ?', jahr, monat)) {
    throw new Error(`Der Zeitraum ${MONATE[monat - 1]} ${jahr} existiert bereits.`);
  }
  const r = run('INSERT INTO periods (year, month, label) VALUES (?, ?, ?)', jahr, monat, MONATE[monat - 1]);
  const id = Number(r.lastInsertRowid);

  if (aus_vorlagen) {
    for (const v of all('SELECT * FROM task_templates WHERE active = 1 ORDER BY position, id')) {
      run(`INSERT INTO tasks (period_id, template_id, position, title, description, prompt, category)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        id, v.id, v.position, v.title, v.description, v.prompt, v.category);
    }
  }
  json(res, get('SELECT * FROM periods WHERE id = ?', id), 201);
});

// --- Aufgaben ---------------------------------------------------------------

function ladeAufgaben(periodId) {
  const aufgaben = all('SELECT * FROM tasks WHERE period_id = ? ORDER BY position, id', periodId);
  for (const a of aufgaben) {
    a.dateien = all(
      'SELECT id, filename, mime, size, source, vendor, amount_cents, doc_date, uploaded_at, storage_path, web_url FROM artifacts WHERE task_id = ? ORDER BY uploaded_at DESC',
      a.id,
    );
    a.zugaenge = all(
      'SELECT id, label, url, username, has_mfa, notes, (secret_enc IS NOT NULL) AS hat_secret FROM credentials WHERE task_id = ? ORDER BY id',
      a.id,
    ).map((z) => ({ ...z, secret: maskSecret(z.hat_secret) }));
  }
  return aufgaben;
}

router.get('/api/periods/:id/tasks', (req, res) => json(res, ladeAufgaben(Number(req.params.id))));

router.post('/api/periods/:id/tasks', async (req, res) => {
  const periodId = Number(req.params.id);
  if (!get('SELECT id FROM periods WHERE id = ?', periodId)) throw new Error('Zeitraum nicht gefunden.');
  const { title, description = '', prompt = '', category = 'allgemein' } = await leseJson(req);
  if (!String(title || '').trim()) throw new Error('Ein Titel ist erforderlich.');
  const max = get('SELECT COALESCE(MAX(position), 0) AS p FROM tasks WHERE period_id = ?', periodId);
  const r = run(
    'INSERT INTO tasks (period_id, position, title, description, prompt, category) VALUES (?, ?, ?, ?, ?, ?)',
    periodId, max.p + 1, String(title).trim(), description, prompt, category,
  );
  json(res, get('SELECT * FROM tasks WHERE id = ?', Number(r.lastInsertRowid)), 201);
});

router.patch('/api/tasks/:id', async (req, res) => {
  const id = Number(req.params.id);
  const task = get('SELECT * FROM tasks WHERE id = ?', id);
  if (!task) throw new Error('Aufgabe nicht gefunden.');
  const daten = await leseJson(req);

  if (daten.status !== undefined && !STATUS_WERTE.includes(daten.status)) {
    throw new Error(`Unbekannter Status "${daten.status}".`);
  }
  const felder = ['title', 'description', 'prompt', 'category', 'status', 'notes', 'position'];
  const zuSetzen = felder.filter((f) => daten[f] !== undefined);
  if (zuSetzen.length) {
    run(
      `UPDATE tasks SET ${zuSetzen.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`,
      ...zuSetzen.map((f) => daten[f]), id,
    );
  }
  // Das Abhaken durch die Verwaltung wird mit Zeitpunkt und Person festgehalten.
  if (daten.status === 'erledigt' && task.status !== 'erledigt') {
    run("UPDATE tasks SET done_at = datetime('now'), done_by = ? WHERE id = ?", daten.done_by || 'Admin', id);
  } else if (daten.status && daten.status !== 'erledigt') {
    run('UPDATE tasks SET done_at = NULL, done_by = NULL WHERE id = ?', id);
  }
  json(res, get('SELECT * FROM tasks WHERE id = ?', id));
});

router.delete('/api/tasks/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!get('SELECT id FROM tasks WHERE id = ?', id)) throw new Error('Aufgabe nicht gefunden.');
  run('DELETE FROM tasks WHERE id = ?', id);
  json(res, { geloescht: id });
});

// Aktuelle Aufgabenliste als wiederverwendbare Vorlage sichern
router.post('/api/periods/:id/als-vorlage', (req, res) => {
  const aufgaben = all('SELECT * FROM tasks WHERE period_id = ? ORDER BY position, id', Number(req.params.id));
  run('DELETE FROM task_templates');
  for (const [i, a] of aufgaben.entries()) {
    run('INSERT INTO task_templates (position, title, description, prompt, category) VALUES (?, ?, ?, ?, ?)',
      i + 1, a.title, a.description, a.prompt, a.category);
  }
  json(res, { vorlagen: aufgaben.length });
});

// --- KI-gestützte Aufgabenliste ---------------------------------------------

router.post('/api/periods/:id/ki/aufgaben', async (req, res) => {
  const periodId = Number(req.params.id);
  if (!get('SELECT id FROM periods WHERE id = ?', periodId)) throw new Error('Zeitraum nicht gefunden.');
  const { prompt, modus = 'ersetzen' } = await leseJson(req);
  if (!String(prompt || '').trim()) throw new Error('Bitte eine Anweisung eingeben.');

  const bestand = all('SELECT title, description, prompt, category FROM tasks WHERE period_id = ? ORDER BY position, id', periodId);
  const vorschlag = await generiereAufgaben(String(prompt).trim(), modus === 'ergaenzen' ? bestand : []);

  // Erledigte Aufgaben und ihre Dateien bleiben erhalten - eine neue Liste darf
  // bereits geleistete Arbeit nicht verwerfen.
  const behalten = all("SELECT * FROM tasks WHERE period_id = ? AND status = 'erledigt' ORDER BY position, id", periodId);
  const behaltenTitel = new Set(behalten.map((t) => t.title.toLowerCase()));
  run("DELETE FROM tasks WHERE period_id = ? AND status != 'erledigt'", periodId);

  let position = behalten.length;
  let angelegt = 0;
  for (const a of vorschlag) {
    if (behaltenTitel.has(String(a.title).toLowerCase())) continue;
    run('INSERT INTO tasks (period_id, position, title, description, prompt, category) VALUES (?, ?, ?, ?, ?, ?)',
      periodId, ++position, a.title, a.description || '', a.prompt || '', a.category || 'allgemein');
    angelegt++;
  }
  json(res, { angelegt, unveraendert: behalten.length, ki: aiEnabled, aufgaben: ladeAufgaben(periodId) });
});

router.post('/api/tasks/:id/ki/lauf', async (req, res) => json(res, await laufeAufgabe(Number(req.params.id))));

// --- Dateien ----------------------------------------------------------------

// Upload ohne Multipart: die Datei kommt als reiner Koerper, Name und Typ als Header.
router.post('/api/tasks/:id/dateien', async (req, res) => {
  const taskId = Number(req.params.id);
  const task = get('SELECT * FROM tasks WHERE id = ?', taskId);
  if (!task) throw new Error('Aufgabe nicht gefunden.');
  const filename = decodeURIComponent(req.headers['x-filename'] || 'upload.bin');
  const mime = req.headers['content-type'] || 'application/octet-stream';
  const buffer = await leseBody(req);
  if (!buffer.length) throw new Error('Die hochgeladene Datei ist leer.');
  json(res, await speichereDatei({ periodId: task.period_id, taskId, filename, mime, buffer, source: 'manuell' }), 201);
});

router.get('/api/dateien/:id/inhalt', async (req, res) => {
  const datei = get('SELECT * FROM artifacts WHERE id = ?', Number(req.params.id));
  if (!datei) throw new Error('Datei nicht gefunden.');
  const buffer = await leseDatei(datei);
  res.writeHead(200, {
    'Content-Type': datei.mime,
    'Content-Length': buffer.length,
    'Content-Disposition': `inline; filename="${encodeURIComponent(datei.filename)}"`,
  });
  res.end(buffer);
});

router.patch('/api/dateien/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!get('SELECT id FROM artifacts WHERE id = ?', id)) throw new Error('Datei nicht gefunden.');
  const daten = await leseJson(req);
  const felder = ['vendor', 'amount_cents', 'doc_date', 'task_id'].filter((f) => daten[f] !== undefined);
  if (felder.length) {
    run(`UPDATE artifacts SET ${felder.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`,
      ...felder.map((f) => daten[f]), id);
  }
  json(res, get('SELECT * FROM artifacts WHERE id = ?', id));
});

router.delete('/api/dateien/:id', async (req, res) => {
  const datei = get('SELECT * FROM artifacts WHERE id = ?', Number(req.params.id));
  if (!datei) throw new Error('Datei nicht gefunden.');
  await storage.deleteFile({ path: datei.storage_path, id: datei.storage_id }).catch(() => {});
  run('DELETE FROM artifacts WHERE id = ?', datei.id);
  json(res, { geloescht: datei.id });
});

// --- Zugangsdaten -----------------------------------------------------------

router.post('/api/tasks/:id/zugaenge', async (req, res) => {
  const taskId = Number(req.params.id);
  if (!get('SELECT id FROM tasks WHERE id = ?', taskId)) throw new Error('Aufgabe nicht gefunden.');
  const { label, url = '', username = '', secret = '', has_mfa = false, notes = '' } = await leseJson(req);
  if (!String(label || '').trim()) throw new Error('Eine Bezeichnung ist erforderlich.');
  if (secret && !vaultEnabled) {
    throw new Error('VAULT_PASSPHRASE ist nicht gesetzt - ohne Master-Passphrase werden keine Passwörter gespeichert.');
  }
  const r = run(
    'INSERT INTO credentials (task_id, label, url, username, secret_enc, has_mfa, notes) VALUES (?, ?, ?, ?, ?, ?, ?)',
    taskId, String(label).trim(), url, username, secret ? encryptSecret(secret) : null, has_mfa ? 1 : 0, notes,
  );
  const z = get('SELECT id, label, url, username, has_mfa, notes, (secret_enc IS NOT NULL) AS hat_secret FROM credentials WHERE id = ?', Number(r.lastInsertRowid));
  json(res, { ...z, secret: maskSecret(z.hat_secret) }, 201);
});

router.delete('/api/zugaenge/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!get('SELECT id FROM credentials WHERE id = ?', id)) throw new Error('Zugang nicht gefunden.');
  run('DELETE FROM credentials WHERE id = ?', id);
  json(res, { geloescht: id });
});

// --- Bankabgleich -----------------------------------------------------------

router.post('/api/periods/:id/bank/import', async (req, res) => {
  const periodId = Number(req.params.id);
  if (!get('SELECT id FROM periods WHERE id = ?', periodId)) throw new Error('Zeitraum nicht gefunden.');
  const filename = decodeURIComponent(req.headers['x-filename'] || 'kontoauszug.csv');
  const buffer = await leseBody(req, 32 * 1024 * 1024);
  if (!buffer.length) throw new Error('Die hochgeladene Datei ist leer.');

  const ergebnis = parseStatement(buffer);
  if (!ergebnis.transaktionen.length) throw new Error('Es konnten keine Buchungen gelesen werden.');

  const r = run(
    'INSERT INTO bank_statements (period_id, filename, tx_count) VALUES (?, ?, ?)',
    periodId, sanitize(filename), ergebnis.transaktionen.length,
  );
  const statementId = Number(r.lastInsertRowid);

  for (const tx of ergebnis.transaktionen) {
    const key = groupKeyFor(tx);
    run(
      `INSERT INTO bank_tx (statement_id, period_id, booking_date, value_date, counterparty, purpose,
                            amount_cents, currency, group_key, group_label, raw)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      statementId, periodId, tx.booking_date, tx.value_date, tx.counterparty, tx.purpose,
      tx.amount_cents, tx.currency, key, labelFor(tx, key), tx.raw,
    );
  }
  json(res, {
    statement_id: statementId,
    buchungen: ergebnis.transaktionen.length,
    verworfen: ergebnis.verworfen.length,
    erkannte_spalten: ergebnis.mapping,
    kopfzeile: ergebnis.header,
  }, 201);
});

router.get('/api/periods/:id/bank/gruppen', (req, res) => {
  const periodId = Number(req.params.id);
  const tx = all('SELECT * FROM bank_tx WHERE period_id = ? ORDER BY booking_date, id', periodId);
  const belege = all(
    "SELECT id, filename, vendor, amount_cents, doc_date FROM artifacts WHERE period_id = ? AND vendor != ''",
    periodId,
  );
  json(res, {
    gruppen: buildGroups(tx, belege),
    buchungen_gesamt: tx.length,
    belege_ohne_zuordnung: all(
      "SELECT id, filename FROM artifacts WHERE period_id = ? AND vendor = ''", periodId,
    ),
  });
});

// Kürzel an einer Buchung löst die Beleganfrage per Mail aus.
router.patch('/api/bank/buchungen/:id', async (req, res) => {
  const id = Number(req.params.id);
  const tx = get('SELECT * FROM bank_tx WHERE id = ?', id);
  if (!tx) throw new Error('Buchung nicht gefunden.');
  const daten = await leseJson(req);

  const felder = ['tag', 'note', 'group_key', 'group_label'].filter((f) => daten[f] !== undefined);
  if (felder.length) {
    run(`UPDATE bank_tx SET ${felder.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`,
      ...felder.map((f) => daten[f]), id);
  }
  const aktualisiert = get('SELECT * FROM bank_tx WHERE id = ?', id);

  let anfrage = null;
  const neuesKuerzel = String(daten.tag ?? '').trim();
  // Nur bei einem neu gesetzten Kürzel wird verschickt - ein erneutes Speichern
  // derselben Buchung darf keine zweite Mail auslösen.
  if (daten.anfragen !== false && neuesKuerzel && neuesKuerzel !== String(tx.tag || '').trim()) {
    const bereits = get(
      "SELECT id FROM logbook WHERE tx_id = ? AND type = 'belegabruf' AND status IN ('offen','gesendet')", id,
    );
    if (!bereits) {
      const period = get('SELECT * FROM periods WHERE id = ?', tx.period_id);
      anfrage = await logbuch.fordereBelegAn({ tx: aktualisiert, code: neuesKuerzel, period });
    }
  }
  json(res, { buchung: aktualisiert, anfrage });
});

// --- Logbuch ----------------------------------------------------------------

router.get('/api/periods/:id/logbuch', (req, res) => json(res, logbuch.listeLogbuch(Number(req.params.id))));
router.post('/api/logbuch/:id/pruefen', async (req, res) => json(res, await logbuch.pruefeErledigung(Number(req.params.id))));
router.post('/api/periods/:id/logbuch/pruefen', async (req, res) => json(res, await logbuch.pruefeAlleOffenen(Number(req.params.id))));

// --- Kürzel -----------------------------------------------------------------

router.get('/api/kuerzel', (req, res) => json(res, all('SELECT * FROM shortcodes ORDER BY code')));
router.post('/api/kuerzel', async (req, res) => {
  const { code, email, name = '' } = await leseJson(req);
  const c = String(code || '').trim().toLowerCase();
  const e = String(email || '').trim() || `${c}@${config.shortcodeDomain}`;
  if (!/^[a-z0-9._-]{1,32}$/.test(c)) throw new Error('Ungültiges Kürzel.');
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(e)) throw new Error('Ungültige E-Mail-Adresse.');
  run('INSERT INTO shortcodes (code, email, name) VALUES (?, ?, ?) ON CONFLICT(code) DO UPDATE SET email = excluded.email, name = excluded.name', c, e, name);
  json(res, get('SELECT * FROM shortcodes WHERE code = ?', c), 201);
});
router.delete('/api/kuerzel/:id', (req, res) => {
  run('DELETE FROM shortcodes WHERE id = ?', Number(req.params.id));
  json(res, { geloescht: Number(req.params.id) });
});

// --- Belegerstellung --------------------------------------------------------

// Liest eine hochgeladene Quittung aus und schlägt die Belegfelder vor.
router.post('/api/dateien/:id/analyse', async (req, res) => {
  const datei = get('SELECT * FROM artifacts WHERE id = ?', Number(req.params.id));
  if (!datei) throw new Error('Datei nicht gefunden.');
  const { art = 'bewirtung' } = await leseJson(req);
  const buffer = await leseDatei(datei);
  json(res, await analysiereQuittung({ buffer, mime: datei.mime, filename: datei.filename, art }));
});

async function belegAblegen({ periodId, taskId, titel, bytes, anlagenIds }) {
  const anlagen = [];
  for (const id of anlagenIds || []) {
    const a = get('SELECT * FROM artifacts WHERE id = ?', Number(id));
    if (a) anlagen.push({ buffer: await leseDatei(a), mime: a.mime, filename: a.filename });
  }
  const kombiniert = await kombiniere(bytes, anlagen);
  return speichereDatei({
    periodId, taskId,
    filename: `${titel}.pdf`,
    mime: 'application/pdf',
    buffer: Buffer.from(kombiniert),
    source: 'eigenbeleg',
  });
}

router.post('/api/periods/:id/belege/bewirtung', async (req, res) => {
  const periodId = Number(req.params.id);
  const daten = await leseJson(req);
  if (!daten.datum) throw new Error('Der Tag der Bewirtung ist eine Pflichtangabe.');
  if (!String(daten.anlass || '').trim()) throw new Error('Der konkrete Anlass ist eine Pflichtangabe.');
  if (!String(daten.restaurant || '').trim()) throw new Error('Name der Gaststätte ist eine Pflichtangabe.');
  const teilnehmerListe = Array.isArray(daten.teilnehmer)
    ? daten.teilnehmer.filter((t) => String(t).trim())
    : String(daten.teilnehmer || '').split('\n').filter((t) => t.trim());
  if (!teilnehmerListe.length) throw new Error('Die bewirteten Personen sind eine Pflichtangabe.');
  if (!Number(daten.brutto_cents)) throw new Error('Der Rechnungsbetrag ist eine Pflichtangabe.');

  const beleg = await erstelleBewirtungsbeleg({ ...daten, teilnehmer: teilnehmerListe });
  const datei = await belegAblegen({
    periodId, taskId: daten.task_id ? Number(daten.task_id) : null,
    titel: `Bewirtungsbeleg ${daten.datum} ${sanitize(daten.restaurant)}`,
    bytes: beleg.bytes, anlagenIds: daten.anlagen,
  });
  if (daten.restaurant) {
    run('UPDATE artifacts SET vendor = ?, amount_cents = ?, doc_date = ? WHERE id = ?',
      daten.restaurant, beleg.zusammenfassung.gesamt_cents, daten.datum, datei.id);
  }
  json(res, { datei, zusammenfassung: beleg.zusammenfassung }, 201);
});

router.post('/api/periods/:id/belege/spesen', async (req, res) => {
  const periodId = Number(req.params.id);
  const daten = await leseJson(req);
  if (!String(daten.reisender || '').trim()) throw new Error('Der Name der reisenden Person ist eine Pflichtangabe.');
  if (!String(daten.reisegrund || '').trim()) throw new Error('Der Reisegrund ist eine Pflichtangabe.');
  if (!daten.beginn_datum) throw new Error('Das Reisebeginn-Datum ist eine Pflichtangabe.');

  const beleg = await erstelleSpesenabrechnung(daten);
  const datei = await belegAblegen({
    periodId, taskId: daten.task_id ? Number(daten.task_id) : null,
    titel: `Spesenabrechnung ${daten.beginn_datum} ${sanitize(daten.reisender)}`,
    bytes: beleg.bytes, anlagenIds: daten.anlagen,
  });
  run('UPDATE artifacts SET vendor = ?, amount_cents = ?, doc_date = ? WHERE id = ?',
    daten.reisender, beleg.zusammenfassung.gesamt_cents, daten.beginn_datum, datei.id);
  json(res, { datei, zusammenfassung: beleg.zusammenfassung }, 201);
});

// --- Statische Dateien ------------------------------------------------------

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function statisch(req, res) {
  const pfad = req.url.split('?')[0];
  const datei = pfad === '/' ? 'index.html' : pfad.replace(/^\/+/, '');
  const ziel = path.resolve(ROOT, 'public', datei);
  if (!ziel.startsWith(path.resolve(ROOT, 'public')) || !fs.existsSync(ziel) || !fs.statSync(ziel).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Nicht gefunden');
    return;
  }
  const body = fs.readFileSync(ziel);
  res.writeHead(200, { 'Content-Type': MIME[path.extname(ziel)] || 'application/octet-stream', 'Content-Length': body.length });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const pfad = req.url.split('?')[0];
  if (!pfad.startsWith('/api/')) return statisch(req, res);
  const treffer = router.finde(req.method, pfad);
  if (!treffer) return fehler(res, new Error(`Unbekannter Endpunkt ${req.method} ${pfad}`), 404);
  req.params = treffer.params;
  try {
    await treffer.handler(req, res);
  } catch (err) {
    if (!res.headersSent) fehler(res, err, 400);
    else res.end();
  }
});

server.listen(config.port, config.host, () => {
  console.log(`Buchhaltungsvorbereitung laeuft auf http://${config.host}:${config.port}`);
  console.log(`  KI:     ${aiEnabled ? config.model : 'Mock-Modus (kein ANTHROPIC_API_KEY)'}`);
  console.log(`  Tresor: ${vaultEnabled ? 'aktiv' : 'inaktiv (kein VAULT_PASSPHRASE)'}`);
  console.log(`  Ablage: ${storage.describe().driver}`);
  console.log(`  Mail:   ${mailer.describe().driver}`);
});

export { server };
