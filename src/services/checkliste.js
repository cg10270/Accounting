import { all, get, run } from '../db.js';
import { listeLieferanten } from './lieferanten.js';

// Die monatliche Checkliste. Bereiche gliedern, Positionen werden abgehakt.
//
// Der Zuschnitt folgt der Wirklichkeit: aus einem Portal kommen oft mehrere
// Dokumente (Stripe liefert Rechnungen, Gutschriften, Payout Report ...).
// Anmeldung und Bankabgleich gehoeren deshalb zum Lieferanten, die Haekchen
// zu den einzelnen Positionen darunter.

const STATUS = ['offen', 'erledigt', 'entfaellt'];

// --- Stammdaten --------------------------------------------------------------

export function listeBereiche() {
  const bereiche = all('SELECT * FROM bereiche ORDER BY position, nummer');
  for (const b of bereiche) {
    b.positionen = all(
      `SELECT p.*, l.name AS lieferant_name
       FROM positionen p LEFT JOIN lieferanten l ON l.id = p.lieferant_id
       WHERE p.bereich_id = ? ORDER BY p.position, p.id`, b.id);
  }
  return bereiche;
}

export function legeBereichAn({ name, nummer }) {
  const sauber = String(name || '').trim();
  if (!sauber) throw new Error('Ein Name ist erforderlich.');
  if (get('SELECT id FROM bereiche WHERE name = ?', sauber)) throw new Error(`Der Bereich "${sauber}" existiert bereits.`);
  const max = get('SELECT COALESCE(MAX(position), 0) AS p, COALESCE(MAX(nummer), 0) AS n FROM bereiche');
  const r = run('INSERT INTO bereiche (nummer, name, position) VALUES (?, ?, ?)',
    Number(nummer) || max.n + 1, sauber, max.p + 1);
  return get('SELECT * FROM bereiche WHERE id = ?', Number(r.lastInsertRowid));
}

export function legePositionAn({ bereich_id, name, lieferant_id = null, hinweis = '' }) {
  const sauber = String(name || '').trim();
  if (!sauber) throw new Error('Ein Name ist erforderlich.');
  if (!get('SELECT id FROM bereiche WHERE id = ?', Number(bereich_id))) throw new Error('Bereich nicht gefunden.');
  const max = get('SELECT COALESCE(MAX(position), 0) AS p FROM positionen WHERE bereich_id = ?', Number(bereich_id));
  const r = run(
    'INSERT INTO positionen (bereich_id, lieferant_id, name, hinweis, position) VALUES (?, ?, ?, ?, ?)',
    Number(bereich_id), lieferant_id ? Number(lieferant_id) : null, sauber, hinweis, max.p + 1);
  return get('SELECT * FROM positionen WHERE id = ?', Number(r.lastInsertRowid));
}

export function aenderePosition(id, daten) {
  if (!get('SELECT id FROM positionen WHERE id = ?', Number(id))) throw new Error('Position nicht gefunden.');
  const felder = ['name', 'hinweis', 'bereich_id', 'lieferant_id', 'position', 'aktiv']
    .filter((f) => daten[f] !== undefined);
  if (felder.length) {
    run(`UPDATE positionen SET ${felder.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`,
      ...felder.map((f) => (f === 'lieferant_id' && !daten[f] ? null : daten[f])), Number(id));
  }
  return get('SELECT * FROM positionen WHERE id = ?', Number(id));
}

export function loeschePosition(id) {
  if (!get('SELECT id FROM positionen WHERE id = ?', Number(id))) throw new Error('Position nicht gefunden.');
  run('DELETE FROM positionen WHERE id = ?', Number(id));
  return { geloescht: Number(id) };
}

// --- Monatsansicht -----------------------------------------------------------

function standVon(positionId, periodId) {
  const vorhanden = get('SELECT * FROM position_monat WHERE position_id = ? AND period_id = ?', positionId, periodId);
  if (vorhanden) return vorhanden;
  run('INSERT INTO position_monat (position_id, period_id) VALUES (?, ?)', positionId, periodId);
  return get('SELECT * FROM position_monat WHERE position_id = ? AND period_id = ?', positionId, periodId);
}

/**
 * Die Hauptansicht: Bereiche, darin je Lieferant eine Gruppe mit dem
 * Bankabgleich, darunter die einzelnen Positionen mit ihren Haekchen.
 */
