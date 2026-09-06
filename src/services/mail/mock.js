import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config.js';

// Entwicklungs-Backend: schreibt jede Mail als .eml in data/outbox,
// damit der komplette Ablauf ohne echten Versand testbar ist.
export const name = 'mock';

export async function sendMail({ to, subject, body, from = config.mailFrom, replyTo }) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(config.outboxDir, `${stamp}-${to.replace(/[^a-z0-9]/gi, '_')}.eml`);
  const eml = [
    `From: ${from}`,
    `To: ${to}`,
    replyTo ? `Reply-To: ${replyTo}` : null,
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
  ].filter(Boolean).join('\n');
  fs.writeFileSync(file, eml, 'utf8');
  return { id: path.basename(file), driver: 'mock', file };
}

// Sucht im "Posteingang" nach einer Antwort auf ein Ticket. Im Mock-Betrieb
// liegt der Posteingang unter data/inbox - dort abgelegte Dateien, deren Name
// das Ticket enthaelt, gelten als Antwort.
export async function findReply(ticket) {
  const inbox = path.join(config.dataDir, 'inbox');
  fs.mkdirSync(inbox, { recursive: true });
  const hit = fs.readdirSync(inbox).find((f) => f.includes(ticket));
  if (!hit) return null;
  const datei = path.join(inbox, hit);
  return {
    id: hit,
    subject: hit,
    from: 'test@example.invalid',
    hasAttachment: true,
    anhaenge: [{ filename: hit, mime: 'message/rfc822', attachmentId: hit, size: fs.statSync(datei).size }],
    ladeAnhang: async () => fs.readFileSync(datei),
  };
}

/**
 * Mock-Postfach: jede Datei unter data/inbox gilt als eine Nachricht mit
 * einem Anhang. So laesst sich der gesamte Ablauf ohne Google pruefen.
 */
export async function sucheNachrichten() {
  const inbox = path.join(config.dataDir, 'inbox');
  fs.mkdirSync(inbox, { recursive: true });
  return fs.readdirSync(inbox).filter((f) => !f.startsWith('.')).map((f) => {
    const voll = path.join(inbox, f);
    const stat = fs.statSync(voll);
    return {
      id: f,
      subject: `Rechnung ${f}`,
      from: 'lieferant@example.invalid',
      datum: stat.mtime.toUTCString(),
      empfangen: stat.mtime.toISOString(),
      anhaenge: [{ filename: f, mime: mimeFuer(f), attachmentId: f, size: stat.size }],
    };
  });
}

export async function ladeAnhang(nachrichtId) {
  return fs.readFileSync(path.join(config.dataDir, 'inbox', nachrichtId));
}

function mimeFuer(name) {
  const e = String(name).toLowerCase().split('.').pop();
  return { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' }[e] || 'application/octet-stream';
}

export function describe() {
  return {
    driver: 'mock',
    outbox: config.outboxDir,
    ready: true,
    // Ein echtes Postfach ist das nicht - der Unterschied muss sichtbar sein,
    // sonst sieht "nichts gefunden" aus wie "keine Rechnungen da".
    echtesPostfach: false,
    hinweis: `Kein echtes Postfach angebunden. Gesucht wird im Ordner ${config.dataDir}/inbox. ` +
      'Für den Abruf aus Gmail: MAIL_DRIVER=gmail in der .env setzen und den Google-Zugang einrichten (docs/GOOGLE.md).',
  };
}
