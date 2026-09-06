// Tests für den Abgleich Bank <-> Beleg. Ein Treffer verlangt dieselbe Firma
// UND denselben Betrag; bei mehreren Belegen derselben Firma entscheidet die
// Rechnungsnummer im Verwendungszweck.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DB_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'buchhaltung-ab-')), 'test.sqlite');
process.env.VAULT_PASSPHRASE = 'test-passphrase';

const { bewerte, betragPasst, umrechnungMoeglich, gleicheAb, uebersicht, markiereBuchungen } = await import('../src/services/abgleich.js');
const { vergleichsname } = await import('../src/services/marken.js');
const { pruefe } = await import('../src/services/beleganalyse.js');
const { run, get, all } = await import('../src/db.js');

const tx = (o) => ({ counterparty: '', purpose: '', booking_date: '2026-08-15', marke: '', ...o });
const beleg = (o) => ({ aussteller: '', marke: '', rechnungsnummer: '', doc_date: '2026-08-10', ...o });

describe('Wer steckt hinter dem Namen', () => {
  test('Facebook wird als Meta erkannt', () => {
    assert.equal(vergleichsname('FACEBK *ADS 4711'), 'meta');
    assert.equal(vergleichsname('Facebook Ireland Ltd'), 'meta');
  });

  test('der Zahlungsdienstleister verdeckt den Händler nicht', () => {
    assert.equal(vergleichsname('PayPal *Google'), 'google');
    assert.equal(vergleichsname('PAYPAL EUROPE'), 'paypal');
  });

  test('unbekannte Firmen behalten ihren Namen', () => {
    assert.equal(vergleichsname('Christoph Gerl'), 'christoph gerl');
  });
});

describe('Betragsvergleich', () => {
  test('exakt passt', () => assert.equal(betragPasst(18995, 18995), true));

  test('Rundung und Währungsumrechnung: 189,95 zu 189,92', () => {
    assert.equal(betragPasst(18995, 18992), true);
  });

  test('ein anderer Betrag passt nicht', () => {
    assert.equal(betragPasst(18995, 17500), false);
  });

  test('die Toleranz waechst mit dem Betrag - ein Prozent', () => {
    assert.equal(betragPasst(500, 495), true);    // 5 Cent auf 5 Euro
    assert.equal(betragPasst(500, 490), false);
    assert.equal(betragPasst(100000, 99100), false);  // hoechstens 5 Euro
  });
});

describe('Bewertung eines Paares', () => {
  test('gleiche Firma und gleicher Betrag ist ein Treffer', () => {
    const w = bewerte(tx({ counterparty: 'FACEBK *ADS', amount_cents: -18995 }),
      beleg({ marke: 'meta', amount_cents: 18995 }));
    assert.ok(w);
    assert.equal(w.exakt, true);
  });

  test('andere Firma ist kein Treffer, auch bei gleichem Betrag', () => {
    assert.equal(bewerte(tx({ counterparty: 'NFON AG', amount_cents: -18995 }),
      beleg({ marke: 'meta', amount_cents: 18995 })), null);
  });

  test('gleiche Firma, anderer Betrag ist kein Treffer', () => {
    assert.equal(bewerte(tx({ counterparty: 'FACEBK *ADS', amount_cents: -18995 }),
      beleg({ marke: 'meta', amount_cents: 9000 })), null);
  });

  test('Beleg ohne gelesenen Betrag wird nicht zugeordnet', () => {
    assert.equal(bewerte(tx({ counterparty: 'FACEBK *ADS', amount_cents: -18995 }),
      beleg({ marke: 'meta', amount_cents: null })), null);
  });

  test('die Rechnungsnummer im Verwendungszweck zählt zusätzlich', () => {
    const ohne = bewerte(tx({ counterparty: 'Meta', purpose: 'Zahlung', amount_cents: -10000 }),
      beleg({ marke: 'meta', rechnungsnummer: 'RE-1428', amount_cents: 10000 }));
    const mit = bewerte(tx({ counterparty: 'Meta', purpose: 'RE 1428', amount_cents: -10000 }),
      beleg({ marke: 'meta', rechnungsnummer: 'RE-1428', amount_cents: 10000 }));
    assert.ok(mit.punkte > ohne.punkte);
  });
});

