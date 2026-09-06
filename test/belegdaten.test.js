// Tests für das Nachtragen der Belegdaten: ein Upload darf nie daran
// scheitern, dass die KI nicht antwortet oder gar nicht eingerichtet ist.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DB_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'buchhaltung-bd-')), 'test.sqlite');
process.env.VAULT_PASSPHRASE = 'test-passphrase';
delete process.env.ANTHROPIC_API_KEY;

const { ergaenzeBelegdaten } = await import('../src/services/belegdaten.js');

const datei = { buffer: Buffer.from('%PDF-1.4'), mime: 'application/pdf', filename: 'Rechnung.pdf' };

describe('Belegdaten nachtragen', () => {
  test('ohne API-Key wird nichts ausgelesen, aber auch nichts geworfen', async () => {
    const r = await ergaenzeBelegdaten(1, datei);
    assert.equal(r.ki, false);
    assert.match(r.hinweis, /ANTHROPIC_API_KEY/);
  });

  test('nicht lesbare Dateitypen werden benannt statt versucht', async () => {
    const r = await ergaenzeBelegdaten(1, { ...datei, mime: 'application/xml', filename: 'zugferd.xml' });
    assert.equal(r.ki, false);
    assert.match(r.hinweis, /PDF, PNG und JPEG/);
  });
});

describe('Dubletten', () => {
  test('dieselbe Datei wird im selben Zeitraum nur einmal abgelegt', async () => {
    const { speichereDatei } = await import('../src/services/ablage.js');
    const { run, get, all } = await import('../src/db.js');

    run("INSERT INTO periods (year, month, label) VALUES (2026, 9, 'September 2026')");
    const periodId = get('SELECT id FROM periods WHERE year = 2026 AND month = 9').id;
    const buffer = Buffer.from('Rechnungsinhalt');

    const erst = await speichereDatei({
      periodId, filename: 'rechnung.pdf', mime: 'application/pdf', buffer, source: 'manuell',
    });
    const zweit = await speichereDatei({
      periodId, filename: 'rechnung-kopie.pdf', mime: 'application/pdf', buffer, source: 'manuell',
    });

    assert.equal(zweit.doppelt, true);
    assert.equal(zweit.id, erst.id);
    assert.equal(all('SELECT id FROM artifacts WHERE period_id = ?', periodId).length, 1);
  });
});
