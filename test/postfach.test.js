// Tests für die Postfachsuche: was als Beleg zählt und welcher Zeitraum gilt.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DB_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'buchhaltung-pf-')), 'test.sqlite');
process.env.VAULT_PASSPHRASE = 'test-passphrase';

const { istBelegkandidat, bereich } = await import('../src/services/postfach.js');

const anhang = (filename, mime, size) => ({ filename, mime, size, attachmentId: 'a' });

describe('Was als Beleg gilt', () => {
  test('PDFs immer, unabhängig von der Größe', () => {
    assert.equal(istBelegkandidat(anhang('Rechnung.pdf', 'application/pdf', 800)), true);
    assert.equal(istBelegkandidat(anhang('R-2026-08.PDF', 'application/pdf', 120000)), true);
  });

  test('XML für elektronische Rechnungen', () => {
    assert.equal(istBelegkandidat(anhang('zugferd-invoice.xml', 'application/xml', 4000)), true);
  });

  test('große Fotos von Quittungen', () => {
    assert.equal(istBelegkandidat(anhang('quittung.jpg', 'image/jpeg', 400_000)), true);
  });

  // Ohne diese Filter füllt sich die Ablage mit Signaturbildern, und der
  // Mensch sortiert dann von Hand aus, was das System hätte wegwerfen können.
  test('kleine Bilder sind Signaturbeiwerk, kein Beleg', () => {
    assert.equal(istBelegkandidat(anhang('bild.png', 'image/png', 4000)), false);
  });

  test('Logos und Signaturen werden am Namen erkannt', () => {
    assert.equal(istBelegkandidat(anhang('logo.png', 'image/png', 90_000)), false);
    assert.equal(istBelegkandidat(anhang('signature.jpg', 'image/jpeg', 90_000)), false);
    assert.equal(istBelegkandidat(anhang('image001.png', 'image/png', 90_000)), false);
  });

  test('Zertifikate und Kalendereinladungen nie', () => {
    assert.equal(istBelegkandidat(anhang('smime.p7s', 'application/pkcs7-signature', 5000)), false);
    assert.equal(istBelegkandidat(anhang('termin.ics', 'text/calendar', 2000)), false);
    assert.equal(istBelegkandidat(anhang('weiterleitung.eml', 'message/rfc822', 50_000)), false);
  });

  test('fremde Formate werden nicht übernommen', () => {
    assert.equal(istBelegkandidat(anhang('tabelle.xlsx', 'application/vnd.ms-excel', 50_000)), false);
    assert.equal(istBelegkandidat(anhang('', 'application/pdf', 5000)), false);
  });
});

describe('Zeitraum der Suche', () => {
  const august = { year: 2026, month: 8 };

  test('umfasst den Monat plus Nachlauf in den Folgemonat', () => {
    const b = bereich(august, 10);
    assert.match(b.query, /after:2026\/08\/01/);
    assert.match(b.query, /before:2026\/09\/11/);
    assert.match(b.query, /has:attachment/);
  });

  test('ohne Nachlauf endet er am Monatsersten', () => {
    assert.match(bereich(august, 0).query, /before:2026\/09\/01/);
  });

  test('Jahreswechsel wird richtig gerechnet', () => {
    const b = bereich({ year: 2026, month: 12 }, 10);
    assert.match(b.query, /after:2026\/12\/01/);
    assert.match(b.query, /before:2027\/01\/11/);
  });

  test('Februar in einem Schaltjahr', () => {
    const b = bereich({ year: 2028, month: 2 }, 0);
    assert.match(b.query, /after:2028\/02\/01/);
    assert.match(b.query, /before:2028\/03\/01/);
  });
});
