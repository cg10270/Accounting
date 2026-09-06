// Tests für das Lieferantenmodell: Zuordnung der Buchungen und der
// Monatsrollup, der Bank und Belege gegenüberstellt.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buchhaltung-lf-'));
process.env.DB_FILE = path.join(tempDir, 'test.sqlite');
process.env.VAULT_PASSPHRASE = 'test-passphrase';

const { run, get, all } = await import('../src/db.js');
const lf = await import('../src/services/lieferanten.js');

let periodId;

function leereDatenbank() {
  for (const t of ['lieferant_muster', 'lieferant_monat', 'bank_tx', 'artifacts', 'lieferanten', 'bank_statements', 'periods']) {
    run(`DELETE FROM ${t}`);
  }
  run("INSERT INTO periods (year, month, label) VALUES (2026, 8, 'August')");
  periodId = get('SELECT id FROM periods').id;
  run('INSERT INTO bank_statements (period_id, filename) VALUES (?, ?)', periodId, 'test.csv');
}

const buchung = (counterparty, purpose, cents) => run(
  `INSERT INTO bank_tx (statement_id, period_id, booking_date, counterparty, purpose, amount_cents)
   VALUES ((SELECT id FROM bank_statements LIMIT 1), ?, '2026-08-05', ?, ?, ?)`,
  periodId, counterparty, purpose, cents);

const beleg = (lieferantId, name, cents) => run(
  `INSERT INTO artifacts (period_id, lieferant_id, filename, amount_cents, source)
   VALUES (?, ?, ?, ?, 'manuell')`, periodId, lieferantId, name, cents);

beforeEach(leereDatenbank);

describe('Zuordnung der Buchungen', () => {
  test('ordnet über den Namen zu, ohne dass ein Muster gepflegt werden muss', () => {
    lf.legeAn({ name: 'Telekom' });
    buchung('Telekom Deutschland GmbH', 'Mobilfunk', -8420);
    const r = lf.ordneBuchungenZu(periodId);
    assert.equal(r.zugeordnet, 1);
    assert.equal(r.ohne, 0);
  });

  test('fasst verschiedene Schreibweisen desselben Lieferanten zusammen', () => {
    lf.legeAn({ name: 'Google' });
    buchung('Google Ireland Ltd', 'Workspace', -5950);
    buchung('GOOGLE CLOUD EMEA', 'Cloud', -120499);
    buchung('PayPal *Google', 'Play Store', -999);
    lf.ordneBuchungenZu(periodId);

    const uebersicht = lf.monatsuebersicht(periodId);
    const google = uebersicht.lieferanten.find((l) => l.name === 'Google');
    assert.equal(google.bank_anzahl, 3);
    assert.equal(google.bank_summe_cents, -(5950 + 120499 + 999));
  });

  // Ohne diese Regel würde ein allgemeines Muster ein genaueres überstimmen
  // und Buchungen beim falschen Lieferanten landen.
  test('das längere Muster gewinnt', () => {
    lf.legeAn({ name: 'Amazon', muster: ['amazon'] });
    const aws = lf.legeAn({ name: 'AWS', muster: ['amazon web services'] });
    buchung('Amazon Web Services EMEA', 'Cloud', -50000);
    lf.ordneBuchungenZu(periodId);
    assert.equal(get('SELECT lieferant_id FROM bank_tx').lieferant_id, aws.id);
  });

  // Stripe ist bei uns beides: Zahlungsdienstleister und eigener Lieferant.
  // Würde der Name nur als Dienstleister-Präfix gelesen, bliebe von
  // "Stripe Payments" nur "payments" übrig und die Buchung fiele durch.
  test('ein Lieferant, der zugleich Zahlungsdienstleister ist, wird erkannt', () => {
    const stripe = lf.legeAn({ name: 'Stripe' });
    buchung('Stripe Payments UK Ltd', 'Auszahlung August', -1240000);
    buchung('STRIPE', 'Gebühren 08/2026', -4500);
    assert.equal(lf.ordneBuchungenZu(periodId).zugeordnet, 2);
    assert.equal(lf.monatsuebersicht(periodId).lieferanten[0].bank_anzahl, 2);
    assert.equal(get('SELECT lieferant_id FROM bank_tx LIMIT 1').lieferant_id, stripe.id);
  });

  // Umgekehrt darf das nicht dazu führen, dass eine Zahlung über einen
  // Dienstleister beim Dienstleister statt beim Händler landet.
  test('eine Zahlung über einen Dienstleister landet beim Händler', () => {
    const paypal = lf.legeAn({ name: 'PayPal' });
    const google = lf.legeAn({ name: 'Google' });
    buchung('PayPal *Google', 'Play Store', -999);
    lf.ordneBuchungenZu(periodId);
    assert.equal(get('SELECT lieferant_id FROM bank_tx').lieferant_id, google.id,
      'der abgestreifte Händlername hat Vorrang vor dem Dienstleister');
    assert.notEqual(get('SELECT lieferant_id FROM bank_tx').lieferant_id, paypal.id);
  });

  test('nicht zugeordnete Buchungen werden ausgewiesen, nicht verschluckt', () => {
    lf.legeAn({ name: 'Telekom' });
    buchung('Telekom Deutschland GmbH', 'Mobilfunk', -8420);
    buchung('Unbekannter Dienst AG', 'Rechnung 5', -1999);
    lf.ordneBuchungenZu(periodId);

    const u = lf.monatsuebersicht(periodId);
    assert.equal(u.ohne_zuordnung.length, 1);
    assert.equal(u.ohne_zuordnung[0].counterparty, 'Unbekannter Dienst AG');
  });

  test('eine Musteränderung ordnet beim nächsten Lauf neu zu', () => {
    const l = lf.legeAn({ name: 'Provider', muster: ['gibtesnicht'] });
    buchung('Hetzner Online GmbH', 'Server', -4500);
    assert.equal(lf.ordneBuchungenZu(periodId).zugeordnet, 0);

    lf.aendere(l.id, { muster: ['hetzner'] });
    assert.equal(lf.ordneBuchungenZu(periodId).zugeordnet, 1);
  });
});

