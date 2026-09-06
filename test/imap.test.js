// Tests für den IMAP-Zugang. Geprüft wird die Logik, die ohne Server auskommt:
// Datumsgrenzen der Suche und das Herauslesen der Anhänge aus dem Aufbau
// einer Nachricht. Die Verbindung selbst lässt sich hier nicht prüfen.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DB_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'buchhaltung-imap-')), 'test.sqlite');
process.env.VAULT_PASSPHRASE = 'test-passphrase';
process.env.IMAP_USER = 'accounting@lexaid.net';

const { baueSuchkriterien, sammleAnhaenge, zuNachricht } = await import('../src/services/mail/imap.js');
const { bereich } = await import('../src/services/postfach.js');

describe('Zeitraum der IMAP-Suche', () => {
  test('deckt sich mit dem Zeitraum der Gmail-Suche', () => {
    const b = bereich({ year: 2026, month: 8 }, 10);
    const k = baueSuchkriterien(b);
    assert.equal(k.since.toISOString().slice(0, 10), '2026-08-01');
    assert.equal(k.before.toISOString().slice(0, 10), '2026-09-11');
  });

  test('Jahreswechsel', () => {
    const k = baueSuchkriterien(bereich({ year: 2026, month: 12 }, 10));
    assert.equal(k.since.toISOString().slice(0, 10), '2026-12-01');
    assert.equal(k.before.toISOString().slice(0, 10), '2027-01-11');
  });
});

describe('Anhänge aus dem Aufbau einer Nachricht', () => {
  // So sieht eine typische Rechnungsmail aus: Text, HTML-Fassung mit
  // eingebettetem Signaturbild, dazu die eigentliche Rechnung als PDF.
  const aufbau = {
    type: 'multipart', subtype: 'mixed', childNodes: [
      { type: 'multipart', subtype: 'related', childNodes: [
        { type: 'text', subtype: 'plain', part: '1.1', size: 800 },
        { type: 'text', subtype: 'html', part: '1.2', size: 4000 },
        { type: 'image', subtype: 'png', part: '1.3', size: 12000,
          disposition: 'inline', parameters: { name: 'logo.png' } },
      ]},
      { type: 'application', subtype: 'pdf', part: '2', size: 84000,
        disposition: 'attachment', dispositionParameters: { filename: 'Rechnung 2026-08.pdf' } },
    ],
  };

  test('findet den echten Anhang mit Teilnummer und Größe', () => {
    const a = sammleAnhaenge(aufbau);
    assert.equal(a.length, 1);
    assert.deepEqual(a[0], {
      filename: 'Rechnung 2026-08.pdf', mime: 'application/pdf', attachmentId: '2', size: 84000,
    });
  });

  // Ein eingebettetes Signaturbild ist kein Anhang - sonst landet in jeder
  // Mail das Firmenlogo in der Vorschlagsliste.
  test('eingebettete Bilder zählen nicht als Anhang', () => {
    assert.equal(sammleAnhaenge(aufbau).some((a) => a.filename === 'logo.png'), false);
  });

  test('Anhänge ohne Disposition, aber mit Namen zählen mit', () => {
    const a = sammleAnhaenge({ type: 'application', subtype: 'pdf', part: '1', size: 5000,
      parameters: { name: 'beleg.pdf' } });
    assert.equal(a.length, 1);
    assert.equal(a[0].filename, 'beleg.pdf');
  });

  test('mehrere Anhänge in tiefer Verschachtelung', () => {
    const a = sammleAnhaenge({ type: 'multipart', childNodes: [
      { type: 'multipart', childNodes: [
        { type: 'application', subtype: 'pdf', part: '1.1', disposition: 'attachment',
          dispositionParameters: { filename: 'a.pdf' }, size: 10 },
      ]},
      { type: 'application', subtype: 'xml', part: '2', disposition: 'attachment',
        dispositionParameters: { filename: 'b.xml' }, size: 20 },
    ]});
    assert.deepEqual(a.map((x) => x.filename), ['a.pdf', 'b.xml']);
  });

  test('eine Nachricht ohne Anhang liefert eine leere Liste', () => {
    assert.deepEqual(sammleAnhaenge({ type: 'text', subtype: 'plain', part: '1' }), []);
    assert.deepEqual(sammleAnhaenge(null), []);
  });
});

describe('Umsetzung einer IMAP-Nachricht', () => {
  test('Kopfdaten und Anhänge werden übernommen', () => {
    const n = zuNachricht({
      uid: 4711,
      envelope: {
        subject: 'Ihre Rechnung August',
        date: new Date('2026-08-14T09:30:00Z'),
        from: [{ name: 'Stripe', address: 'billing@stripe.com' }],
      },
      bodyStructure: { type: 'application', subtype: 'pdf', part: '1', size: 900,
        disposition: 'attachment', dispositionParameters: { filename: 'r.pdf' } },
    });
    assert.equal(n.id, '4711', 'die Kennung ist die UID, damit der Anhang später abrufbar bleibt');
    assert.equal(n.subject, 'Ihre Rechnung August');
    assert.equal(n.from, 'Stripe <billing@stripe.com>');
    assert.equal(n.empfangen, '2026-08-14T09:30:00.000Z');
    assert.equal(n.anhaenge.length, 1);
  });

  test('fehlende Kopfdaten stürzen nicht ab', () => {
    const n = zuNachricht({ uid: 1, envelope: {}, bodyStructure: null });
    assert.equal(n.subject, '(ohne Betreff)');
    assert.equal(n.from, '');
    assert.deepEqual(n.anhaenge, []);
  });

  test('Absender ohne Anzeigenamen', () => {
    const n = zuNachricht({ uid: 2, envelope: { from: [{ address: 'noreply@example.com' }] } });
    assert.equal(n.from, 'noreply@example.com');
  });
});