export function monatsansicht(periodId) {
  const period = get('SELECT * FROM periods WHERE id = ?', Number(periodId));
  if (!period) throw new Error('Zeitraum nicht gefunden.');

  const lieferanten = new Map(listeLieferanten().map((l) => [l.id, l]));
  const bereiche = [];

  for (const bereich of all('SELECT * FROM bereiche ORDER BY position, nummer')) {
    const positionen = all(
      'SELECT * FROM positionen WHERE bereich_id = ? AND aktiv = 1 ORDER BY position, id', bereich.id);
    if (!positionen.length) continue;

    // Positionen desselben Lieferanten stehen zusammen; der Bankabgleich
    // gilt fuer die Gruppe, nicht fuer jede Zeile einzeln - sonst saehe es
    // aus, als fiele der Betrag mehrfach an.
    const gruppen = new Map();
    for (const p of positionen) {
      const schluessel = p.lieferant_id ?? `frei-${p.id}`;
      if (!gruppen.has(schluessel)) gruppen.set(schluessel, { lieferant_id: p.lieferant_id, positionen: [] });

      const stand = standVon(p.id, period.id);
      gruppen.get(schluessel).positionen.push({
        id: p.id, name: p.name, hinweis: p.hinweis,
        status: stand.status, erledigt_am: stand.erledigt_am, erledigt_von: stand.erledigt_von,
        notiz: stand.notiz,
        dateien: all(
          `SELECT id, filename, amount_cents, source FROM artifacts
           WHERE period_id = ? AND position_id = ? ORDER BY uploaded_at DESC`, period.id, p.id),
      });
    }

    const gruppenListe = [...gruppen.values()].map((g) => {
      const lieferant = g.lieferant_id ? lieferanten.get(g.lieferant_id) : null;
      const bank = lieferant
        ? get(`SELECT COUNT(*) AS anzahl, COALESCE(SUM(amount_cents), 0) AS summe
               FROM bank_tx WHERE period_id = ? AND lieferant_id = ?`, period.id, lieferant.id)
        : { anzahl: 0, summe: 0 };
      const belege = lieferant
        ? get(`SELECT COUNT(*) AS anzahl, COALESCE(SUM(amount_cents), 0) AS summe
               FROM artifacts WHERE period_id = ? AND lieferant_id = ?`, period.id, lieferant.id)
        : { anzahl: 0, summe: 0 };
      const differenz = Math.abs(bank.summe) - belege.summe;

      return {
        lieferant: lieferant
          ? { id: lieferant.id, name: lieferant.name, url: lieferant.url,
              rechnungen_url: lieferant.rechnungen_url, hat_secret: lieferant.hat_secret,
              has_mfa: lieferant.has_mfa }
          : null,
        bank_anzahl: bank.anzahl, bank_summe_cents: bank.summe,
        belege_anzahl: belege.anzahl, belege_summe_cents: belege.summe,
        differenz_cents: differenz,
        stimmt: Boolean(lieferant) && belege.anzahl > 0 && differenz === 0,
        ruhig: bank.anzahl === 0 && belege.anzahl === 0,
        positionen: g.positionen,
      };
    });

    const alle = gruppenListe.flatMap((g) => g.positionen);
    bereiche.push({
      id: bereich.id, nummer: bereich.nummer, name: bereich.name,
      gruppen: gruppenListe,
      anzahl: alle.length,
      erledigt: alle.filter((p) => p.status !== 'offen').length,
    });
  }

  const allePositionen = bereiche.flatMap((b) => b.gruppen.flatMap((g) => g.positionen));
  const alleGruppen = bereiche.flatMap((b) => b.gruppen);

  return {
    period,
    bereiche,
    ohne_zuordnung: all(
      `SELECT id, booking_date, counterparty, purpose, amount_cents
       FROM bank_tx WHERE period_id = ? AND lieferant_id IS NULL
       ORDER BY ABS(amount_cents) DESC`, period.id),
    summen: {
      positionen: allePositionen.length,
      erledigt: allePositionen.filter((p) => p.status !== 'offen').length,
      bank_summe_cents: alleGruppen.reduce((s, g) => s + g.bank_summe_cents, 0),
      belege_summe_cents: alleGruppen.reduce((s, g) => s + g.belege_summe_cents, 0),
      // Offen zaehlt nur, was noch nicht abgehakt ist - sonst bliebe eine
      // bewusst erledigte Abweichung ewig in der Summe stehen.
      offene_differenz_cents: alleGruppen
        .filter((g) => g.positionen.some((p) => p.status === 'offen'))
        .reduce((s, g) => s + g.differenz_cents, 0),
    },
  };
}

export function setzeStatus(positionId, periodId, status, { von = 'Admin', notiz } = {}) {
  if (!STATUS.includes(status)) throw new Error(`Unbekannter Status "${status}".`);
  standVon(Number(positionId), Number(periodId));
  const erledigt = status === 'erledigt';
  run(
    `UPDATE position_monat
     SET status = ?, erledigt_am = ${erledigt ? "datetime('now')" : 'NULL'}, erledigt_von = ?
         ${notiz !== undefined ? ', notiz = ?' : ''}
     WHERE position_id = ? AND period_id = ?`,
    status, erledigt ? von : null, ...(notiz !== undefined ? [notiz] : []),
    Number(positionId), Number(periodId));
  return get('SELECT * FROM position_monat WHERE position_id = ? AND period_id = ?',
    Number(positionId), Number(periodId));
}

export { STATUS };
