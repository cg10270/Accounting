import path from 'node:path';
import { config } from '../../config.js';
import * as drive from '../google/drive.js';
import { ladeDienstkonto } from '../google/auth.js';

// Ablage in Google Drive ueber einen Service Account mit domainweiter Delegierung.
//
// Einrichtung (einmalig, Google-Workspace-Admin):
//   1. Google-Cloud-Projekt anlegen, Drive API und Gmail API aktivieren
//   2. Service Account anlegen, JSON-Schluessel herunterladen
//      -> Pfad in GOOGLE_SERVICE_ACCOUNT_JSON eintragen
//   3. Admin-Konsole > Sicherheit > Zugriffs- und Datenkontrolle > API-Steuerung
//      > Domainweite Delegierung: Client-ID des Service Accounts eintragen mit
//        https://www.googleapis.com/auth/drive
//        https://www.googleapis.com/auth/gmail.send
//        https://www.googleapis.com/auth/gmail.readonly
//   4. GOOGLE_IMPERSONATE_USER auf das Postfach setzen, in dessen Namen
//      gehandelt wird (z. B. accounting@lexaid.net)
//   5. Zielordner in Drive anlegen, fuer dieses Postfach freigeben und dessen
//      ID aus der Adresszeile in DRIVE_ROOT_FOLDER_ID eintragen
//
// Mit "npm run google:check" laesst sich die Einrichtung pruefen.

export const name = 'gdrive';

const trennePfad = (relPath) => ({
  ordner: path.posix.dirname(relPath) === '.' ? '' : path.posix.dirname(relPath),
  datei: path.posix.basename(relPath),
});

export async function putFile(relPath, buffer, mime = 'application/octet-stream') {
  const { ordner, datei } = trennePfad(relPath);
  const abgelegt = await drive.ablegen(ordner, datei, buffer, mime);
  return { storagePath: relPath, storageId: abgelegt.id, webUrl: abgelegt.webUrl };
}

export async function getFile({ path: relPath, id }) {
  // Die Drive-ID ist der verlaessliche Verweis: sie bleibt gueltig, auch wenn
  // jemand den Ordner in Drive umbenennt oder die Datei verschiebt.
  if (id) return drive.herunterladen(id);

  const { ordner, datei } = trennePfad(relPath);
  const gefunden = await drive.findeDatei(ordner, datei);
  if (!gefunden) throw new Error(`Die Datei "${relPath}" wurde in Drive nicht gefunden.`);
  return drive.herunterladen(gefunden.id);
}

export async function deleteFile({ path: relPath, id }) {
  let zielId = id;
  if (!zielId) {
    const { ordner, datei } = trennePfad(relPath);
    zielId = (await drive.findeDatei(ordner, datei))?.id;
  }
  if (zielId) await drive.inPapierkorb(zielId);
}

export async function listFolder(relPath) {
  return drive.inhaltVon(relPath);
}

export function describe() {
  // describe() wird bei jedem Statusabruf aufgerufen und darf deshalb nicht
  // ins Netz greifen - geprueft wird nur, ob die Einrichtung vollstaendig ist.
  const fehlend = [];
  if (!config.googleServiceAccountJson) fehlend.push('GOOGLE_SERVICE_ACCOUNT_JSON');
  if (!config.googleImpersonateUser) fehlend.push('GOOGLE_IMPERSONATE_USER');
  if (!config.driveRootFolderId) fehlend.push('DRIVE_ROOT_FOLDER_ID');

  let dienstkonto = '';
  if (!fehlend.length) {
    try { dienstkonto = ladeDienstkonto().client_email; }
    catch (err) { fehlend.push(err.message); }
  }
  return {
    driver: 'gdrive',
    root: config.driveRootFolderId,
    impersonate: config.googleImpersonateUser,
    dienstkonto,
    ready: fehlend.length === 0,
    ...(fehlend.length ? { fehlt: fehlend } : {}),
  };
}

export const pruefeEinrichtung = drive.pruefeEinrichtung;
