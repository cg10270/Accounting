// Erstellt die Konfigurationsdatei und legt die Grunddaten an.
// Ein Befehl fuer die Ersteinrichtung:   npm run einrichten
//
// Bewusst schonend: eine vorhandene .env wird nie ueberschrieben, und die
// erzeugte Passphrase wird einmal deutlich angezeigt - ohne sie sind
// gespeicherte Portal-Passwoerter nicht mehr zu entschluesseln.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envDatei = path.join(ROOT, '.env');
const vorlage = path.join(ROOT, '.env.example');

const linie = (zeichen = '─') => console.log(zeichen.repeat(68));

console.log('\nEinrichtung der Buchhaltungsvorbereitung');
linie();

// --- 1. Konfigurationsdatei --------------------------------------------------

let passphrase = null;

if (fs.existsSync(envDatei)) {
  console.log('  .env ist schon vorhanden — bleibt unverändert.');
  const inhalt = fs.readFileSync(envDatei, 'utf8');
  if (!/^VAULT_PASSPHRASE=.+$/m.test(inhalt)) {
    console.log('\n  ACHTUNG: In der .env steht keine VAULT_PASSPHRASE.');
    console.log('  Ohne sie nimmt das System keine Portal-Passwörter an.');
    console.log('  Trage dort eine lange, zufällige Zeichenfolge ein, zum Beispiel:');
    console.log(`      VAULT_PASSPHRASE=${crypto.randomBytes(24).toString('base64url')}`);
  }
} else {
  if (!fs.existsSync(vorlage)) {
    console.error('  Die Vorlage .env.example fehlt — ist das Verzeichnis vollständig ausgecheckt?');
    process.exit(1);
  }
  passphrase = crypto.randomBytes(24).toString('base64url');
  const inhalt = fs.readFileSync(vorlage, 'utf8').replace(/^VAULT_PASSPHRASE=.*$/m, `VAULT_PASSPHRASE=${passphrase}`);
  fs.writeFileSync(envDatei, inhalt, 'utf8');
  console.log('  .env aus der Vorlage erstellt und eine Passphrase erzeugt.');
}

// --- 2. Grunddaten -----------------------------------------------------------

// Erst jetzt laden, damit die eben geschriebene .env gelesen wird.
const { config } = await import('./config.js');
console.log(`  Datenverzeichnis: ${config.dataDir}`);

const db = await import('./db.js');
const zaehle = (t) => db.get(`SELECT COUNT(*) AS n FROM ${t}`).n;
const vorher = zaehle('lieferanten');

// Die Unterskripte reden für sich - hier soll eine ruhige Übersicht stehen.
process.env.STILL = '1';
await import('./seed.js');
await import('./seed-checkliste.js');
delete process.env.STILL;

console.log(`  Checkliste: ${zaehle('bereiche')} Bereiche, ${zaehle('positionen')} Positionen, ` +
  `${zaehle('lieferanten')} Lieferanten${zaehle('lieferanten') === vorher ? ' (unverändert)' : ''}`);

// --- 3. Abschluss ------------------------------------------------------------

if (passphrase) {
  console.log('');
  linie('━');
  console.log('  BITTE JETZT SICHERN — diese Zeile steht nur einmal hier:');
  console.log('');
  console.log(`      VAULT_PASSPHRASE=${passphrase}`);
  console.log('');
  console.log('  Damit werden die Portal-Passwörter verschlüsselt. Geht sie');
  console.log('  verloren, sind alle gespeicherten Zugänge unlesbar und müssen');
  console.log('  neu eingetragen werden. Ab in den Passwortmanager.');
  linie('━');
}

console.log('\n  Noch offen, wenn du so weit bist:');
console.log('    - Zugangsdaten je Lieferant eintragen (Reiter "Lieferanten")');
console.log('    - Google Drive und Gmail anbinden (siehe docs/GOOGLE.md)');
console.log('    - Steuersätze mit der Kanzlei gegenlesen (src/services/steuerregeln.js)');

console.log('\n  Fertig. Jetzt starten mit:');
console.log('      npm start');
console.log('\n  Danach im Browser öffnen:');
console.log(`      http://${config.host}:${config.port}\n`);
