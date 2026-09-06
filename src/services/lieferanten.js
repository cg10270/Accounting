import { all, get, run } from '../db.js';
import { encryptSecret, maskSecret, vaultEnabled } from './vault.js';
import { normalizeName } from './bank/grouping.js';
import { parseAmountToCents } from './bank/csv.js';

// Der Lieferant ist die zentrale Einheit der Monatsarbeit. Zu jedem Lieferanten
// gehoeren Zugang und Portaladresse, und - das ist der eigentliche Punkt - die
// Gegenueberstellung: was sagt die Bank, was liegt an Belegen vor, wo klafft es.

const STATUS = ['offen', 'erledigt', 'entfaellt'];

// --- Stammdaten --------------------------------------------------------------

export function listeLieferanten({ nurAktive = false } = {}) {
  const zeilen = all(
    `SELECT id, name, url, rechnungen_url, username, has_mfa, sel_benutzer, sel_passwort,
            sel_absenden, erwartet, notizen, aktiv, position,
            (secret_enc IS NOT NULL) AS hat_secret
     FROM lieferanten ${nurAktive ? 'WHERE aktiv = 1' : ''}
     ORDER BY position, name`,
  );
  for (const l of zeilen) {
    l.secret = maskSecret(l.hat_secret);
    l.muster = all(
      'SELECT id, muster, betrag_min_cents, betrag_max_cents FROM lieferant_muster WHERE lieferant_id = ? ORDER BY id',
      l.id).map((m) => ({ ...m, text: musterText(m) }));
  }
  return zeilen;
}

export function holeLieferant(id) {
  return listeLieferanten().find((l) => l.id === Number(id)) || null;
}

