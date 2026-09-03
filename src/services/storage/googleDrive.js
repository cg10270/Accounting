import { config } from '../../config.js';

// Google-Drive-Backend ueber einen Service Account mit Domain-Wide Delegation.
//
// Einrichtung (einmalig, Google-Workspace-Admin):
//   1. Google-Cloud-Projekt anlegen, Drive API und Gmail API aktivieren
//   2. Service Account anlegen, JSON-Key herunterladen -> secrets/service-account.json
//   3. In der Workspace-Admin-Konsole unter "API-Steuerung > Domainweite Delegierung"
//      die Client-ID des Service Accounts mit diesen Scopes freigeben:
//        https://www.googleapis.com/auth/drive
//        https://www.googleapis.com/auth/gmail.send
//        https://www.googleapis.com/auth/gmail.readonly
//   4. GOOGLE_IMPERSONATE_USER auf das Postfach setzen, in dessen Namen gehandelt wird
//   5. DRIVE_ROOT_FOLDER_ID auf den Zielordner setzen
//
// Der eigentliche API-Aufruf wird angeschlossen, sobald die Credentials vorliegen.
// Bis dahin meldet dieses Backend klar, dass es nicht einsatzbereit ist, statt
// Uploads still ins Leere laufen zu lassen.

export const name = 'gdrive';

function notConfigured() {
  throw new Error(
    'Google-Drive-Backend ist noch nicht konfiguriert. ' +
    'Bitte GOOGLE_SERVICE_ACCOUNT_JSON, GOOGLE_IMPERSONATE_USER und DRIVE_ROOT_FOLDER_ID setzen ' +
    'und die Drive-Anbindung aktivieren (siehe src/services/storage/googleDrive.js).'
  );
}

export async function putFile() { notConfigured(); }
export async function getFile() { notConfigured(); }
export async function deleteFile() { notConfigured(); }
export async function listFolder() { notConfigured(); }

export function describe() {
  return {
    driver: 'gdrive',
    root: config.driveRootFolderId,
    impersonate: config.googleImpersonateUser,
    ready: false,
    hinweis: 'Service-Account-Anbindung noch nicht aktiviert.',
  };
}
