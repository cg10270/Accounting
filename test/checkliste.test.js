// Tests für die Checkliste: Gliederung in Bereiche, Positionen je Lieferant
// und der Monatsrollup über beide Ebenen.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DB_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'buchhaltung-ck-')), 'test.sqlite');
process.env.VAULT_PASSPHRASE = 'test-passphrase';

const { run, get } = await import('../src/db.js');
const lf = await import('../src/services/lieferanten.js');
const ck = await import('../src/services/checkliste.js');

let periodId;

beforeEach(() => {
  for (const t of ['position_monat', 'positionen', 'bereiche', 'lieferant_muster', 'lieferant_monat',
                   'bank_tx', 'artifacts', 'lieferanten', 'bank_statements', 'periods']) run(`DELETE FROM ${t}`);
  run("INSERT INTO periods (year, month, label) VALUES (2026, 8, 'August')");
  periodId = get('SELECT id FROM periods').id;
  run('INSERT INTO bank_statements (period_id, filename) VALUES (?, ?)', periodId, 't.csv');
});

const buchung = (gegen, zweck, cents) => run(
  `INSERT INTO bank_tx (statement_id, period_id, booking_date, counterparty, purpose, amount_cents)
   VALUES ((SELECT id FROM bank_statements LIMIT 1), ?, '2026-08-05', ?, ?, ?)`,
  periodId, gegen, zweck, cents);

const beleg = (lieferantId, positionId, cents) => run(
  `INSERT INTO artifacts (period_id, lieferant_id, position_id, filename, amount_cents, source)
   VALUES (?, ?, ?, 'r.pdf', ?, 'manuell')`, periodId, lieferantId, positionId, cents);

describe('Gliederung', () => {
  test('ein Lieferant kann mehrere Positionen tragen', () => {
    const stripe = lf.legeAn({ name: 'Stripe' });
    const b = ck.legeBereichAn({ name: 'Stripe', nummer: 3 });
    for (const n of ['Rechnungen', 'Gutschriften', 'Payout Report']) {
      ck.legePositionAn({ bereich_id: b.id, name: n, lieferant_id: stripe.id });
    }
    const bereich = ck.monatsansicht(periodId).bereiche[0];
    assert.equal(bereich.gruppen.length, 1, 'alle drei stehen unter einem Lieferanten');
    assert.equal(bereich.gruppen[0].positionen.length, 3);
    assert.equal(bereich.anzahl, 3);
  });

  // Sonst sähe es aus, als fiele der Betrag je Zeile erneut an.
  test('der Bankbetrag zählt je Lieferant, nicht je Position', () => {
    const stripe = lf.legeAn({ name: 'Stripe' });
    const b = ck.legeBereichAn({ name: 'Stripe', nummer: 3 });
    for (const n of ['Rechnungen', 'Gutschriften']) {
      ck.legePositionAn({ bereich_id: b.id, name: n, lieferant_id: stripe.id });
    }
    buchung('Stripe Payments', 'Auszahlung', -1240000);
    lf.ordneBuchungenZu(periodId);

    const ansicht = ck.monatsansicht(periodId);
    assert.equal(ansicht.summen.bank_summe_cents, -1240000);
    assert.equal(ansicht.bereiche[0].gruppen[0].bank_anzahl, 1);
  });

  test('verschiedene Lieferanten im selben Bereich bleiben getrennt', () => {
    const b = ck.legeBereichAn({ name: 'Software & SaaS', nummer: 6 });
    for (const n of ['OpenAI', 'Anthropic']) {
      const l = lf.legeAn({ name: n });
      ck.legePositionAn({ bereich_id: b.id, name: n, lieferant_id: l.id });
    }
    assert.equal(ck.monatsansicht(periodId).bereiche[0].gruppen.length, 2);
  });

  test('Positionen ohne Lieferant stehen für sich', () => {
    const b = ck.legeBereichAn({ name: 'Monatsabschluss', nummer: 8 });
    ck.legePositionAn({ bereich_id: b.id, name: 'Monatsprüfung' });
    ck.legePositionAn({ bereich_id: b.id, name: 'Abgleich Bank / Belege' });

    const gruppen = ck.monatsansicht(periodId).bereiche[0].gruppen;
    assert.equal(gruppen.length, 2, 'jede freie Position bildet ihre eigene Gruppe');
    assert.equal(gruppen[0].lieferant, null);
  });

  test('leere Bereiche erscheinen nicht in der Monatsansicht', () => {
    ck.legeBereichAn({ name: 'Noch leer', nummer: 9 });
    assert.equal(ck.monatsansicht(periodId).bereiche.length, 0);
  });

  test('deaktivierte Positionen verschwinden aus der Ansicht', () => {
    const b = ck.legeBereichAn({ name: 'Personal', nummer: 2 });
    const p = ck.legePositionAn({ bereich_id: b.id, name: 'Lohnabrechnungen' });
    ck.legePositionAn({ bereich_id: b.id, name: 'Buchungsliste' });
    ck.aenderePosition(p.id, { aktiv: 0 });
    assert.equal(ck.monatsansicht(periodId).bereiche[0].anzahl, 1);
  });
});

