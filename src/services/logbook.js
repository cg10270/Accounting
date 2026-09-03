import { all, get, run } from '../db.js';
import { config } from '../config.js';
import { mailer } from './mail/index.js';
import { formatEuro } from './bank/grouping.js';
import { datumDe } from './steuerregeln.js';
import { speichereDatei } from './ablage.js';

// Das Logbuch ist append-only: Eintraege werden nie geloescht, sondern nur im
// Status fortgeschrieben. Jede Zustandsaenderung erzeugt zusaetzlich ein
// unveraenderliches Ereignis - das ist die Voraussetzung fuer eine
// nachvollziehbare Belegkette.

export function neuesTicket(period) {
  const praefix = period
    ? `ACC-${period.year}${String(period.month).padStart(2, '0')}`
    : `ACC-${new Date().getFullYear()}00`;
  const letzter = get(
    'SELECT ticket FROM logbook WHERE ticket LIKE ? ORDER BY ticket DESC LIMIT 1',
    `${praefix}-%`,
  );
  const nr = letzter ? Number(letzter.ticket.split('-').pop()) + 1 : 1;
  return `${praefix}-${String(nr).padStart(3, '0')}`;
}

export function erfasse({ period_id = null, task_id = null, tx_id = null, type, subject = '', recipient = '', body = '', status = 'offen' }, period = null) {
  const ticket = neuesTicket(period || (period_id ? get('SELECT * FROM periods WHERE id = ?', period_id) : null));
  const res = run(
    `INSERT INTO logbook (period_id, task_id, tx_id, ticket, type, subject, recipient, body, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    period_id, task_id, tx_id, ticket, type, subject, recipient, body, status,
  );
  const id = Number(res.lastInsertRowid);
  ereignis(id, 'angelegt', `Typ: ${type}`);
  return get('SELECT * FROM logbook WHERE id = ?', id);
}

export function ereignis(logbookId, event, detail = '') {
  run('INSERT INTO logbook_events (logbook_id, event, detail) VALUES (?, ?, ?)', logbookId, event, detail);
}

export function setzeStatus(logbookId, status, detail = '', resolution = '') {
  const erledigt = ['erledigt', 'fehlgeschlagen', 'storniert'].includes(status);
  run(
    `UPDATE logbook SET status = ?, resolution = ?, resolved_at = ${erledigt ? "datetime('now')" : 'NULL'} WHERE id = ?`,
    status, resolution, logbookId,
  );
  ereignis(logbookId, `status: ${status}`, detail);
  return get('SELECT * FROM logbook WHERE id = ?', logbookId);
}

export function loeseKuerzelAuf(code) {
  const sauber = String(code || '').trim().toLowerCase();
  if (!sauber) return null;
  const treffer = get('SELECT * FROM shortcodes WHERE code = ?', sauber);
  if (treffer) return treffer;
  // Unbekannte Kuerzel werden nach der Konvention <kuerzel>@<domain> aufgeloest.
  if (/^[a-z0-9._-]{1,32}$/.test(sauber)) {
    return { code: sauber, email: `${sauber}@${config.shortcodeDomain}`, name: '', implizit: true };
  }
  return null;
}

/**
 * Fordert zu einer Einzelbuchung den fehlenden Beleg per Mail an.
 * Der Empfaenger ergibt sich aus dem Kuerzel (z.B. "az" -> az@lexaid.net),
 * die Antwort soll an das Buchhaltungspostfach gehen.
 */
export async function fordereBelegAn({ tx, code, period, task_id = null }) {
  const empfaenger = loeseKuerzelAuf(code);
  if (!empfaenger) throw new Error(`Kürzel "${code}" konnte keinem Empfänger zugeordnet werden.`);

  const betragText = formatEuro(tx.amount_cents);
  const buchungText = [
    `Datum:    ${datumDe(tx.booking_date)}`,
    `Betrag:   ${betragText}`,
    `Empfänger/Zahler:  ${tx.counterparty || '-'}`,
    `Verwendungszweck:  ${tx.purpose || '-'}`,
  ].join('\n');

  const eintrag = erfasse({
    period_id: period?.id ?? null,
    task_id,
    tx_id: tx.id,
    type: 'belegabruf',
    recipient: empfaenger.email,
    subject: '',
    body: '',
  }, period);

  const subject = `[${eintrag.ticket}] Beleg benötigt: ${tx.counterparty || 'Buchung'} ${betragText}`;
  const body = [
    `Hallo${empfaenger.name ? ' ' + empfaenger.name : ''},`,
    '',
    'zu der folgenden Buchung fehlt uns noch der Beleg:',
    '',
    buchungText,
    '',
    `Bitte sende den Beleg an ${config.accountingInbox}.`,
    `Lass dabei bitte das Kennzeichen ${eintrag.ticket} im Betreff stehen – daran ordnen wir den Beleg automatisch zu.`,
    '',
    'Vielen Dank!',
    'Buchhaltung',
  ].join('\n');

  run('UPDATE logbook SET subject = ?, body = ? WHERE id = ?', subject, body, eintrag.id);

  try {
    const ergebnis = await mailer.sendMail({
      to: empfaenger.email,
      subject,
      body,
      replyTo: config.accountingInbox,
    });
    return setzeStatus(eintrag.id, 'gesendet', `Versand über ${ergebnis.driver}: ${ergebnis.id}`);
  } catch (err) {
    return setzeStatus(eintrag.id, 'fehlgeschlagen', err.message, err.message);
  }
}

/**
 * Prueft fuer einen offenen Eintrag, ob im Buchhaltungspostfach eine Antwort
 * mit dem passenden Ticket eingegangen ist.
 */
export async function pruefeErledigung(logbookId) {
  const eintrag = get('SELECT * FROM logbook WHERE id = ?', logbookId);
  if (!eintrag) throw new Error('Logbucheintrag nicht gefunden.');
  if (eintrag.status === 'erledigt') return eintrag;

  const antwort = await mailer.findReply(eintrag.ticket);
  if (!antwort) {
    ereignis(logbookId, 'geprueft', 'Noch keine Antwort im Postfach gefunden.');
    return get('SELECT * FROM logbook WHERE id = ?', logbookId);
  }
  ereignis(logbookId, 'antwort gefunden', `${antwort.from || ''} — ${antwort.subject}`.trim());

  // Der eingegangene Beleg wandert sofort in die Ablage. Bliebe er im
  // Postfach, waere die Anfrage zwar beantwortet, der Beleg aber nirgends
  // auffindbar - und der Bankabgleich zaehlte ihn weiterhin als Luecke.
  const abgelegt = await legeAnhaengeAb(eintrag, antwort);

  const beschreibung = abgelegt.length
    ? `Beleg per Mail eingegangen und abgelegt: ${abgelegt.map((d) => d.filename).join(', ')}`
    : antwort.hasAttachment
      ? 'Beleg eingegangen, konnte aber nicht abgelegt werden'
      : 'Antwort ohne Anhang eingegangen';

  return setzeStatus(logbookId, 'erledigt', `Antwort gefunden: ${antwort.subject}`, beschreibung);
}

// Legt die Anhaenge einer Antwort in der Ablage ab und verknuepft sie mit der
// Aufgabe und - ueber den Buchungspartner - mit der Buchungsgruppe.
async function legeAnhaengeAb(eintrag, antwort) {
  if (!eintrag.period_id || !antwort.anhaenge?.length || !antwort.ladeAnhang) return [];
  const buchung = eintrag.tx_id ? get('SELECT * FROM bank_tx WHERE id = ?', eintrag.tx_id) : null;
  const abgelegt = [];

  for (const anhang of antwort.anhaenge) {
    try {
      const inhalt = await antwort.ladeAnhang(anhang.attachmentId);
      const datei = await speichereDatei({
        periodId: eintrag.period_id,
        taskId: eintrag.task_id,
        filename: `${eintrag.ticket} ${anhang.filename}`,
        mime: anhang.mime,
        buffer: inhalt,
        source: 'mail',
        ordner: 'Beleganfragen',
      });
      // Zuordnung fuer den Bankabgleich aus der angefragten Buchung uebernehmen.
      if (buchung) {
        run('UPDATE artifacts SET vendor = ?, amount_cents = ?, doc_date = ? WHERE id = ?',
          buchung.counterparty, Math.abs(buchung.amount_cents), buchung.booking_date, datei.id);
      }
      abgelegt.push(datei);
      ereignis(eintrag.id, 'beleg abgelegt', datei.storage_path);
    } catch (err) {
      // Ein fehlgeschlagener Anhang darf die Erledigung nicht verschlucken -
      // er wird vermerkt, damit die Luecke sichtbar bleibt.
      ereignis(eintrag.id, 'ablage fehlgeschlagen', `${anhang.filename}: ${err.message}`);
    }
  }
  return abgelegt;
}

export async function pruefeAlleOffenen(periodId = null) {
  const offene = all(
    `SELECT id FROM logbook WHERE type = 'belegabruf' AND status IN ('gesendet', 'offen')
     ${periodId ? 'AND period_id = ?' : ''}`,
    ...(periodId ? [periodId] : []),
  );
  const ergebnisse = [];
  for (const { id } of offene) {
    try { ergebnisse.push(await pruefeErledigung(id)); }
    catch (err) { ergebnisse.push({ id, fehler: err.message }); }
  }
  return ergebnisse;
}

export function listeLogbuch(periodId = null) {
  const eintraege = all(
    `SELECT l.*, t.counterparty, t.amount_cents, t.booking_date, tk.title AS task_title
     FROM logbook l
     LEFT JOIN bank_tx t ON t.id = l.tx_id
     LEFT JOIN tasks tk  ON tk.id = l.task_id
     ${periodId ? 'WHERE l.period_id = ?' : ''}
     ORDER BY l.created_at DESC, l.id DESC`,
    ...(periodId ? [periodId] : []),
  );
  for (const e of eintraege) {
    e.verlauf = all('SELECT at, event, detail FROM logbook_events WHERE logbook_id = ? ORDER BY id', e.id);
  }
  return eintraege;
}
