// Tests für die Logik, die Geld trägt: Betragserkennung im Kontoauszug,
// Zuordnung zu Lieferanten, Monatsrollup und die steuerlichen Rechenwege.
//
// Läuft mit dem eingebauten Testrunner: npm test
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Eigene Datenbank je Testlauf, damit die Arbeitsdaten unberührt bleiben.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buchhaltung-test-'));
process.env.PORT = '0';
process.env.VAULT_PASSPHRASE = 'test-passphrase';
process.env.DATA_DIR = tempDir;

const { parseAmountToCents, parseDate, parseStatement } = await import('../src/services/bank/csv.js');
const { normalizeName, groupKeyFor } = await import('../src/services/bank/grouping.js');
const { BEWIRTUNG, REISEKOSTEN } = await import('../src/services/steuerregeln.js');
const { berechneVerpflegung } = await import('../src/services/docgen.js');
const { encryptSecret, decryptSecret } = await import('../src/services/vault.js');

describe('Beträge aus dem Kontoauszug', () => {
  test('deutsches Format', () => {
    assert.equal(parseAmountToCents('1.204,99'), 120499);
    assert.equal(parseAmountToCents('-84,20'), -8420);
    assert.equal(parseAmountToCents('96.750,48'), 9675048);
    assert.equal(parseAmountToCents('0,01'), 1);
  });

  test('englisches Format', () => {
    assert.equal(parseAmountToCents('1,204.99'), 120499);
    assert.equal(parseAmountToCents('-84.20'), -8420);
  });

  test('Soll- und Haben-Kennzeichen', () => {
    assert.equal(parseAmountToCents('84,20 S'), -8420, 'S bedeutet Soll, also Abgang');
    assert.equal(parseAmountToCents('84,20 H'), 8420);
  });

  test('Klammern bedeuten negativ', () => {
    assert.equal(parseAmountToCents('(84,20)'), -8420);
  });

  test('Währungszeichen und Leerzeichen stören nicht', () => {
    assert.equal(parseAmountToCents('  1.234,56 EUR '), 123456);
    assert.equal(parseAmountToCents('€ 59,50'), 5950);
  });

  // "1.000" ist zweideutig: deutsch tausend, englisch eins. In einem
  // Auszug mit zwei Nachkommastellen kann ein Trennzeichen mit genau drei
  // Ziffern dahinter nur Tausender gruppieren.
  test('einzelnes Trennzeichen mit drei Ziffern gruppiert Tausender', () => {
    assert.equal(parseAmountToCents('1.000'), 100000);
    assert.equal(parseAmountToCents('1,000'), 100000);
    assert.equal(parseAmountToCents('12.345'), 1234500);
    assert.equal(parseAmountToCents('84.20'), 8420, 'zwei Ziffern bleiben Nachkommastellen');
    assert.equal(parseAmountToCents('1234.56'), 123456);
  });

  test('mehrere Tausendergruppen ohne Nachkommastellen', () => {
    assert.equal(parseAmountToCents('1.234.567'), 123456700);
    assert.equal(parseAmountToCents('1.234.567,89'), 123456789);
  });

  test('Unlesbares ergibt null statt einer geratenen Zahl', () => {
    assert.equal(parseAmountToCents(''), null);
    assert.equal(parseAmountToCents('siehe Anlage'), null);
    assert.equal(parseAmountToCents(null), null);
  });

  // Rundung ist hier kein Schönheitsfehler: ein halber Cent je Buchung
  // summiert sich über einen Monat zu einer Differenz, die niemand findet.
  test('kein Rundungsdrift bei krummen Beträgen', () => {
    assert.equal(parseAmountToCents('0,005'), 1);
    assert.equal(parseAmountToCents('19,99'), 1999);
    assert.equal(parseAmountToCents('1.000.000,01'), 100000001);
  });
});

describe('Datumsformate', () => {
  test('deutsche und englische Schreibweise', () => {
    assert.equal(parseDate('03.08.2026'), '2026-08-03');
    assert.equal(parseDate('3.8.2026'), '2026-08-03');
    assert.equal(parseDate('03.08.26'), '2026-08-03');
    assert.equal(parseDate('2026-08-03'), '2026-08-03');
  });
  test('Unlesbares bleibt leer', () => {
    assert.equal(parseDate('irgendwann'), '');
    assert.equal(parseDate(''), '');
  });
});

