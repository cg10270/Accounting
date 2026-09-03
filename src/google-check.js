// Prueft die Google-Einrichtung Schritt fuer Schritt und sagt bei jedem
// Fehlschlag, was konkret zu tun ist.   Aufruf: npm run google:check
import { config } from './config.js';
import { ladeDienstkonto, holeZugriffstoken, SCOPES } from './services/google/auth.js';
import * as drive from './services/google/drive.js';
import * as gmail from './services/google/gmail.js';

const ok = (t, d = '') => console.log(`  OK    ${t}${d ? '  ' + d : ''}`);
const fail = (t, e) => { console.log(`  FEHLT ${t}\n        ${String(e.message || e).replace(/\n/g, '\n        ')}`); return false; };

let alles = true;
console.log('\nGoogle-Einrichtung prüfen\n');

// 1 - Konfiguration
const fehlend = [
  ['GOOGLE_SERVICE_ACCOUNT_JSON', config.googleServiceAccountJson],
  ['GOOGLE_IMPERSONATE_USER', config.googleImpersonateUser],
  ['DRIVE_ROOT_FOLDER_ID', config.driveRootFolderId],
].filter(([, wert]) => !wert).map(([name]) => name);

if (fehlend.length) {
  alles = fail('Konfiguration', new Error(`In der .env fehlen: ${fehlend.join(', ')}`));
} else {
  ok('Konfiguration', `Postfach ${config.googleImpersonateUser}`);
}

// 2 - Service-Account-Datei
let konto = null;
try {
  konto = ladeDienstkonto();
  ok('Service-Account-Datei', konto.client_email);
} catch (err) { alles = fail('Service-Account-Datei', err); }

// 3 - Anmeldung je Bereich einzeln, damit eine fehlende Freigabe erkennbar wird
if (konto) {
  for (const [name, scope] of [
    ['Drive', SCOPES.drive],
    ['Gmail senden', SCOPES.gmailSend],
    ['Gmail lesen', SCOPES.gmailRead],
  ]) {
    try {
      await holeZugriffstoken(scope);
      ok(`Freigabe ${name}`);
    } catch (err) { alles = fail(`Freigabe ${name}`, err); }
  }

  // 4 - Zielordner
  if (config.driveRootFolderId) {
    try {
      const ordner = await drive.pruefeEinrichtung();
      ok('Zielordner in Drive', `"${ordner.name}"${ordner.geteilteAblage ? ' (geteilte Ablage)' : ''}`);
    } catch (err) {
      alles = fail('Zielordner in Drive', new Error(
        `${err.message}\nPrüfe DRIVE_ROOT_FOLDER_ID und ob der Ordner für ${config.googleImpersonateUser} freigegeben ist.`));
    }

    // 5 - Schreibrecht wirklich ausprobieren
    try {
      const probe = Buffer.from(`Schreibprobe ${new Date().toISOString()}\n`, 'utf8');
      const abgelegt = await drive.ablegen('Buchhaltung/_Systemprüfung', 'schreibprobe.txt', probe, 'text/plain');
      const zurueck = await drive.herunterladen(abgelegt.id);
      if (!zurueck.equals(probe)) throw new Error('Die zurückgelesene Datei stimmt nicht mit der geschriebenen überein.');
      await drive.inPapierkorb(abgelegt.id);
      ok('Schreiben, Lesen und Löschen in Drive');
    } catch (err) { alles = fail('Schreiben in Drive', err); }
  }

  // 6 - Postfach
  try {
    const profil = await gmail.pruefeEinrichtung();
    ok('Gmail-Postfach', profil.postfach);
  } catch (err) { alles = fail('Gmail-Postfach', err); }
}

console.log(alles
  ? '\nAlles bereit. STORAGE_DRIVER=gdrive und MAIL_DRIVER=gmail in der .env setzen.\n'
  : '\nEs sind noch Schritte offen — siehe oben.\n');
process.exit(alles ? 0 : 1);
