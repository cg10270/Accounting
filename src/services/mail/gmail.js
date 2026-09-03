import { config } from '../../config.js';

// Gmail-Versand und Posteingangspruefung ueber denselben Service Account
// wie das Drive-Backend (Domain-Wide Delegation, Scopes gmail.send und
// gmail.readonly, handelnd als GOOGLE_IMPERSONATE_USER).
//
// Erledigungspruefung: jede Beleganfrage traegt ein Ticket im Betreff
// (Format ACC-<Jahr><Monat>-<laufend>). findReply() sucht im Postfach
// ACCOUNTING_INBOX nach einer Nachricht, die dieses Ticket enthaelt und
// einen Anhang mitbringt.

export const name = 'gmail';

function notConfigured() {
  throw new Error(
    'Gmail-Backend ist noch nicht konfiguriert. Bitte Service Account einrichten ' +
    'und die Gmail-Anbindung aktivieren (siehe src/services/mail/gmail.js).'
  );
}

export async function sendMail() { notConfigured(); }
export async function findReply() { notConfigured(); }

export function describe() {
  return {
    driver: 'gmail',
    from: config.mailFrom,
    inbox: config.accountingInbox,
    ready: false,
    hinweis: 'Service-Account-Anbindung noch nicht aktiviert.',
  };
}
