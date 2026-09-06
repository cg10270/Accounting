import { config } from '../../config.js';

// Zugang zum Buchhaltungspostfach über IMAP, Versand über SMTP.
//
// Gedacht für ein App-Passwort: in den Google-Kontoeinstellungen erzeugt,
// gilt nur für dieses Programm und lässt sich einzeln widerrufen. Kein
// Cloud-Projekt, keine domainweite Delegierung.
//
// Beim Durchsuchen werden bewusst nur Kopfdaten und der Aufbau der Nachricht
// geladen, nicht die Anhänge selbst - sonst zöge eine Monatssuche schnell
// hunderte Megabyte. Heruntergeladen wird erst, was du auswählst.

export const name = 'imap';

// Anhänge werden als "<uid>" und "<teilnummer>" adressiert; die Postfachsuche
// kennt nur "message_id" und "attachment_id" und muss davon nichts wissen.

async function ladeImapFlow() {
  try { return (await import('imapflow')).ImapFlow; }
  catch { throw new Error('Die Bibliothek imapflow fehlt. Bitte "npm install" ausführen.'); }
}

function pruefeEinstellungen() {
  const fehlend = [];
  if (!config.imapUser) fehlend.push('IMAP_USER');
  if (!config.imapPasswort) fehlend.push('IMAP_PASSWORT');
  if (fehlend.length) {
    throw new Error(
      `In der .env fehlen: ${fehlend.join(', ')}. ` +
      'IMAP_PASSWORT ist ein App-Passwort aus den Google-Kontoeinstellungen, nicht das Kontopasswort. ' +
      'Prüfen mit: npm run mail:check',
    );
  }
}

async function mitVerbindung(arbeit) {
  pruefeEinstellungen();
  const ImapFlow = await ladeImapFlow();
  const client = new ImapFlow({
    host: config.imapHost,
    port: config.imapPort,
    secure: true,
    auth: { user: config.imapUser, pass: config.imapPasswort },
    logger: false,
    // Ohne Zeitgrenzen haengt die Oberflaeche, wenn der Server nicht antwortet -
    // etwa weil eine Firewall den Port sperrt. Lieber eine klare Meldung nach
    // wenigen Sekunden als ein Browser, der sich endlos dreht.
    connectionTimeout: config.imapTimeoutMs,
    greetingTimeout: config.imapTimeoutMs,
    // Das Durchsuchen eines vollen Postfachs darf laenger dauern als das Verbinden.
    socketTimeout: config.imapTimeoutMs * 4,
  });

  try {
    await client.connect();
  } catch (err) {
    throw new Error(uebersetzeFehler(err));
  }

  const schloss = await client.getMailboxLock(config.imapPostfach);
  try {
    return await arbeit(client);
  } finally {
    schloss.release();
    await client.logout().catch(() => {});
  }
}

// IMAP-Server melden knapp; die Ursache liegt fast immer in der Einrichtung.
function uebersetzeFehler(err) {
  const text = String(err?.responseText || err?.message || err);
  if (/AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed/i.test(text)) {
    return `Anmeldung am Postfach ${config.imapUser} fehlgeschlagen. Häufigste Ursachen: ` +
      'es wurde das Kontopasswort statt eines App-Passworts eingetragen, das App-Passwort ' +
      'enthält noch Leerzeichen, oder für das Konto ist keine Zwei-Faktor-Bestätigung aktiv ' +
      '(ohne die gibt es keine App-Passwörter). ' +
      `(Meldung des Servers: ${text.slice(0, 160)})`;
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(text)) {
    return `Der Server ${config.imapHost} ist nicht erreichbar. Bitte IMAP_HOST prüfen und die Internetverbindung.`;
  }
  if (/required time|timed? ?out|ETIMEDOUT/i.test(text)) {
    return `Der Server ${config.imapHost}:${config.imapPort} hat nicht rechtzeitig geantwortet. ` +
      'Meist blockiert eine Firewall den Port, oder IMAP ist in der Workspace-Admin-Konsole ' +
      'für die Domain abgeschaltet (Apps > Google Workspace > Gmail > Zugriff für IMAP). ' +
      'Bei einer langsamen Verbindung hilft ein höherer Wert für IMAP_TIMEOUT_MS in der .env.';
  }
  if (/ECONNREFUSED/i.test(text)) {
    return `Keine Verbindung zu ${config.imapHost}:${config.imapPort}. Möglicherweise blockiert eine Firewall den Zugriff, ` +
      'oder IMAP ist in der Workspace-Admin-Konsole für die Domain abgeschaltet.';
  }
  return `Verbindung zum Postfach fehlgeschlagen: ${text.slice(0, 200)}`;
}

// --- Reine Logik, ohne Netz --------------------------------------------------

/**
 * IMAP kennt die Suchsprache von Gmail nicht, sondern nur Datumsgrenzen.
 * SINCE und BEFORE arbeiten tagesgenau; BEFORE ist ausschliessend, genau wie
 * der Gmail-Ausdruck, den die Postfachsuche sonst verwendet.
 */
export function baueSuchkriterien({ von, bis }) {
  return { since: new Date(von), before: new Date(bis) };
}

