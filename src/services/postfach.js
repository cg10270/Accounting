import crypto from 'node:crypto';
import { all, get, run } from '../db.js';
import { config } from '../config.js';
import { mailer } from './mail/index.js';
import { speichereDatei } from './ablage.js';
import { normalizeName } from './bank/grouping.js';
import { listeLieferanten } from './lieferanten.js';

// Durchsucht das Buchhaltungspostfach nach Belegen und legt sie ab.
//
// Der Mensch entscheidet, was übernommen wird: die Suche schlägt vor, ordnet
// nach Möglichkeit einem Lieferanten zu und markiert, was schon einmal
// übernommen wurde. Nichts wandert ungefragt in die Ablage.

// Nur diese Formate kommen als Beleg in Frage.
const BELEGFORMATE = /pdf|png|jpe?g|xml/i;
// Signaturdateien und Zertifikate sind nie Belege.
const NIEMALS = /\.(p7s|p7m|asc|sig|vcf|ics|eml)$/i;
// Typische Namen von Logos und Signaturbildern.
const RAUSCHEN = /logo|signatur|signature|icon|banner|footer|image0\d\d|unbenannt|outlook-/i;
// Bilder unterhalb dieser Groesse sind praktisch immer Signaturbeiwerk.
const MIN_BILDGROESSE = 30 * 1024;

function istBelegkandidat(anhang) {
  const name = String(anhang.filename || '');
  if (!name || NIEMALS.test(name)) return false;
  if (!BELEGFORMATE.test(anhang.mime) && !BELEGFORMATE.test(name)) return false;

  const istBild = /image\//i.test(anhang.mime) || /\.(png|jpe?g)$/i.test(name);
  if (istBild && (anhang.size < MIN_BILDGROESSE || RAUSCHEN.test(name))) return false;
  return true;
}