describe('Betragsabhängige Muster', () => {
  test('Schreibweise wird eingelesen', () => {
    assert.deepEqual(lf.parseMuster('google >1000'), { muster: 'google', betrag_min_cents: 100000, betrag_max_cents: null });
    assert.deepEqual(lf.parseMuster('google <1000'), { muster: 'google', betrag_min_cents: null, betrag_max_cents: 100000 });
    assert.deepEqual(lf.parseMuster('google 50-200'), { muster: 'google', betrag_min_cents: 5000, betrag_max_cents: 20000 });
    assert.deepEqual(lf.parseMuster('google'), { muster: 'google', betrag_min_cents: null, betrag_max_cents: null });
    assert.equal(lf.parseMuster('  '), null);
  });

  test('deutsche Schreibweise mit Tausenderpunkt', () => {
    assert.equal(lf.parseMuster('google >1.000').betrag_min_cents, 100000);
    assert.equal(lf.parseMuster('google >1.234,50').betrag_min_cents, 123450);
  });

  // Bei uns gilt: große Google-Zahlungen sind immer Werbung.
  test('der Betrag trennt Werbung von Software, wo der Text es nicht tut', () => {
    const ads = lf.legeAn({ name: 'Google Ads', muster: ['google ads', 'google >1000'] });
    const workspace = lf.legeAn({ name: 'Google Workspace', muster: ['google workspace', 'google <1000'] });

    buchung('GOOGLE IRELAND LTD', 'Rechnung 8823', -215000);   // groß  -> Werbung
    buchung('GOOGLE IRELAND LTD', 'Rechnung 4711', -5950);     // klein -> Software
    lf.ordneBuchungenZu(periodId);

    const zeilen = all('SELECT lieferant_id, amount_cents FROM bank_tx ORDER BY ABS(amount_cents) DESC');
    assert.equal(zeilen[0].lieferant_id, ads.id);
    assert.equal(zeilen[1].lieferant_id, workspace.id);
  });

  // Sonst würde eine Jahresrechnung für Workspace als Werbung verbucht.
  test('ein ausdrücklicher Buchungstext schlägt die Betragsregel', () => {
    lf.legeAn({ name: 'Google Ads', muster: ['google ads', 'google >1000'] });
    const workspace = lf.legeAn({ name: 'Google Workspace', muster: ['google workspace', 'google <1000'] });

    buchung('GOOGLE IRELAND LTD', 'Google Workspace Jahresrechnung', -240000);
    lf.ordneBuchungenZu(periodId);
    assert.equal(get('SELECT lieferant_id FROM bank_tx').lieferant_id, workspace.id);
  });

  test('die Grenze selbst zählt nicht zum größeren Bereich', () => {
    const ads = lf.legeAn({ name: 'Google Ads', muster: ['google >1000'] });
    const workspace = lf.legeAn({ name: 'Google Workspace', muster: ['google <1000'] });
    buchung('GOOGLE IRELAND LTD', 'x', -100000);   // exakt 1.000,00
    lf.ordneBuchungenZu(periodId);
    assert.equal(get('SELECT lieferant_id FROM bank_tx').lieferant_id, workspace.id,
      'genau 1.000 EUR fällt noch unter "<1000", nicht unter ">1000"');
  });

  test('das Vorzeichen spielt keine Rolle', () => {
    const l = lf.legeAn({ name: 'Google Ads', muster: ['google >1000'] });
    buchung('GOOGLE IRELAND LTD', 'Gutschrift', 215000);   // Eingang statt Abgang
    lf.ordneBuchungenZu(periodId);
    assert.equal(get('SELECT lieferant_id FROM bank_tx').lieferant_id, l.id);
  });

  test('passt keine Betragsbedingung, bleibt die Buchung ohne Lieferant', () => {
    lf.legeAn({ name: 'Google Ads', muster: ['google >1000'] });
    buchung('GOOGLE IRELAND LTD', 'x', -5950);
    assert.equal(lf.ordneBuchungenZu(periodId).ohne, 1);
  });

  test('die Bedingung wird in der Oberfläche lesbar zurückgegeben', () => {
    const l = lf.legeAn({ name: 'Google Ads', muster: ['google >1000', 'google ads'] });
    assert.deepEqual(l.muster.map((m) => m.text), ['google >1.000', 'google ads']);
  });
});