describe('Abhaken', () => {
  function aufbau() {
    const l = lf.legeAn({ name: 'Stripe' });
    const b = ck.legeBereichAn({ name: 'Stripe', nummer: 3 });
    return {
      l,
      p1: ck.legePositionAn({ bereich_id: b.id, name: 'Rechnungen', lieferant_id: l.id }),
      p2: ck.legePositionAn({ bereich_id: b.id, name: 'Payout Report', lieferant_id: l.id }),
    };
  }

  test('Fortschritt zählt je Bereich', () => {
    const { p1 } = aufbau();
    ck.setzeStatus(p1.id, periodId, 'erledigt', { von: 'Christian' });
    const b = ck.monatsansicht(periodId).bereiche[0];
    assert.equal(b.erledigt, 1);
    assert.equal(b.anzahl, 2);
  });

  test('"entfällt" zählt als abgearbeitet, aber nicht als erledigt', () => {
    const { p1, p2 } = aufbau();
    ck.setzeStatus(p1.id, periodId, 'erledigt');
    ck.setzeStatus(p2.id, periodId, 'entfaellt');
    const ansicht = ck.monatsansicht(periodId);
    assert.equal(ansicht.bereiche[0].erledigt, 2);
    assert.equal(ansicht.bereiche[0].gruppen[0].positionen[1].status, 'entfaellt');
  });

  test('Abhaken hält Zeitpunkt und Person fest', () => {
    const { p1 } = aufbau();
    ck.setzeStatus(p1.id, periodId, 'erledigt', { von: 'Christian' });
    const p = ck.monatsansicht(periodId).bereiche[0].gruppen[0].positionen[0];
    assert.equal(p.erledigt_von, 'Christian');
    assert.ok(p.erledigt_am);
  });

  test('Zurücksetzen löscht den Erledigungsvermerk', () => {
    const { p1 } = aufbau();
    ck.setzeStatus(p1.id, periodId, 'erledigt', { von: 'Christian' });
    ck.setzeStatus(p1.id, periodId, 'offen');
    const p = ck.monatsansicht(periodId).bereiche[0].gruppen[0].positionen[0];
    assert.equal(p.erledigt_am, null);
  });

  // Eine bewusst abgehakte Abweichung soll nicht ewig in der Summe stehen.
  test('offene Differenz zählt nur unerledigte Gruppen', () => {
    const { l, p1, p2 } = aufbau();
    buchung('Stripe Payments', 'Auszahlung', -50000);
    lf.ordneBuchungenZu(periodId);
    assert.equal(ck.monatsansicht(periodId).summen.offene_differenz_cents, 50000);

    ck.setzeStatus(p1.id, periodId, 'erledigt');
    ck.setzeStatus(p2.id, periodId, 'erledigt');
    assert.equal(ck.monatsansicht(periodId).summen.offene_differenz_cents, 0);
  });

  test('der Stand gilt je Monat, nicht je Position insgesamt', () => {
    const { p1 } = aufbau();
    ck.setzeStatus(p1.id, periodId, 'erledigt');
    run("INSERT INTO periods (year, month, label) VALUES (2026, 9, 'September')");
    const september = get('SELECT id FROM periods WHERE month = 9').id;
    assert.equal(ck.monatsansicht(september).bereiche[0].gruppen[0].positionen[0].status, 'offen');
  });
});

describe('Belege an Positionen', () => {
  test('ein Beleg zählt an der Position und beim Lieferanten', () => {
    const l = lf.legeAn({ name: 'Stripe' });
    const b = ck.legeBereichAn({ name: 'Stripe', nummer: 3 });
    const p = ck.legePositionAn({ bereich_id: b.id, name: 'Rechnungen', lieferant_id: l.id });
    buchung('Stripe Payments', 'Auszahlung', -50000);
    lf.ordneBuchungenZu(periodId);
    beleg(l.id, p.id, 50000);

    const g = ck.monatsansicht(periodId).bereiche[0].gruppen[0];
    assert.equal(g.positionen[0].dateien.length, 1, 'sichtbar an der Position');
    assert.equal(g.belege_summe_cents, 50000, 'und gerechnet beim Lieferanten');
    assert.equal(g.stimmt, true);
  });
});