describe('Ein ganzer Monat', () => {
  const periodId = (() => {
    run("INSERT INTO periods (year, month, label) VALUES (2026, 8, 'August 2026')");
    return get("SELECT id FROM periods WHERE year = 2026 AND month = 8").id;
  })();

  const statementId = (() => {
    run("INSERT INTO bank_statements (period_id, filename) VALUES (?, 'test.csv')", periodId);
    return get('SELECT id FROM bank_statements WHERE period_id = ?', periodId).id;
  })();

  const buchung = (counterparty, purpose, cents) => {
    run(`INSERT INTO bank_tx (statement_id, period_id, booking_date, counterparty, purpose, amount_cents)
         VALUES (?, ?, '2026-08-15', ?, ?, ?)`, statementId, periodId, counterparty, purpose, cents);
    return get('SELECT id FROM bank_tx ORDER BY id DESC LIMIT 1').id;
  };
  const belegAnlegen = (filename, marke, nummer, cents) => {
    run(`INSERT INTO artifacts (period_id, filename, marke, rechnungsnummer, amount_cents, doc_date)
         VALUES (?, ?, ?, ?, ?, '2026-08-10')`, periodId, filename, marke, nummer, cents);
    return get('SELECT id FROM artifacts ORDER BY id DESC LIMIT 1').id;
  };

  test('offene Buchungen bleiben stehen, zugeordnete verschwinden', () => {
    buchung('FACEBK *ADS 4711', 'Werbung', -18995);
    buchung('NFON AG', 'Telefonie 08/2026', -4500);
    belegAnlegen('meta.pdf', 'meta', 'FB-9', 18992);

    markiereBuchungen(periodId);
    const lauf = gleicheAb(periodId);
    assert.equal(lauf.vorschlaege, 1);

    const sicht = uebersicht(periodId);
    assert.equal(sicht.zahlen.offen, 1);
    assert.equal(sicht.offen[0].counterparty, 'NFON AG');
    assert.equal(sicht.erledigt.length, 1);
  });

  test('bei zwei Belegen derselben Firma entscheidet die Rechnungsnummer', () => {
    const txId = buchung('Christoph Gerl', 'Rechnung R260199', -50000);
    belegAnlegen('gerl-a.pdf', 'christoph gerl', 'R260198', 50000);
    const richtig = belegAnlegen('gerl-b.pdf', 'christoph gerl', 'R260199', 50000);

    markiereBuchungen(periodId);
    gleicheAb(periodId);

    const zugeordnet = all('SELECT artifact_id FROM belegzuordnung WHERE tx_id = ?', txId);
    assert.equal(zugeordnet.length, 1);
    assert.equal(zugeordnet[0].artifact_id, richtig);
  });

  test('eine verworfene Zuordnung kommt nicht zurück', () => {
    const z = get(`SELECT z.id FROM belegzuordnung z JOIN bank_tx t ON t.id = z.tx_id
                    WHERE t.counterparty = 'FACEBK *ADS 4711'`);
    run("UPDATE belegzuordnung SET status = 'verworfen' WHERE id = ?", z.id);
    gleicheAb(periodId);
    assert.equal(get('SELECT status FROM belegzuordnung WHERE id = ?', z.id).status, 'verworfen');
    assert.equal(all(`SELECT z.id FROM belegzuordnung z JOIN bank_tx t ON t.id = z.tx_id
                       WHERE t.counterparty = 'FACEBK *ADS 4711' AND z.status = 'vorschlag'`).length, 0);
  });
});