describe('Monatsübersicht', () => {
  test('stellt Banksumme und Belegsumme gegenüber', () => {
    const l = lf.legeAn({ name: 'Google' });
    buchung('Google Ireland Ltd', 'Workspace', -9675048);
    lf.ordneBuchungenZu(periodId);
    beleg(l.id, 'rechnung.pdf', 9420000);

    const g = lf.monatsuebersicht(periodId).lieferanten[0];
    assert.equal(g.bank_summe_cents, -9675048);
    assert.equal(g.belege_summe_cents, 9420000);
    assert.equal(g.differenz_cents, 9675048 - 9420000, 'die Bank steht negativ, verglichen wird betragsmäßig');
    assert.equal(g.stimmt, false);
  });

  test('deckungsgleiche Summen gelten als stimmig', () => {
    const l = lf.legeAn({ name: 'Telekom' });
    buchung('Telekom Deutschland GmbH', 'Mobilfunk', -8420);
    lf.ordneBuchungenZu(periodId);
    beleg(l.id, 'r.pdf', 8420);

    const g = lf.monatsuebersicht(periodId).lieferanten[0];
    assert.equal(g.differenz_cents, 0);
    assert.equal(g.stimmt, true);
  });

  // Ein Beleg ohne erfassten Betrag darf nicht so aussehen, als stimme alles.
  test('Beleg ohne Betrag lässt die Differenz stehen', () => {
    const l = lf.legeAn({ name: 'Telekom' });
    buchung('Telekom Deutschland GmbH', 'Mobilfunk', -8420);
    lf.ordneBuchungenZu(periodId);
    beleg(l.id, 'r.pdf', null);

    const g = lf.monatsuebersicht(periodId).lieferanten[0];
    assert.equal(g.belege_anzahl, 1);
    assert.equal(g.differenz_cents, 8420);
    assert.equal(g.stimmt, false);
  });

  test('Lieferant ohne jede Bewegung ist ruhig, nicht fehlerhaft', () => {
    lf.legeAn({ name: 'Selten GmbH' });
    const g = lf.monatsuebersicht(periodId).lieferanten[0];
    assert.equal(g.ruhig, true);
    assert.equal(g.differenz_cents, 0);
  });

  test('Abhaken wird mit Zeitpunkt und Person festgehalten', () => {
    const l = lf.legeAn({ name: 'Telekom' });
    lf.setzeStatus(l.id, periodId, 'erledigt', { von: 'Christian' });
    const g = lf.monatsuebersicht(periodId).lieferanten[0];
    assert.equal(g.status, 'erledigt');
    assert.equal(g.erledigt_von, 'Christian');
    assert.ok(g.erledigt_am);
  });

  test('erledigte Lieferanten zählen nicht in die offene Differenz', () => {
    const a = lf.legeAn({ name: 'Alpha' });
    const b = lf.legeAn({ name: 'Beta' });
    buchung('Alpha GmbH', 'x', -10000);
    buchung('Beta GmbH', 'y', -20000);
    lf.ordneBuchungenZu(periodId);
    lf.setzeStatus(a.id, periodId, 'erledigt');

    const s = lf.monatsuebersicht(periodId).summen;
    assert.equal(s.erledigt, 1);
    assert.equal(s.offene_differenz_cents, 20000);
  });
});