describe('CSV-Import eines Kontoauszugs', () => {
  const csv = `"Kontonummer:";"DE02120300000000202051"
"Zeitraum:";"01.08.2026 - 31.08.2026"

"Buchungstag";"Wertstellung";"Beguenstigter/Zahlungspflichtiger";"Verwendungszweck";"Betrag";"Waehrung"
"03.08.2026";"03.08.2026";"Google Ireland Ltd";"Workspace August";"-59,50";"EUR"
"05.08.2026";"05.08.2026";"GOOGLE CLOUD EMEA";"Cloud 8823";"-1.204,99";"EUR"
"09.08.2026";"09.08.2026";"Telekom Deutschland GmbH";"Mobilfunk";"-84,20";"EUR"
"Summe";"";"";"";"";""
`;

  test('überspringt Vorspann und findet die Kopfzeile', () => {
    const r = parseStatement(Buffer.from(csv, 'utf8'));
    assert.equal(r.headerIndex, 2);
    assert.equal(r.mapping.amount, 4);
    assert.equal(r.delimiter, ';');
  });

  test('liest die Buchungen und verwirft die Summenzeile', () => {
    const r = parseStatement(Buffer.from(csv, 'utf8'));
    assert.equal(r.transaktionen.length, 3);
    assert.equal(r.verworfen.length, 1, 'die Summenzeile hat keinen Betrag und darf nicht als Buchung zählen');
    assert.equal(r.transaktionen[1].amount_cents, -120499);
    assert.equal(r.transaktionen[1].booking_date, '2026-08-05');
  });

  test('erkennt Latin-1 kodierte Dateien', () => {
    const latin1 = Buffer.from(csv.replace('Beguenstigter', 'Begünstigter'), 'latin1');
    const r = parseStatement(latin1);
    assert.equal(r.transaktionen.length, 3);
    assert.equal(r.transaktionen[0].counterparty, 'Google Ireland Ltd');
  });

  test('meldet fehlende Betragsspalte, statt still nichts zu tun', () => {
    assert.throws(() => parseStatement(Buffer.from('a;b\n1;2\n', 'utf8')), /nicht erkannt/);
  });
});

describe('Namensnormalisierung', () => {
  test('Rechtsformen und Umlaute', () => {
    assert.equal(normalizeName('Google Ireland Ltd'), 'google ireland');
    assert.equal(normalizeName('Müller & Söhne GmbH'), 'mueller soehne');
    assert.equal(normalizeName('Telekom Deutschland GmbH'), 'telekom deutschland');
  });
  test('Zahlungsdienstleister werden durchgereicht', () => {
    assert.equal(normalizeName('PayPal *Google'), 'google');
    assert.equal(normalizeName('PP.1234.PP / Stripe Acme'), 'acme');
  });
  test('generische erste Wörter trennen nicht fälschlich zusammen', () => {
    assert.notEqual(groupKeyFor({ counterparty: 'Restaurant Adler' }),
                    groupKeyFor({ counterparty: 'Restaurant Krone' }));
  });
});

describe('Steuerliche Rechenwege', () => {
  test('Bewirtung 70/30 inklusive Trinkgeld', () => {
    const gesamt = 21840 + 2000;
    const abziehbar = Math.round(gesamt * BEWIRTUNG.abziehbar_anteil);
    assert.equal(gesamt, 23840);
    assert.equal(abziehbar, 16688);
    assert.equal(gesamt - abziehbar, 7152);
  });

  test('Verpflegungspauschalen mit Kürzung', () => {
    const r = berechneVerpflegung({ tage: [
      { datum: '2026-08-19', art: 'teil' },
      { datum: '2026-08-20', art: 'voll', fruehstueck: true },
      { datum: '2026-08-21', art: 'teil', fruehstueck: true },
    ]});
    assert.equal(r.tage[0].betrag_cents, REISEKOSTEN.pauschale_teiltag_cents);
    assert.equal(r.tage[1].betrag_cents, 2800 - 560);
    assert.equal(r.summe_cents, 1400 + 2240 + 840);
  });

  test('Kürzung kann die Pauschale nicht unter null drücken', () => {
    const r = berechneVerpflegung({ tage: [
      { datum: '2026-08-20', art: 'teil', fruehstueck: true, mittagessen: true, abendessen: true },
    ]});
    assert.equal(r.tage[0].betrag_cents, 0, 'sonst entstünde eine negative Erstattung');
  });
});

describe('Tresor', () => {
  test('verschlüsselt und entschlüsselt', () => {
    const klartext = 'GeheimesPasswort123!äöü';
    const chiffre = encryptSecret(klartext);
    assert.notEqual(chiffre, klartext);
    assert.ok(!chiffre.includes('Geheim'));
    assert.equal(decryptSecret(chiffre), klartext);
  });
  test('gleiche Eingabe ergibt verschiedene Chiffren', () => {
    assert.notEqual(encryptSecret('abc'), encryptSecret('abc'), 'sonst wäre der Initialisierungsvektor fest');
  });
  test('leeres Geheimnis bleibt leer', () => {
    assert.equal(encryptSecret(''), null);
    assert.equal(decryptSecret(null), '');
  });
});