// Anhänge stecken verschachtelt im Aufbau der Nachricht.
export function sammleAnhaenge(knoten, gesammelt = []) {
  if (!knoten) return gesammelt;

  const dateiname = knoten.dispositionParameters?.filename || knoten.parameters?.name || '';
  const istAnhang = knoten.disposition === 'attachment' || (dateiname && knoten.disposition !== 'inline');

  if (istAnhang && dateiname) {
    gesammelt.push({
      filename: dateiname,
      mime: [knoten.type, knoten.subtype].filter(Boolean).join('/') || 'application/octet-stream',
      attachmentId: knoten.part || '1',
      size: Number(knoten.size || 0),
    });
  }
  for (const kind of knoten.childNodes || []) sammleAnhaenge(kind, gesammelt);
  return gesammelt;
}

// Aus einer IMAP-Nachricht die Form machen, die die Postfachsuche erwartet.
export function zuNachricht(eintrag) {
  const absender = eintrag.envelope?.from?.[0];
  return {
    id: String(eintrag.uid),
    subject: eintrag.envelope?.subject || '(ohne Betreff)',
    from: absender ? [absender.name, absender.address].filter(Boolean).join(' <') + (absender.name ? '>' : '') : '',
    datum: eintrag.envelope?.date ? new Date(eintrag.envelope.date).toUTCString() : '',
    empfangen: eintrag.envelope?.date ? new Date(eintrag.envelope.date).toISOString() : '',
    anhaenge: sammleAnhaenge(eintrag.bodyStructure),
  };
}

// --- Schnittstelle des Mail-Zugangs ------------------------------------------

export async function sucheNachrichten({ von, bis }, maxNachrichten = 500) {
  return mitVerbindung(async (client) => {
    const gefunden = [];
    for await (const eintrag of client.fetch(baueSuchkriterien({ von, bis }), {
      uid: true, envelope: true, bodyStructure: true,
    })) {
      gefunden.push(zuNachricht(eintrag));
      if (gefunden.length >= maxNachrichten) break;
    }
    return gefunden;
  });
}

export async function ladeAnhang(nachrichtId, attachmentId) {
  return mitVerbindung(async (client) => {
    const ergebnis = await client.download(String(nachrichtId), String(attachmentId), { uid: true });
    if (!ergebnis?.content) throw new Error(`Anhang ${attachmentId} der Nachricht ${nachrichtId} war nicht abrufbar.`);
    const teile = [];
    for await (const stueck of ergebnis.content) teile.push(stueck);
    return Buffer.concat(teile);
  });
}

/**
 * Sucht die Antwort auf ein Ticket. TEXT durchsucht Kopf und Rumpf, damit das
 * Kennzeichen auch dann gefunden wird, wenn es nur im zitierten Text steht.
 */
export async function findReply(ticket) {
  return mitVerbindung(async (client) => {
    let ohneAnhang = null;
    for await (const eintrag of client.fetch({ text: ticket }, { uid: true, envelope: true, bodyStructure: true })) {
      const nachricht = zuNachricht(eintrag);
      // Die eigene, gesendete Nachricht traegt dasselbe Kennzeichen.
      if ((nachricht.from || '').includes(config.imapUser)) continue;

      const treffer = { ...nachricht, hasAttachment: nachricht.anhaenge.length > 0,
        ladeAnhang: (id) => ladeAnhang(nachricht.id, id) };
      if (treffer.hasAttachment) return treffer;
      ohneAnhang ??= treffer;
    }
    return ohneAnhang;
  });
}

export async function sendMail({ to, subject, body, from = config.mailFrom, replyTo }) {
  pruefeEinstellungen();
  const nodemailer = (await import('nodemailer')).default;
  const transport = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpPort === 465,
    auth: { user: config.imapUser, pass: config.imapPasswort },
  });
  try {
    const ergebnis = await transport.sendMail({ from, to, subject, text: body, replyTo });
    return { id: ergebnis.messageId, driver: 'imap' };
  } catch (err) {
    throw new Error(uebersetzeFehler(err));
  } finally {
    transport.close();
  }
}

export function describe() {
  const fehlend = [];
  if (!config.imapUser) fehlend.push('IMAP_USER');
  if (!config.imapPasswort) fehlend.push('IMAP_PASSWORT');
  return {
    driver: 'imap',
    host: config.imapHost,
    inbox: config.imapUser || config.accountingInbox,
    postfach: config.imapPostfach,
    ready: fehlend.length === 0,
    echtesPostfach: true,
    ...(fehlend.length ? {
      fehlt: fehlend,
      hinweis: `In der .env fehlen: ${fehlend.join(', ')}. IMAP_PASSWORT ist ein App-Passwort ` +
        'aus den Google-Kontoeinstellungen. Prüfen mit: npm run mail:check',
    } : {}),
  };
}

// Prueft die Einrichtung: Anmeldung, Postfach, Leserecht.
export async function pruefeEinrichtung() {
  return mitVerbindung(async (client) => {
    const status = await client.status(config.imapPostfach, { messages: true, unseen: true });
    return { postfach: config.imapUser, ordner: config.imapPostfach, nachrichten: status.messages };
  });
}
