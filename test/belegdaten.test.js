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
