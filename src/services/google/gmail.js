import { config } from '../../config.js';
import { googleAbruf, SCOPES } from './auth.js';

// Versand und Posteingangspruefung ueber die Gmail-Schnittstelle,
// handelnd im Namen von GOOGLE_IMPERSONATE_USER.

function url(pfad, parameter = {}) {
  const u = new URL(config.gmailApi + pfad);
  for (const [k, v] of Object.entries(parameter)) if (v !== undefined) u.searchParams.set(k, v);
  return u.toString();
}

// Betreffzeilen duerfen nur ASCII enthalten. Umlaute und das Euro-Zeichen
// werden deshalb nach RFC 2047 kodiert - sonst kommt Zeichensalat an.
function kodiereBetreff(betreff) {
  const text = String(betreff ?? '');
  if (/^[\x20-\x7E]*$/.test(text)) return text;
  return `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`;
}

// Adressen mit Anzeigenamen ebenfalls kodieren, den Adressteil aber unberuehrt lassen.
function kodiereAdresse(adresse) {
  const m = String(adresse ?? '').match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (!m || !m[1]) return String(adresse ?? '').trim();
  return `${kodiereBetreff(m[1])} <${m[2]}>`;
}

export function baueNachricht({ von, an, betreff, text, antwortAn }) {
  const kopf = [
    `From: ${kodiereAdresse(von)}`,
    `To: ${kodiereAdresse(an)}`,
    antwortAn ? `Reply-To: ${kodiereAdresse(antwortAn)}` : null,
    `Subject: ${kodiereBetreff(betreff)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
  ].filter(Boolean).join('\r\n');

  // Base64-Zeilen auf 76 Zeichen umbrechen, wie es der Standard verlangt.
  const rumpf = Buffer.from(String(text ?? ''), 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
  return `${kopf}\r\n\r\n${rumpf}`;
}

export async function sendeNachricht({ von = config.mailFrom, an, betreff, text, antwortAn }) {
  const roh = Buffer.from(baueNachricht({ von, an, betreff, text, antwortAn }), 'utf8').toString('base64url');
  const ergebnis = await googleAbruf(url('/users/me/messages/send'), {
    scopes: SCOPES.gmailSend,
    methode: 'POST',
    kopfzeilen: { 'Content-Type': 'application/json' },
    koerper: JSON.stringify({ raw: roh }),
  });
  return { id: ergebnis.id, threadId: ergebnis.threadId };
}

const kopfzeile = (nachricht, name) =>
  nachricht.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';

// Anhaenge koennen beliebig tief in verschachtelten Teilen liegen.
function sammleAnhaenge(teil, gesammelt = []) {
  if (!teil) return gesammelt;
  if (teil.filename && teil.body?.attachmentId) {
    gesammelt.push({
      filename: teil.filename,
      mime: teil.mimeType || 'application/octet-stream',
      attachmentId: teil.body.attachmentId,
      size: Number(teil.body.size || 0),
    });
  }
  for (const unterteil of teil.parts || []) sammleAnhaenge(unterteil, gesammelt);
  return gesammelt;
}

/**
 * Sucht im Posteingang nach einer Antwort auf ein Ticket.
 * "in:inbox" schliesst die eigene, gesendete Nachricht aus.
 */
export async function findeAntwort(ticket) {
  const treffer = await googleAbruf(
    url('/users/me/messages', { q: `in:inbox "${ticket}"`, maxResults: '10' }),
    { scopes: SCOPES.gmailRead },
  );
  if (!treffer.messages?.length) return null;

  // Es kann mehrere Antworten geben - die mit Anhang ist die gesuchte.
  let ohneAnhang = null;
  for (const { id } of treffer.messages) {
    const nachricht = await googleAbruf(url(`/users/me/messages/${id}`, { format: 'full' }), { scopes: SCOPES.gmailRead });
    const anhaenge = sammleAnhaenge(nachricht.payload);
    const treffer1 = {
      id: nachricht.id,
      subject: kopfzeile(nachricht, 'Subject'),
      from: kopfzeile(nachricht, 'From'),
      datum: kopfzeile(nachricht, 'Date'),
      hasAttachment: anhaenge.length > 0,
      anhaenge,
    };
    if (anhaenge.length) return treffer1;
    ohneAnhang ??= treffer1;
  }
  return ohneAnhang;
}

/**
 * Durchsucht das Postfach und liefert Nachrichten samt ihrer Anhaenge.
 * @param {string} query  Gmail-Suchausdruck, z.B. 'has:attachment after:2026/08/01'
 */
export async function sucheNachrichten(query, maxNachrichten = 300) {
  const gefunden = [];
  let seite;

  do {
    const treffer = await googleAbruf(
      url('/users/me/messages', { q: query, maxResults: '100', ...(seite ? { pageToken: seite } : {}) }),
      { scopes: SCOPES.gmailRead },
    );
    for (const { id } of treffer.messages || []) {
      if (gefunden.length >= maxNachrichten) break;
      const nachricht = await googleAbruf(
        url(`/users/me/messages/${id}`, { format: 'full' }), { scopes: SCOPES.gmailRead });
      gefunden.push({
        id: nachricht.id,
        subject: kopfzeile(nachricht, 'Subject'),
        from: kopfzeile(nachricht, 'From'),
        datum: kopfzeile(nachricht, 'Date'),
        // internalDate ist Millisekunden seit Epoche und zuverlaessiger als
        // der Date-Kopf, den Absender frei setzen koennen.
        empfangen: nachricht.internalDate ? new Date(Number(nachricht.internalDate)).toISOString() : '',
        anhaenge: sammleAnhaenge(nachricht.payload),
      });
    }
    seite = treffer.nextPageToken;
  } while (seite && gefunden.length < maxNachrichten);

  return gefunden;
}

export async function ladeAnhang(nachrichtId, attachmentId) {
  const ergebnis = await googleAbruf(
    url(`/users/me/messages/${nachrichtId}/attachments/${attachmentId}`),
    { scopes: SCOPES.gmailRead },
  );
  return Buffer.from(ergebnis.data || '', 'base64url');
}

// Prueft die Einrichtung: Zugriff auf das Postfach mit Lese- und Senderecht.
export async function pruefeEinrichtung() {
  const profil = await googleAbruf(url('/users/me/profile'), { scopes: [SCOPES.gmailRead, SCOPES.gmailSend] });
  return { postfach: profil.emailAddress, nachrichten: profil.messagesTotal };
}
