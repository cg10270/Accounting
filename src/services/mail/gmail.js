import { config } from '../../config.js';
import * as gmail from '../google/gmail.js';
import { ladeDienstkonto } from '../google/auth.js';

// Mailversand und Posteingangspruefung ueber Gmail, mit demselben Service
// Account wie die Drive-Ablage. Einrichtung siehe
// src/services/storage/googleDrive.js.

export const name = 'gmail';

export async function sendMail({ to, subject, body, from = config.mailFrom, replyTo }) {
  const ergebnis = await gmail.sendeNachricht({ von: from, an: to, betreff: subject, text: body, antwortAn: replyTo });
  return { id: ergebnis.id, driver: 'gmail', threadId: ergebnis.threadId };
}

/**
 * Sucht die Antwort auf ein Ticket im Postfach ACCOUNTING_INBOX.
 * Liefert zusaetzlich die Anhaenge, damit der eingegangene Beleg
 * unmittelbar in der Ablage landen kann.
 */
export async function findReply(ticket) {
  const antwort = await gmail.findeAntwort(ticket);
  if (!antwort) return null;
  return {
    id: antwort.id,
    subject: antwort.subject,
    from: antwort.from,
    hasAttachment: antwort.hasAttachment,
    anhaenge: antwort.anhaenge,
    // Wird erst aufgerufen, wenn der Anhang tatsaechlich abgelegt werden soll.
    ladeAnhang: (attachmentId) => gmail.ladeAnhang(antwort.id, attachmentId),
  };
}

/** Durchsucht das Buchhaltungspostfach. */
export async function sucheNachrichten({ query }, max) {
  return gmail.sucheNachrichten(query, max);
}

export async function ladeAnhang(nachrichtId, attachmentId) {
  return gmail.ladeAnhang(nachrichtId, attachmentId);
}

export function describe() {
  const fehlend = [];
  if (!config.googleServiceAccountJson) fehlend.push('GOOGLE_SERVICE_ACCOUNT_JSON');
  if (!config.googleImpersonateUser) fehlend.push('GOOGLE_IMPERSONATE_USER');

  let dienstkonto = '';
  if (!fehlend.length) {
    try { dienstkonto = ladeDienstkonto().client_email; }
    catch (err) { fehlend.push(err.message); }
  }
  return {
    driver: 'gmail',
    from: config.mailFrom,
    inbox: config.accountingInbox,
    dienstkonto,
    ready: fehlend.length === 0,
    echtesPostfach: true,
    ...(fehlend.length ? {
      fehlt: fehlend,
      hinweis: `Der Google-Zugang ist unvollständig: ${fehlend.join(', ')}. Prüfen mit: npm run google:check`,
    } : {}),
  };
}

export const pruefeEinrichtung = gmail.pruefeEinrichtung;
