import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { config, ROOT } from '../../config.js';

// Anmeldung als Service Account mit domainweiter Delegierung.
//
// Ablauf: Wir bauen ein JWT, signieren es mit dem privaten Schluessel aus der
// Service-Account-Datei und tauschen es bei Google gegen ein Zugriffstoken.
// Das Feld "sub" enthaelt das Postfach, in dessen Namen gehandelt wird - dafuer
// muss die Client-ID des Service Accounts in der Workspace-Admin-Konsole fuer
// genau die unten angeforderten Bereiche freigegeben sein.

export const SCOPES = {
  drive: 'https://www.googleapis.com/auth/drive',
  gmailSend: 'https://www.googleapis.com/auth/gmail.send',
  gmailRead: 'https://www.googleapis.com/auth/gmail.readonly',
};

const b64url = (input) => Buffer.from(input).toString('base64url');

let zwischengespeichertesKonto = null;

export function ladeDienstkonto() {
  if (zwischengespeichertesKonto) return zwischengespeichertesKonto;

  const pfad = config.googleServiceAccountJson;
  if (!pfad) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON ist nicht gesetzt.');
  }
  const voll = path.isAbsolute(pfad) ? pfad : path.resolve(ROOT, pfad);
  if (!fs.existsSync(voll)) {
    throw new Error(`Die Service-Account-Datei wurde nicht gefunden: ${voll}`);
  }

  let konto;
  try {
    konto = JSON.parse(fs.readFileSync(voll, 'utf8'));
  } catch (err) {
    throw new Error(`Die Service-Account-Datei ist kein gültiges JSON: ${err.message}`);
  }
  for (const feld of ['client_email', 'private_key']) {
    if (!konto[feld]) throw new Error(`In der Service-Account-Datei fehlt das Feld "${feld}".`);
  }
  if (konto.type && konto.type !== 'service_account') {
    throw new Error(`Die Datei beschreibt kein Dienstkonto (type: ${konto.type}).`);
  }

  zwischengespeichertesKonto = {
    ...konto,
    // In .env-Dateien abgelegte Schluessel enthalten oft "\n" als Text.
    private_key: String(konto.private_key).replace(/\\n/g, '\n'),
    token_uri: konto.token_uri || 'https://oauth2.googleapis.com/token',
  };
  return zwischengespeichertesKonto;
}

// Tokens werden je Kombination aus Bereichen und Postfach zwischengespeichert.
const tokenCache = new Map();

