import { get, run } from '../db.js';
import { aiEnabled } from '../config.js';
import { analysiereRechnung } from './beleganalyse.js';
import { listeLieferanten } from './lieferanten.js';

// Ergaenzt einen frisch hochgeladenen Beleg um die Angaben, die im Dokument
// stehen und nicht im Dateinamen: Betrag, Belegdatum, Aussteller.
//
// Ohne Betrag bleibt der Abgleich mit der Bank wertlos - die Differenz zeigt
// dann die volle Buchungssumme an, obwohl der Beleg laengst da ist.

// Nur diese Formate kann das Modell unmittelbar lesen.
const LESBAR = /pdf|png|jpe?g|webp/i;

/**
 * Liest den Beleg aus und traegt nach, was noch fehlt. Vorhandene Angaben
 * bleiben unangetastet - was der Mensch eingetragen hat, gilt.
 *
 * Wirft nie: ein Upload darf nicht daran scheitern, dass die KI nicht
 * antwortet. Der Rueckgabewert sagt, was passiert ist.
 *
 * @param {number} artifactId
 * @param {{buffer: Buffer, mime: string, filename: string}} datei
 */
export async function ergaenzeBelegdaten(artifactId, { buffer, mime, filename }) {
  // Der Dateityp entscheidet unabhaengig vom API-Key - eine XML-Rechnung
  // bleibt auch mit KI ungelesen, das soll die Meldung sagen.
  if (!LESBAR.test(`${mime || ''} ${filename || ''}`)) {
    return { ki: false, hinweis: `${filename}: nur PDF, PNG und JPEG können ausgelesen werden.` };
  }
  if (!aiEnabled) {
    return { ki: false, hinweis: 'Kein ANTHROPIC_API_KEY gesetzt - der Beleg wurde nicht ausgelesen.' };
  }

  const eintrag = get('SELECT * FROM artifacts WHERE id = ?', Number(artifactId));
  if (!eintrag) return { ki: false, hinweis: 'Datei nicht gefunden.' };

  let daten;
  try {
    daten = await analysiereRechnung({
      buffer,
      mime,
      filename,
      lieferanten: listeLieferanten({ nurAktive: true }).map((l) => ({ id: l.id, name: l.name })),
    });
  } catch (err) {
    return { ki: false, fehler: err.message };
  }

  const neu = {};
  if (eintrag.amount_cents == null && daten.brutto_cents) neu.amount_cents = daten.brutto_cents;
  if (!eintrag.doc_date && daten.datum) neu.doc_date = daten.datum;
  // Der Lieferant steht beim Upload ueber die Position schon fest; nur wenn
  // keiner hinterlegt ist, wird der Vorschlag der KI eingetragen.
  if (!eintrag.vendor && daten.lieferant) neu.vendor = daten.lieferant.name;

  const felder = Object.keys(neu);
  if (felder.length) {
    run(`UPDATE artifacts SET ${felder.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`,
      ...felder.map((f) => neu[f]), eintrag.id);
  }

  return {
    ki: true,
    lesbar: daten.lesbar,
    aussteller: daten.aussteller,
    rechnungsnummer: daten.rechnungsnummer,
    datum: daten.datum,
    brutto_cents: daten.brutto_cents,
    ust_cents: daten.ust_cents,
    waehrung: daten.waehrung,
    uebernommen: felder,
  };
}
