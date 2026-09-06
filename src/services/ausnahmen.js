import { all, get, run } from '../db.js';
import { normalizeName } from './bank/grouping.js';

// Nicht zu jeder Abbuchung gehoert eine Eingangsrechnung.
//
// Loehne, Lohnsteuer, Krankenkassen und Berufsgenossenschaft werden von der
// Lohnbuchhaltung belegt und wandern als DATEV-Datei in die Buchhaltung; die
// Entgelte der eigenen Bank stehen im Kontoauszug selbst. Solche Buchungen in
// der Liste des Fehlenden zu fuehren, macht die Liste unbrauchbar.
//
// Die Muster sind Daten, keine Programmlogik: die Liste laesst sich in den
// Einstellungen erweitern, wenn ein neuer Dauerfall auftaucht.
export const VORGABEN = [
  ['lohn', 'Lohn und Gehalt - über die Lohnbuchhaltung belegt'],
  ['gehalt', 'Lohn und Gehalt - über die Lohnbuchhaltung belegt'],
  ['gehaelter', 'Lohn und Gehalt - über die Lohnbuchhaltung belegt'],
  ['entgeltabrechnung', 'Lohn und Gehalt - über die Lohnbuchhaltung belegt'],
  ['lohnsteuer', 'Lohnsteuer - über die Lohnbuchhaltung belegt'],
  ['kirchensteuer', 'Kirchensteuer - über die Lohnbuchhaltung belegt'],
  ['sozialversicherung', 'Sozialversicherung - über die Lohnbuchhaltung belegt'],
  ['sozialkasse', 'Sozialversicherung - über die Lohnbuchhaltung belegt'],
  ['sv beitrag', 'Sozialversicherung - über die Lohnbuchhaltung belegt'],
  ['krankenkasse', 'Krankenkasse - über die Lohnbuchhaltung belegt'],
  ['aok', 'Krankenkasse - über die Lohnbuchhaltung belegt'],
  ['barmer', 'Krankenkasse - über die Lohnbuchhaltung belegt'],
  ['techniker krankenkasse', 'Krankenkasse - über die Lohnbuchhaltung belegt'],
  ['dak', 'Krankenkasse - über die Lohnbuchhaltung belegt'],
  ['ikk', 'Krankenkasse - über die Lohnbuchhaltung belegt'],
  ['bkk', 'Krankenkasse - über die Lohnbuchhaltung belegt'],
  ['kkh', 'Krankenkasse - über die Lohnbuchhaltung belegt'],
  ['knappschaft', 'Krankenkasse - über die Lohnbuchhaltung belegt'],
  ['hkk', 'Krankenkasse - über die Lohnbuchhaltung belegt'],
  ['berufsgenossenschaft', 'Berufsgenossenschaft - über die Lohnbuchhaltung belegt'],
  ['vbg', 'Berufsgenossenschaft - über die Lohnbuchhaltung belegt'],
  ['bg etem', 'Berufsgenossenschaft - über die Lohnbuchhaltung belegt'],
  ['minijobzentrale', 'Minijobzentrale - über die Lohnbuchhaltung belegt'],
  ['deutsche rentenversicherung', 'Rentenversicherung - über die Lohnbuchhaltung belegt'],
  ['umlage u1', 'Sozialversicherung - über die Lohnbuchhaltung belegt'],
  ['pnl fintech', 'die eigene Bank - Entgelte stehen im Kontoauszug'],
];

/** Legt die Vorgaben an, ohne bestehende Eintraege zu veraendern. */
export function seed() {
  for (const [muster, grund] of VORGABEN) {
    run('INSERT INTO ausnahmen (muster, grund) VALUES (?, ?) ON CONFLICT (muster) DO NOTHING',
      normalizeName(muster, { psp: false }), grund);
  }
  return liste();
}

export const liste = () => all('SELECT * FROM ausnahmen ORDER BY muster');

export function lege(muster, grund = '') {
  const wert = normalizeName(muster, { psp: false });
  if (!wert) throw new Error('Das Muster ist leer.');
  run('INSERT INTO ausnahmen (muster, grund) VALUES (?, ?) ON CONFLICT (muster) DO UPDATE SET grund = excluded.grund, aktiv = 1',
    wert, grund);
  return get('SELECT * FROM ausnahmen WHERE muster = ?', wert);
}

export function loesche(id) {
  run('DELETE FROM ausnahmen WHERE id = ?', Number(id));
}

/**
 * Prueft eine Buchung gegen die Ausnahmen.
 * @returns {{muster: string, grund: string}|null}
 */
export function ausnahmeFuer(tx, ausnahmen = liste()) {
  const text = `${normalizeName(tx.counterparty, { psp: false })} ${normalizeName(tx.purpose, { psp: false })}`;
  for (const a of ausnahmen) {
    if (!a.aktiv || !a.muster) continue;
    if (text.includes(a.muster)) return { muster: a.muster, grund: a.grund };
  }
  return null;
}