export async function holeZugriffstoken(scopes, benutzer = config.googleImpersonateUser) {
  const konto = ladeDienstkonto();
  if (!benutzer) {
    throw new Error('GOOGLE_IMPERSONATE_USER ist nicht gesetzt - ohne Postfach ist keine domainweite Delegierung möglich.');
  }
  const liste = Array.isArray(scopes) ? scopes : [scopes];
  const schluessel = `${benutzer}|${liste.join(' ')}`;

  const vorhanden = tokenCache.get(schluessel);
  // 60 Sekunden Puffer, damit ein Token nicht mitten im Aufruf abläuft.
  if (vorhanden && vorhanden.gueltigBis - 60_000 > Date.now()) return vorhanden.token;

  const jetzt = Math.floor(Date.now() / 1000);
  const kopf = { alg: 'RS256', typ: 'JWT' };
  const angaben = {
    iss: konto.client_email,
    scope: liste.join(' '),
    aud: konto.token_uri,
    sub: benutzer,
    iat: jetzt,
    exp: jetzt + 3600,
  };

  const daten = `${b64url(JSON.stringify(kopf))}.${b64url(JSON.stringify(angaben))}`;
  let signatur;
  try {
    signatur = crypto.createSign('RSA-SHA256').update(daten).sign(konto.private_key);
  } catch (err) {
    // OpenSSL meldet hier nur kryptische Codes - der Grund ist praktisch immer
    // ein beschaedigter oder falsch eingefuegter Schluessel.
    throw new Error(
      'Der private Schlüssel in der Service-Account-Datei konnte nicht gelesen werden. ' +
      'Er muss der vollständige PEM-Block sein, beginnend mit "-----BEGIN PRIVATE KEY-----". ' +
      'Am einfachsten in der Google Cloud Console einen neuen JSON-Schlüssel erzeugen. ' +
      `(Technisch: ${err.message})`,
    );
  }
  const jwt = `${daten}.${signatur.toString('base64url')}`;

  const antwort = await fetch(konto.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  const ergebnis = await antwort.json().catch(() => ({}));
  if (!antwort.ok) {
    throw new Error(uebersetzeTokenfehler(ergebnis, benutzer));
  }

  const token = ergebnis.access_token;
  tokenCache.set(schluessel, { token, gueltigBis: Date.now() + (ergebnis.expires_in || 3600) * 1000 });
  return token;
}

// Googles Fehlermeldungen an dieser Stelle sind knapp und die Ursache liegt fast
// immer in der Einrichtung. Deshalb uebersetzen wir sie in eine Anweisung.
function uebersetzeTokenfehler(ergebnis, benutzer) {
  const code = ergebnis.error || 'unbekannt';
  const text = ergebnis.error_description || '';
  const hinweise = {
    unauthorized_client:
      `Der Service Account darf nicht im Namen von ${benutzer} handeln. ` +
      'Bitte in der Workspace-Admin-Konsole unter "Sicherheit > Zugriffs- und Datenkontrolle > ' +
      'API-Steuerung > Domainweite Delegierung" die Client-ID des Service Accounts mit genau den ' +
      'angeforderten Bereichen freigeben. Nach einer Änderung dauert es einige Minuten.',
    invalid_grant:
      `Das Postfach ${benutzer} existiert nicht, gehört nicht zur Domain, oder die Serverzeit ` +
      'weicht zu stark ab. Bitte GOOGLE_IMPERSONATE_USER und die Uhrzeit des Servers prüfen.',
    invalid_client:
      'Der private Schlüssel oder die Client-E-Mail in der Service-Account-Datei passt nicht. ' +
      'Bitte einen neuen JSON-Schlüssel erzeugen.',
    access_denied:
      'Google hat den Zugriff verweigert. Häufigste Ursache: die angeforderten Bereiche sind ' +
      'nicht vollständig für die domainweite Delegierung freigegeben.',
  };
  return `Google-Anmeldung fehlgeschlagen (${code}${text ? ': ' + text : ''}). ${hinweise[code] || ''}`.trim();
}

/**
 * Gemeinsamer Aufruf fuer Drive und Gmail: setzt das Token, wertet Fehler aus
 * und wiederholt bei Ratenbegrenzung oder Serverfehlern mit wachsender Wartezeit.
 */
export async function googleAbruf(url, { scopes, methode = 'GET', koerper, kopfzeilen = {}, roh = false, versuche = 4 } = {}) {
  let letzterFehler;
  for (let versuch = 0; versuch < versuche; versuch++) {
    const token = await holeZugriffstoken(scopes);
    const antwort = await fetch(url, {
      method: methode,
      headers: { Authorization: `Bearer ${token}`, ...kopfzeilen },
      body: koerper,
    });

    if (antwort.ok) {
      if (roh) return antwort;
      const text = await antwort.text();
      return text ? JSON.parse(text) : {};
    }

    const fehlertext = await antwort.text().catch(() => '');
    // 429 und 5xx sind vorübergehend - alles andere hat keinen Sinn zu wiederholen.
    if (antwort.status === 429 || antwort.status >= 500) {
      letzterFehler = new Error(`Google antwortete mit ${antwort.status}: ${kuerze(fehlertext)}`);
      await new Promise((r) => setTimeout(r, 2 ** versuch * 500));
      continue;
    }
    throw new Error(`Google-Aufruf fehlgeschlagen (${antwort.status}): ${kuerze(fehlertext)}`);
  }
  throw letzterFehler;
}

function kuerze(text) {
  try {
    const j = JSON.parse(text);
    return j.error?.message || j.error_description || text.slice(0, 300);
  } catch { return String(text).slice(0, 300); }
}

export function _testZuruecksetzen() {
  zwischengespeichertesKonto = null;
  tokenCache.clear();
}