describe('Stammdaten', () => {
  test('doppelte Namen werden abgewiesen', () => {
    lf.legeAn({ name: 'Google' });
    assert.throws(() => lf.legeAn({ name: 'Google' }), /existiert bereits/);
  });

  test('Passwort wird verschlüsselt abgelegt und nie zurückgegeben', () => {
    const l = lf.legeAn({ name: 'Portal', secret: 'GeheimesPasswort123' });
    assert.equal(l.secret, '••••••••');
    assert.equal(l.hat_secret, 1);
    const roh = get('SELECT secret_enc FROM lieferanten WHERE id = ?', l.id);
    assert.ok(!roh.secret_enc.includes('Geheim'));
  });

  test('leeres Passwortfeld beim Ändern lässt das Passwort unberührt', () => {
    const l = lf.legeAn({ name: 'Portal', secret: 'geheim' });
    const vorher = get('SELECT secret_enc FROM lieferanten WHERE id = ?', l.id).secret_enc;
    lf.aendere(l.id, { url: 'https://neu.example' });
    assert.equal(get('SELECT secret_enc FROM lieferanten WHERE id = ?', l.id).secret_enc, vorher);
  });

  test('gelöschter Lieferant nimmt Belege und Buchungen nicht mit', () => {
    const l = lf.legeAn({ name: 'Telekom' });
    buchung('Telekom Deutschland GmbH', 'Mobilfunk', -8420);
    lf.ordneBuchungenZu(periodId);
    beleg(l.id, 'r.pdf', 8420);

    lf.loesche(l.id);
    assert.equal(all('SELECT id FROM bank_tx').length, 1, 'Buchung bleibt bestehen');
    assert.equal(all('SELECT id FROM artifacts').length, 1, 'Beleg bleibt bestehen');
    assert.equal(get('SELECT lieferant_id FROM bank_tx').lieferant_id, null);
  });
});