describe('Rechnungen in fremder Währung', () => {
  test('47,60 USD und 44,10 Euro abgebucht gehören zusammen', () => {
    assert.equal(umrechnungMoeglich(-4410, 4760), true);
  });

  test('ein ganz anderer Betrag nicht', () => {
    assert.equal(umrechnungMoeglich(-1200, 4760), false);
  });

  test('mit Währung greift der Treffer, ohne Währung nicht', () => {
    const buchung = tx({ counterparty: 'OPENAI', amount_cents: -4410, currency: 'EUR' });
    const inUsd = beleg({ marke: 'openai', amount_cents: 4760, waehrung: 'USD', doc_date: '2026-08-14' });
    const ohne = beleg({ marke: 'openai', amount_cents: 4760, doc_date: '2026-08-14' });
    assert.ok(bewerte(buchung, inUsd));
    assert.equal(bewerte(buchung, ohne), null);
  });

  test('ohne zeitliche Nähe zählt der umgerechnete Betrag nicht', () => {
    const buchung = tx({ counterparty: 'OPENAI', amount_cents: -4410, booking_date: '2026-08-15' });
    const weitWeg = beleg({ marke: 'openai', amount_cents: 4760, waehrung: 'USD', doc_date: '2026-06-01' });
    assert.equal(bewerte(buchung, weitWeg), null);
  });

  test('der exakte Euro-Treffer schlägt den umgerechneten', () => {
    const buchung = tx({ counterparty: 'OPENAI', amount_cents: -4410 });
    const exakt = bewerte(buchung, beleg({ marke: 'openai', amount_cents: 4410 }));
    const umgerechnet = bewerte(buchung, beleg({ marke: 'openai', amount_cents: 4760, waehrung: 'USD' }));
    assert.ok(exakt.punkte > umgerechnet.punkte);
  });
});

describe('Verstümmelte Antworten des Modells', () => {
  test('Bruchstücke der Werkzeugantwort landen nicht in den Feldern', () => {
    const muell = '</antml:parameter>';
    const r = pruefe({
      lesbar: true,
      aussteller: muell,
      rechnungsnummer: 'RE-1',
      datum: `${muell}0`,
      brutto_cents: 1234,
      waehrung: 'eur',
      marke: muell,
      leistung: 'Beratung',
      begruendung: 'x',
      lieferant: '',
    });
    assert.equal(r.aussteller, '');
    assert.equal(r.marke, '');
    assert.equal(r.datum, '');
    assert.equal(r.waehrung, 'EUR');
    assert.equal(r.rechnungsnummer, 'RE-1');
    assert.equal(r.brutto_cents, 1234);
  });

  test('ohne Aussteller und ohne Betrag gilt der Beleg als nicht lesbar', () => {
    const r = pruefe({ lesbar: true, aussteller: '', brutto_cents: 0, datum: '', rechnungsnummer: '' });
    assert.equal(r.lesbar, false);
    assert.match(r.hinweis, /weder Aussteller noch Betrag/);
  });
});

describe('Gruppierung der offenen Buchungen', () => {
  const periodId = (() => {
    run("INSERT INTO periods (year, month, label) VALUES (2026, 10, 'Oktober 2026')");
    return get('SELECT id FROM periods WHERE year = 2026 AND month = 10').id;
  })();
  run("INSERT INTO bank_statements (period_id, filename) VALUES (?, 'okt.csv')", periodId);
  const statementId = get('SELECT id FROM bank_statements WHERE period_id = ?', periodId).id;

  const buchung = (counterparty, cents) =>
    run(`INSERT INTO bank_tx (statement_id, period_id, booking_date, counterparty, purpose, amount_cents)
         VALUES (?, ?, '2026-10-15', ?, '', ?)`, statementId, periodId, counterparty, cents);

  test('gleiche Firma steht zusammen, alphabetisch, Buchungen einzeln', () => {
    buchung('OPENAI', -4410);
    buchung('OPENAI', -4420);
    buchung('FACEBK ADS', -10000);
    // Ein Beleg der Firma, den kein Betrag einer Buchung trifft.
    run(`INSERT INTO artifacts (period_id, filename, marke, amount_cents, doc_date)
         VALUES (?, 'sammelrechnung.pdf', 'openai', 9000, '2026-10-14')`, periodId);

    markiereBuchungen(periodId);
    gleicheAb(periodId);
    const sicht = uebersicht(periodId);
    const namen = sicht.gruppen.filter((g) => g.buchungen.length).map((g) => g.marke);
    assert.deepEqual(namen, ['meta', 'openai']);

    const openai = sicht.gruppen.find((g) => g.marke === 'openai');
    assert.equal(openai.buchungen.length, 2);
    assert.equal(openai.bank_cents, 8830);
    assert.equal(openai.belege_cents, 9000);
    assert.equal(openai.differenz_cents, -170);
  });
});
