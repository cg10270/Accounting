import { all, get, run } from '../db.js';
import { vergleichsname } from './marken.js';
import { normalizeName } from './bank/grouping.js';

// Der Abgleich zwischen Kontoauszug und Belegen.
//
// Gefragt ist am Ende nur eines: zu welchen Bankbuchungen fehlt noch ein
// Beleg? Alles, was zusammengefunden hat, ist erledigt und muss nicht mehr
// angesehen werden.
//
// Ein Treffer verlangt zweierlei: dieselbe Firma UND denselben Betrag.
// Gibt es mehrere Belege derselben Firma mit passendem Betrag, entscheidet
// die Rechnungsnummer im Verwendungszweck, sonst der Abstand der Daten.

// Waehrungsumrechnung und Rundung der Bank lassen kleine Abweichungen zu:
// 189,95 auf dem Konto und 189,92 auf der Rechnung sind derselbe Vorgang.
// Ein Prozent, hoechstens fuenf Euro - darueber ist es ein anderer Betrag.
export function toleranz(cents) {
  return Math.min(500, Math.max(2, Math.round(Math.abs(cents) * 0.01)));
}

// Rechnungen in fremder Waehrung nennen einen ganz anderen Betrag als der
// Kontoauszug: 47,60 USD werden zu rund 44 Euro abgebucht. Der Wechselkurs
// samt Auslandsentgelt liegt erfahrungsgemaess in dieser Spanne. Weil das
// deutlich unschaerfer ist als ein Betragsvergleich in Euro, zaehlt ein
// solcher Treffer weniger und wird in der Begruendung benannt.
const FREMD_MIN = 0.75;
const FREMD_MAX = 1.05;

export function betragPasst(a, b) {
  const diff = Math.abs(Math.abs(a) - Math.abs(b));
  return diff <= toleranz(a);
}

/** Kann der Buchungsbetrag die Umrechnung des Belegbetrags sein? */
export function umrechnungMoeglich(buchungCents, belegCents) {
  const buchung = Math.abs(buchungCents);
  const beleg = Math.abs(belegCents);
  if (!buchung || !beleg) return false;
  const kurs = buchung / beleg;
  return kurs >= FREMD_MIN && kurs <= FREMD_MAX;
}

// Rechnungsnummern stehen im Verwendungszweck mal mit, mal ohne Trennzeichen.
const kompakt = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function nummerImText(nummer, text) {
  const n = kompakt(nummer);
  // Zu kurze "Nummern" (etwa "7") treffen ueberall zu und sagen nichts.
  return n.length >= 4 && kompakt(text).includes(n);
}

const tage = (a, b) => {
  if (!a || !b) return null;
  const d = (new Date(b) - new Date(a)) / 86400000;
  return Number.isFinite(d) ? Math.abs(Math.round(d)) : null;
};

/**
 * Bewertet ein Paar aus Buchung und Beleg. null = kein Treffer.
 * Die Punktzahl entscheidet nur, welcher Beleg zu welcher Buchung passt,
 * wenn mehrere in Frage kommen.
 */
export function bewerte(tx, beleg) {
  if (beleg.amount_cents == null) return null;

  const txName = tx.marke || vergleichsname(`${tx.counterparty} ${tx.purpose}`);
  const belegName = beleg.marke || vergleichsname(beleg.aussteller || beleg.vendor || '');
  if (!txName || !belegName) return null;

  let punkte = 0;
  const gruende = [];
  if (txName === belegName) { punkte += 50; gruende.push(`Firma: ${belegName}`); }
  else if (txName.includes(belegName) || belegName.includes(txName)) { punkte += 35; gruende.push(`Firma ähnlich: ${belegName} / ${txName}`); }
  else return null;

  const fremdwaehrung = beleg.waehrung && beleg.waehrung !== (tx.currency || 'EUR');
  const diff = Math.abs(Math.abs(tx.amount_cents) - Math.abs(beleg.amount_cents));
  if (diff === 0) { punkte += 50; gruende.push('Betrag exakt'); }
  else if (betragPasst(tx.amount_cents, beleg.amount_cents)) {
    punkte += 30;
    gruende.push(`Betrag ${(diff / 100).toFixed(2)} € abweichend (Umrechnung/Rundung)`);
  } else if (fremdwaehrung && umrechnungMoeglich(tx.amount_cents, beleg.amount_cents)) {
    punkte += 15;
    gruende.push(`Rechnung lautet auf ${beleg.waehrung} `
      + `${(Math.abs(beleg.amount_cents) / 100).toFixed(2)} - Betrag umgerechnet, bitte prüfen`);
  } else return null;

  if (nummerImText(beleg.rechnungsnummer, `${tx.purpose} ${tx.counterparty}`)) {
    punkte += 25;
    gruende.push(`Rechnungsnummer ${beleg.rechnungsnummer} im Verwendungszweck`);
  }

  const abstand = tage(beleg.doc_date, tx.booking_date);
  if (abstand != null) {
    if (abstand <= 40) punkte += Math.max(0, 10 - Math.floor(abstand / 5));
    gruende.push(`${abstand} Tage zwischen Beleg und Buchung`);
  }

  // Ein umgerechneter Betrag allein traegt nicht: ohne zeitliche Naehe koennte
  // jede Rechnung derselben Firma gemeint sein.
  if (fremdwaehrung && diff !== 0 && !betragPasst(tx.amount_cents, beleg.amount_cents)
      && (abstand == null || abstand > 20)) return null;

  return { punkte, begruendung: gruende.join(' · '), exakt: diff === 0, unsicher: punkte < 70 };
}