export function legeAn(daten) {
  const name = String(daten.name || '').trim();
  if (!name) throw new Error('Ein Name ist erforderlich.');
  if (get('SELECT id FROM lieferanten WHERE name = ?', name)) {
    throw new Error(`Ein Lieferant "${name}" existiert bereits.`);
  }
  if (daten.secret && !vaultEnabled) {
    throw new Error('VAULT_PASSPHRASE ist nicht gesetzt - ohne Master-Passphrase werden keine Passwörter gespeichert.');
  }
  const max = get('SELECT COALESCE(MAX(position), 0) AS p FROM lieferanten');
  const r = run(
    `INSERT INTO lieferanten (name, url, rechnungen_url, username, secret_enc, has_mfa,
                              sel_benutzer, sel_passwort, sel_absenden, erwartet, notizen, position)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    name, daten.url || '', daten.rechnungen_url || '', daten.username || '',
    daten.secret ? encryptSecret(daten.secret) : null, daten.has_mfa ? 1 : 0,
    daten.sel_benutzer || '', daten.sel_passwort || '', daten.sel_absenden || '',
    Number(daten.erwartet) || 0, daten.notizen || '', max.p + 1,
  );
  const id = Number(r.lastInsertRowid);
  // Ohne eigenes Muster wird der Name selbst zum Muster - das trifft die
  // allermeisten Faelle ohne weiteres Zutun.
  setzeMuster(id, daten.muster?.length ? daten.muster : [name]);
  return holeLieferant(id);
}

export function aendere(id, daten) {
  const lieferant = get('SELECT * FROM lieferanten WHERE id = ?', Number(id));
  if (!lieferant) throw new Error('Lieferant nicht gefunden.');

  const felder = ['name', 'url', 'rechnungen_url', 'username', 'sel_benutzer', 'sel_passwort',
    'sel_absenden', 'erwartet', 'notizen', 'aktiv', 'position']
    .filter((f) => daten[f] !== undefined);
  if (felder.length) {
    run(`UPDATE lieferanten SET ${felder.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`,
      ...felder.map((f) => daten[f]), Number(id));
  }
  if (daten.has_mfa !== undefined) run('UPDATE lieferanten SET has_mfa = ? WHERE id = ?', daten.has_mfa ? 1 : 0, Number(id));

  // Ein leerer String loescht das Passwort, undefined laesst es unberuehrt.
  if (daten.secret !== undefined) {
    if (daten.secret && !vaultEnabled) throw new Error('VAULT_PASSPHRASE ist nicht gesetzt.');
    run('UPDATE lieferanten SET secret_enc = ? WHERE id = ?', daten.secret ? encryptSecret(daten.secret) : null, Number(id));
  }
  if (daten.muster !== undefined) setzeMuster(Number(id), daten.muster);
  return holeLieferant(id);
}

export function loesche(id) {
  if (!get('SELECT id FROM lieferanten WHERE id = ?', Number(id))) throw new Error('Lieferant nicht gefunden.');
  run('DELETE FROM lieferanten WHERE id = ?', Number(id));
  return { geloescht: Number(id) };
}

/**
 * Liest ein Muster ein. Neben dem reinen Text ist eine Betragsbedingung
 * moeglich - manche Lieferanten lassen sich nur an der Groessenordnung
 * auseinanderhalten:
 *
 *   google              trifft jede Google-Buchung
 *   google >1000        nur Buchungen ueber 1.000 EUR
 *   google <1000        nur Buchungen darunter
 *   google 50-200       nur Buchungen in dieser Spanne
 *
 * Verglichen wird der Betrag, nicht das Vorzeichen: eine Abbuchung von
 * 2.150 EUR steht im Auszug als -2.150,00.
 */
export function parseMuster(eingabe) {
  const roh = String(eingabe || '').trim();
  if (!roh) return null;

  let text = roh;
  let min = null;
  let max = null;

  const spanne = roh.match(/^(.*?)\s+([\d.,]+)\s*-\s*([\d.,]+)$/);
  const grenze = roh.match(/^(.*?)\s*([<>])\s*([\d.,]+)$/);

  if (spanne) {
    text = spanne[1];
    min = parseAmountToCents(spanne[2]);
    max = parseAmountToCents(spanne[3]);
  } else if (grenze) {
    text = grenze[1];
    const wert = parseAmountToCents(grenze[3]);
    if (grenze[2] === '>') min = wert; else max = wert;
  }

  const muster = normalizeName(text);
  if (muster.length < 2) return null;
  return { muster, betrag_min_cents: min, betrag_max_cents: max };
}

// Fuer die Anzeige zurueck in die Schreibweise der Eingabe.
export function musterText(m) {
  const euro = (c) => (c / 100).toLocaleString('de-DE', { minimumFractionDigits: 0 });
  if (m.betrag_min_cents != null && m.betrag_max_cents != null) {
    return `${m.muster} ${euro(m.betrag_min_cents)}-${euro(m.betrag_max_cents)}`;
  }
  if (m.betrag_min_cents != null) return `${m.muster} >${euro(m.betrag_min_cents)}`;
  if (m.betrag_max_cents != null) return `${m.muster} <${euro(m.betrag_max_cents)}`;
  return m.muster;
}

export function setzeMuster(lieferantId, muster) {
  run('DELETE FROM lieferant_muster WHERE lieferant_id = ?', Number(lieferantId));
  const gesehen = new Set();
  const angelegt = [];

  for (const eintrag of muster || []) {
    const geparst = parseMuster(eintrag);
    if (!geparst) continue;
    const schluessel = `${geparst.muster}|${geparst.betrag_min_cents}|${geparst.betrag_max_cents}`;
    if (gesehen.has(schluessel)) continue;
    gesehen.add(schluessel);
    run(`INSERT INTO lieferant_muster (lieferant_id, muster, betrag_min_cents, betrag_max_cents)
         VALUES (?, ?, ?, ?)`,
      Number(lieferantId), geparst.muster, geparst.betrag_min_cents, geparst.betrag_max_cents);
    angelegt.push(geparst);
  }
  return angelegt;
}

// --- Zuordnung der Buchungen -------------------------------------------------

/**
 * Ordnet die Buchungen eines Zeitraums den Lieferanten zu.
 * Verglichen wird gegen den normalisierten Text aus Empfaenger und
 * Verwendungszweck; das laengste passende Muster gewinnt, damit
 * "google cloud" vor "google" greift, wenn beide hinterlegt sind.
 */
export function ordneBuchungenZu(periodId) {
  const muster = all(
    `SELECT m.muster, m.lieferant_id, m.betrag_min_cents, m.betrag_max_cents
     FROM lieferant_muster m JOIN lieferanten l ON l.id = m.lieferant_id`,
  ).sort((a, b) => {
    // Der genauere Text gewinnt. Steht "Google Workspace" im Buchungstext,
    // schlaegt das jede Betragsregel - eine ausdrueckliche Angabe wiegt
    // schwerer als eine Groessenordnung.
    if (b.muster.length !== a.muster.length) return b.muster.length - a.muster.length;
    // Bei gleich langem Text entscheidet die engere Bedingung.
    return grenzen(b) - grenzen(a);
  });

  const buchungen = all('SELECT id, counterparty, purpose, amount_cents FROM bank_tx WHERE period_id = ?', Number(periodId));
  let zugeordnet = 0;

  for (const tx of buchungen) {
    // Zwei Lesarten des Buchungstexts: einmal mit abgestreiftem
    // Zahlungsdienstleister ("PayPal *Google" -> "google"), einmal roh
    // ("Stripe Payments" bleibt "stripe payments"). Der abgestreifte Text hat
    // Vorrang, damit eine Zahlung ueber einen Dienstleister beim tatsaechlichen
    // Haendler landet und nicht beim Dienstleister.
    const haendler = `${normalizeName(tx.counterparty)} ${normalizeName(tx.purpose)}`.trim();
    const roh = `${normalizeName(tx.counterparty, { psp: false })} ${normalizeName(tx.purpose, { psp: false })}`.trim();

    const passt = (m, text) => text.includes(m.muster) && betragPasst(m, tx.amount_cents);
    const treffer = muster.find((m) => passt(m, haendler))
                 ?? muster.find((m) => passt(m, roh));
    run('UPDATE bank_tx SET lieferant_id = ? WHERE id = ?', treffer ? treffer.lieferant_id : null, tx.id);
    if (treffer) zugeordnet++;
  }
  return { buchungen: buchungen.length, zugeordnet, ohne: buchungen.length - zugeordnet };
}

const grenzen = (m) => (m.betrag_min_cents != null ? 1 : 0) + (m.betrag_max_cents != null ? 1 : 0);

// Verglichen wird der Betrag ohne Vorzeichen - Ausgaben stehen im Auszug negativ.
export function betragPasst(m, cents) {
  if (m.betrag_min_cents == null && m.betrag_max_cents == null) return true;
  if (cents == null) return false;
  const betrag = Math.abs(cents);
  if (m.betrag_min_cents != null && betrag <= m.betrag_min_cents) return false;
  if (m.betrag_max_cents != null && betrag > m.betrag_max_cents) return false;
  return true;
}

// --- Monatsübersicht ---------------------------------------------------------

function monatszeile(lieferantId, periodId) {
  const vorhanden = get(
    'SELECT * FROM lieferant_monat WHERE lieferant_id = ? AND period_id = ?', lieferantId, periodId);
  if (vorhanden) return vorhanden;
  run('INSERT INTO lieferant_monat (lieferant_id, period_id) VALUES (?, ?)', lieferantId, periodId);
  return get('SELECT * FROM lieferant_monat WHERE lieferant_id = ? AND period_id = ?', lieferantId, periodId);
}

/**
 * Die Hauptansicht: je Lieferant, was die Bank sagt und was an Belegen da ist.
 */
export function monatsuebersicht(periodId) {
  const period = get('SELECT * FROM periods WHERE id = ?', Number(periodId));
  if (!period) throw new Error('Zeitraum nicht gefunden.');

  const zeilen = listeLieferanten({ nurAktive: true }).map((l) => {
    const stand = monatszeile(l.id, period.id);
    const bank = get(
      `SELECT COUNT(*) AS anzahl, COALESCE(SUM(amount_cents), 0) AS summe
       FROM bank_tx WHERE period_id = ? AND lieferant_id = ?`, period.id, l.id);
    const belege = get(
      `SELECT COUNT(*) AS anzahl, COALESCE(SUM(amount_cents), 0) AS summe
       FROM artifacts WHERE period_id = ? AND lieferant_id = ?`, period.id, l.id);
    // Ausgaben stehen im Auszug negativ, Belege positiv - deshalb wird der
    // Bankbetrag betragsmaessig verglichen.
    const differenz = Math.abs(bank.summe) - belege.summe;

    return {
      id: l.id, name: l.name, url: l.url, rechnungen_url: l.rechnungen_url,
      hat_secret: l.hat_secret, has_mfa: l.has_mfa, erwartet: l.erwartet, notizen: l.notizen,
      bank_anzahl: bank.anzahl, bank_summe_cents: bank.summe,
      belege_anzahl: belege.anzahl, belege_summe_cents: belege.summe,
      differenz_cents: differenz,
      // "stimmt" heisst: es gibt Belege und die Summen decken sich. Ein
      // Lieferant ohne jede Buchung und ohne Beleg ist schlicht ruhig.
      stimmt: belege.anzahl > 0 && differenz === 0,
      ruhig: bank.anzahl === 0 && belege.anzahl === 0,
      status: stand.status, erledigt_am: stand.erledigt_am, erledigt_von: stand.erledigt_von,
      notiz: stand.notiz,
    };
  });

  // Buchungen ohne Lieferant - daraus entstehen neue Lieferanten.
  const ohneZuordnung = all(
    `SELECT id, booking_date, counterparty, purpose, amount_cents
     FROM bank_tx WHERE period_id = ? AND lieferant_id IS NULL
     ORDER BY ABS(amount_cents) DESC`, period.id);

  const summe = (f) => zeilen.reduce((s, z) => s + z[f], 0);
  return {
    period,
    lieferanten: zeilen,
    ohne_zuordnung: ohneZuordnung,
    belege_ohne_lieferant: all(
      'SELECT id, filename FROM artifacts WHERE period_id = ? AND lieferant_id IS NULL', period.id),
    summen: {
      lieferanten: zeilen.length,
      erledigt: zeilen.filter((z) => z.status === 'erledigt').length,
      bank_summe_cents: summe('bank_summe_cents'),
      belege_summe_cents: summe('belege_summe_cents'),
      offene_differenz_cents: zeilen.reduce((s, z) => s + (z.status === 'erledigt' ? 0 : z.differenz_cents), 0),
    },
  };
}

/**
 * Buchungen und Belege eines Lieferanten in einem Monat - wird erst beim
 * Aufklappen geholt, damit die Monatsliste schlank bleibt.
 */
export function details(lieferantId, periodId) {
  return {
    buchungen: all(
      `SELECT id, booking_date, counterparty, purpose, amount_cents
       FROM bank_tx WHERE period_id = ? AND lieferant_id = ? ORDER BY booking_date, id`,
      Number(periodId), Number(lieferantId)),
    belege: all(
      `SELECT id, filename, amount_cents, doc_date, source, uploaded_at
       FROM artifacts WHERE period_id = ? AND lieferant_id = ? ORDER BY uploaded_at DESC`,
      Number(periodId), Number(lieferantId)),
  };
}

export function setzeStatus(lieferantId, periodId, status, { von = 'Admin', notiz } = {}) {
  if (!STATUS.includes(status)) throw new Error(`Unbekannter Status "${status}".`);
  monatszeile(Number(lieferantId), Number(periodId));
  const erledigt = status === 'erledigt';
  run(
    `UPDATE lieferant_monat
     SET status = ?, erledigt_am = ${erledigt ? "datetime('now')" : 'NULL'}, erledigt_von = ?
         ${notiz !== undefined ? ', notiz = ?' : ''}
     WHERE lieferant_id = ? AND period_id = ?`,
    status, erledigt ? von : null, ...(notiz !== undefined ? [notiz] : []),
    Number(lieferantId), Number(periodId),
  );
  return get('SELECT * FROM lieferant_monat WHERE lieferant_id = ? AND period_id = ?',
    Number(lieferantId), Number(periodId));
}

export { STATUS };