// Zeitraum als Gmail-Suchausdruck. Rechnungen für einen Monat treffen oft erst
// in den ersten Tagen des Folgemonats ein - deshalb der Nachlauf.
export function bereich(period, nachlaufTage = 10) {
  const von = new Date(Date.UTC(period.year, period.month - 1, 1));
  const bis = new Date(Date.UTC(period.year, period.month, 1));
  bis.setUTCDate(bis.getUTCDate() + Number(nachlaufTage));
  const g = (d) => `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;
  return { von, bis, query: `has:attachment after:${g(von)} before:${g(bis)}` };
}

/**
 * Durchsucht das Postfach und liefert Vorschläge.
 * @param {number} periodId
 * @param {number} nachlaufTage  Tage in den Folgemonat hinein
 */
export async function durchsuche(periodId, { nachlaufTage = 10 } = {}) {
  const period = get('SELECT * FROM periods WHERE id = ?', Number(periodId));
  if (!period) throw new Error('Zeitraum nicht gefunden.');
  if (!mailer.sucheNachrichten) {
    throw new Error(`Der Mail-Zugang "${mailer.name}" kann das Postfach nicht durchsuchen.`);
  }

  const zugang = mailer.describe();
  if (zugang.ready === false) {
    throw new Error(zugang.hinweis || `Der Mail-Zugang "${mailer.name}" ist nicht einsatzbereit.`);
  }

  const { query, von, bis } = bereich(period, nachlaufTage);
  const nachrichten = await mailer.sucheNachrichten(query);

  const lieferanten = listeLieferanten({ nurAktive: true });
  const bereitsUebernommen = new Set(
    all('SELECT message_id, attachment_id FROM postfach_import').map((r) => `${r.message_id}|${r.attachment_id}`),
  );

  const kandidaten = [];
  let verworfen = 0;

  for (const n of nachrichten) {
    for (const anhang of n.anhaenge || []) {
      if (!istBelegkandidat(anhang)) { verworfen++; continue; }
      const schluessel = `${n.id}|${anhang.attachmentId}`;
      kandidaten.push({
        message_id: n.id,
        attachment_id: anhang.attachmentId,
        filename: anhang.filename,
        mime: anhang.mime,
        size: anhang.size,
        absender: n.from,
        betreff: n.subject,
        empfangen: n.empfangen || n.datum,
        schon_uebernommen: bereitsUebernommen.has(schluessel),
        lieferant: rateLieferant(n, anhang, lieferanten),
      });
    }
  }

  return {
    period,
    // Damit die Oberflaeche "nichts gefunden" von "nichts angebunden" trennen kann.
    zugang: { driver: zugang.driver, echtesPostfach: zugang.echtesPostfach !== false, hinweis: zugang.hinweis || '' },
    zeitraum: { von: von.toISOString().slice(0, 10), bis: bis.toISOString().slice(0, 10), query },
    nachrichten: nachrichten.length,
    kandidaten,
    neu: kandidaten.filter((k) => !k.schon_uebernommen).length,
    verworfen,
  };
}

// Ordnet über Absender, Betreff und Dateiname zu. Das längste passende Muster
// gewinnt, damit ein genauerer Treffer einen allgemeinen überstimmt.
//
// Eine Mail traegt keinen Betrag. Muster mit Betragsbedingung - bei Google
// unterscheiden sie Werbung von Software - lassen sich hier also nicht pruefen.
// Sie werden nur herangezogen, wenn kein betragsfreies Muster passt, und auch
// dann nur, wenn sie alle auf denselben Lieferanten zeigen. Sonst bleibt die
// Zuordnung offen: lieber der Mensch entscheidet, als dass geraten wird.
function rateLieferant(nachricht, anhang, lieferanten) {
  const roh = `${nachricht.from || ''} ${nachricht.subject || ''} ${anhang.filename || ''}`;
  const heuhaufen = `${normalizeName(roh)} ${normalizeName(roh, { psp: false })}`;

  const treffer = [];
  for (const l of lieferanten) {
    for (const m of l.muster) {
      if (!heuhaufen.includes(m.muster)) continue;
      const betragsgebunden = m.betrag_min_cents != null || m.betrag_max_cents != null;
      treffer.push({ id: l.id, name: l.name, laenge: m.muster.length, betragsgebunden });
    }
  }
  if (!treffer.length) return null;

  const sicher = treffer.filter((t) => !t.betragsgebunden);
  if (sicher.length) {
    const bester = sicher.reduce((a, b) => (b.laenge > a.laenge ? b : a));
    return { id: bester.id, name: bester.name };
  }

  const lieferantIds = new Set(treffer.map((t) => t.id));
  if (lieferantIds.size > 1) return null;   // mehrdeutig - der Mensch entscheidet
  return { id: treffer[0].id, name: treffer[0].name };
}

/**
 * Übernimmt ausgewählte Anhänge in die Ablage.
 * @param {number} periodId
 * @param {Array} auswahl  [{ message_id, attachment_id, filename, mime, lieferant_id, betrag_cents, doc_date }]
 */
export async function uebernimm(periodId, auswahl = []) {
  const period = get('SELECT * FROM periods WHERE id = ?', Number(periodId));
  if (!period) throw new Error('Zeitraum nicht gefunden.');

  const ergebnis = { uebernommen: [], uebersprungen: [], fehler: [] };

  for (const eintrag of auswahl) {
    const schluessel = { m: eintrag.message_id, a: eintrag.attachment_id };
    try {
      if (get('SELECT id FROM postfach_import WHERE message_id = ? AND attachment_id = ?', schluessel.m, schluessel.a)) {
        ergebnis.uebersprungen.push({ ...eintrag, grund: 'bereits übernommen' });
        continue;
      }

      const inhalt = await mailer.ladeAnhang(schluessel.m, schluessel.a);
      // Zweite Sicherung gegen Dubletten: derselbe Inhalt kann über zwei
      // verschiedene Mails hereinkommen (Original und Weiterleitung).
      const checksum = crypto.createHash('sha256').update(inhalt).digest('hex');
      const doppelt = get(
        'SELECT id, filename FROM artifacts WHERE period_id = ? AND checksum = ?', period.id, checksum);
      if (doppelt) {
        run(`INSERT INTO postfach_import (message_id, attachment_id, artifact_id, period_id, absender, betreff)
             VALUES (?, ?, ?, ?, ?, ?)`,
          schluessel.m, schluessel.a, doppelt.id, period.id, eintrag.absender || '', eintrag.betreff || '');
        ergebnis.uebersprungen.push({ ...eintrag, grund: `inhaltsgleich mit "${doppelt.filename}"` });
        continue;
      }

      const lieferant = eintrag.lieferant_id
        ? get('SELECT * FROM lieferanten WHERE id = ?', Number(eintrag.lieferant_id)) : null;

      const datei = await speichereDatei({
        periodId: period.id,
        lieferantId: lieferant?.id ?? null,
        filename: eintrag.filename,
        mime: eintrag.mime || 'application/octet-stream',
        buffer: inhalt,
        source: 'mail',
        ordner: lieferant ? lieferant.name : 'Postfach',
      });

      run('UPDATE artifacts SET vendor = ?, amount_cents = ?, doc_date = ? WHERE id = ?',
        lieferant?.name || '', eintrag.betrag_cents ?? null, eintrag.doc_date || null, datei.id);

      run(`INSERT INTO postfach_import (message_id, attachment_id, artifact_id, period_id, absender, betreff)
           VALUES (?, ?, ?, ?, ?, ?)`,
        schluessel.m, schluessel.a, datei.id, period.id, eintrag.absender || '', eintrag.betreff || '');

      ergebnis.uebernommen.push({ id: datei.id, filename: datei.filename, lieferant: lieferant?.name || null });
    } catch (err) {
      ergebnis.fehler.push({ ...eintrag, fehler: err.message });
    }
  }
  return ergebnis;
}

export { istBelegkandidat };