/**
 * Baut die Zuordnungen eines Monats neu auf.
 * Bestaetigte und verworfene Zuordnungen bleiben unberuehrt - eine
 * Entscheidung des Menschen darf ein erneuter Lauf nicht ueberschreiben.
 */
export function gleicheAb(periodId) {
  const pid = Number(periodId);
  run("DELETE FROM belegzuordnung WHERE period_id = ? AND status = 'vorschlag'", pid);

  const fest = all(
    "SELECT tx_id, artifact_id, status FROM belegzuordnung WHERE period_id = ?", pid);
  const belegtTx = new Set(fest.filter((z) => z.status === 'bestaetigt').map((z) => z.tx_id));
  const belegtBeleg = new Set(fest.filter((z) => z.status === 'bestaetigt').map((z) => z.artifact_id));
  const verworfen = new Set(fest.filter((z) => z.status === 'verworfen').map((z) => `${z.tx_id}|${z.artifact_id}`));

  const buchungen = all('SELECT * FROM bank_tx WHERE period_id = ? ORDER BY booking_date, id', pid)
    .filter((tx) => !belegtTx.has(tx.id));
  const belege = all('SELECT * FROM artifacts WHERE period_id = ? AND amount_cents IS NOT NULL', pid)
    .filter((b) => !belegtBeleg.has(b.id));

  // Alle moeglichen Paare bewerten und die besten zuerst vergeben. So bekommt
  // der eindeutige Treffer den Beleg, nicht der zufaellig zuerst gepruefte.
  const paare = [];
  for (const tx of buchungen) {
    for (const beleg of belege) {
      if (verworfen.has(`${tx.id}|${beleg.id}`)) continue;
      const wert = bewerte(tx, beleg);
      if (wert) paare.push({ tx, beleg, ...wert });
    }
  }
  paare.sort((a, b) => b.punkte - a.punkte);

  const vergebenTx = new Set();
  const vergebenBeleg = new Set();
  let angelegt = 0;
  for (const p of paare) {
    if (vergebenTx.has(p.tx.id) || vergebenBeleg.has(p.beleg.id)) continue;
    vergebenTx.add(p.tx.id);
    vergebenBeleg.add(p.beleg.id);
    run(`INSERT INTO belegzuordnung (period_id, tx_id, artifact_id, quelle, status, punkte, begruendung)
         VALUES (?, ?, ?, 'automatisch', 'vorschlag', ?, ?)`,
      pid, p.tx.id, p.beleg.id, p.punkte, p.begruendung);
    angelegt++;
  }
  return { vorschlaege: angelegt, buchungen: buchungen.length, belege: belege.length };
}

const zuordnungenJoin = `
  SELECT z.*, a.filename, a.aussteller, a.marke AS beleg_marke, a.rechnungsnummer,
         a.amount_cents AS beleg_betrag, a.waehrung, a.doc_date, a.web_url
    FROM belegzuordnung z JOIN artifacts a ON a.id = z.artifact_id
   WHERE z.period_id = ? AND z.status != 'verworfen'`;

/**
 * Die Arbeitsansicht: was fehlt noch?
 * Zugeordnete Buchungen wandern in "erledigt" und werden nicht mehr gezeigt.
 */
export function uebersicht(periodId) {
  const pid = Number(periodId);
  const buchungen = all('SELECT * FROM bank_tx WHERE period_id = ? ORDER BY booking_date, id', pid);
  const zuordnungen = all(zuordnungenJoin, pid);
  const nachTx = new Map();
  for (const z of zuordnungen) {
    if (!nachTx.has(z.tx_id)) nachTx.set(z.tx_id, []);
    nachTx.get(z.tx_id).push(z);
  }

  const offen = [];
  const erledigt = [];
  // Geldeingaenge sind Kundenzahlungen und Erstattungen - dafuer gibt es keine
  // Eingangsrechnung zu beschaffen. Sie wuerden die Liste der fehlenden
  // Belege nur aufblaehen und die Summe unbrauchbar machen.
  const eingaenge = buchungen.filter((tx) => tx.amount_cents >= 0);
  for (const tx of buchungen.filter((tx) => tx.amount_cents < 0)) {
    const belege = nachTx.get(tx.id) || [];
    const zeile = {
      ...tx,
      anzeige: tx.marke || vergleichsname(`${tx.counterparty} ${tx.purpose}`),
      belege,
      // Ein Vorschlag ist geprueft, sobald ihn jemand bestaetigt hat.
      bestaetigt: belege.some((b) => b.status === 'bestaetigt'),
      angefragt: get(
        "SELECT ticket, status, recipient FROM logbook WHERE tx_id = ? AND type = 'belegabruf' ORDER BY id DESC LIMIT 1",
        tx.id),
    };
    (belege.length ? erledigt : offen).push(zeile);
  }

  const zugeordnet = new Set(zuordnungen.map((z) => z.artifact_id));
  const ohneBuchung = all(
    `SELECT id, filename, aussteller, marke, rechnungsnummer, amount_cents, waehrung, doc_date, analyse_fehler
       FROM artifacts WHERE period_id = ? ORDER BY doc_date, id`, pid,
  ).filter((b) => !zugeordnet.has(b.id));

  const summe = (liste, feld) => liste.reduce((s, x) => s + Math.abs(Number(x[feld] || 0)), 0);

  // Nach Firma gruppieren: bei Sammelrechnungen und vielen Kleinbetraegen -
  // Meta, OpenAI, Anthropic - findet der Abgleich Buchung und Beleg oft nicht
  // paarweise zusammen. Dann hilft die Gegenueberstellung der Summen: stimmt
  // sie, ist der Monat fuer diese Firma vollstaendig, auch ohne Einzelpaare.
  const gruppen = new Map();
  const gruppe = (name) => {
    const schluessel = name || 'ohne Namen';
    if (!gruppen.has(schluessel)) {
      gruppen.set(schluessel, { marke: schluessel, buchungen: [], belege: [] });
    }
    return gruppen.get(schluessel);
  };
  for (const tx of offen) gruppe(tx.anzeige).buchungen.push(tx);
  for (const b of ohneBuchung) gruppe(b.marke || vergleichsname(b.aussteller || '')).belege.push(b);

  const gruppenliste = [...gruppen.values()]
    .map((g) => {
      const bank = summe(g.buchungen, 'amount_cents');
      const belege = summe(g.belege, 'amount_cents');
      return {
        ...g,
        bank_cents: bank,
        belege_cents: belege,
        // Positiv heisst: es fehlen Belege. Negativ: es liegen mehr Belege vor
        // als die Bank hergibt - etwa weil sie schon einer Buchung zugeordnet
        // sind oder anders bezahlt wurden.
        differenz_cents: bank - belege,
      };
    })
    .sort((a, b) => a.marke.localeCompare(b.marke, 'de'));

  return {
    offen,
    erledigt,
    ohneBuchung,
    gruppen: gruppenliste,
    zahlen: {
      buchungen: buchungen.length,
      ausgaben: offen.length + erledigt.length,
      eingaenge: eingaenge.length,
      eingaenge_cents: summe(eingaenge, 'amount_cents'),
      offen: offen.length,
      erledigt: erledigt.length,
      offen_cents: summe(offen, 'amount_cents'),
      belege_ohne_buchung: ohneBuchung.length,
      belege_ohne_betrag: ohneBuchung.filter((b) => b.amount_cents == null).length,
    },
  };
}

/** Bestaetigt oder verwirft eine Zuordnung. */
export function entscheide(zuordnungId, status) {
  if (!['bestaetigt', 'verworfen', 'vorschlag'].includes(status)) {
    throw new Error(`Unbekannter Status "${status}".`);
  }
  const z = get('SELECT * FROM belegzuordnung WHERE id = ?', Number(zuordnungId));
  if (!z) throw new Error('Zuordnung nicht gefunden.');
  run('UPDATE belegzuordnung SET status = ? WHERE id = ?', status, z.id);
  return get('SELECT * FROM belegzuordnung WHERE id = ?', z.id);
}

/** Verbindet Buchung und Beleg von Hand - der Abgleich laesst das stehen. */
export function verbinde(txId, artifactId) {
  const tx = get('SELECT * FROM bank_tx WHERE id = ?', Number(txId));
  if (!tx) throw new Error('Buchung nicht gefunden.');
  const beleg = get('SELECT * FROM artifacts WHERE id = ?', Number(artifactId));
  if (!beleg) throw new Error('Beleg nicht gefunden.');

  run(`INSERT INTO belegzuordnung (period_id, tx_id, artifact_id, quelle, status, punkte, begruendung)
       VALUES (?, ?, ?, 'manuell', 'bestaetigt', 100, 'von Hand verbunden')
       ON CONFLICT (tx_id, artifact_id)
       DO UPDATE SET status = 'bestaetigt', quelle = 'manuell', begruendung = 'von Hand verbunden'`,
    tx.period_id, tx.id, beleg.id);
  return get('SELECT * FROM belegzuordnung WHERE tx_id = ? AND artifact_id = ?', tx.id, beleg.id);
}

/** Traegt die Marke an allen Buchungen eines Monats nach. */
export function markiereBuchungen(periodId) {
  const pid = Number(periodId);
  let gesetzt = 0;
  for (const tx of all('SELECT id, counterparty, purpose, marke FROM bank_tx WHERE period_id = ?', pid)) {
    const name = vergleichsname(`${tx.counterparty} ${tx.purpose}`);
    if (name && name !== tx.marke) { run('UPDATE bank_tx SET marke = ? WHERE id = ?', name, tx.id); gesetzt++; }
  }
  return gesetzt;
}

export { normalizeName };
