// Prüft den Zugang zum Buchhaltungspostfach.   npm run mail:check
import { config } from './config.js';
import { mailer } from './services/mail/index.js';

const ok = (t, d = '') => console.log(`  OK    ${t}${d ? '  ' + d : ''}`);
const fail = (t, e) => { console.log(`  FEHLT ${t}\n        ${String(e.message || e).replace(/\n/g, '\n        ')}`); return false; };

console.log(`\nMail-Zugang prüfen  (MAIL_DRIVER=${config.mailDriver})\n`);
let alles = true;

const zustand = mailer.describe();
if (zustand.echtesPostfach === false) {
  console.log('  HINWEIS  Es ist kein echtes Postfach angebunden.');
  console.log(`           ${zustand.hinweis}`);
  console.log('\n  Für den Abruf aus Gmail per App-Passwort in der .env setzen:');
  console.log('      MAIL_DRIVER=imap');
  console.log('      IMAP_USER=accounting@lexaid.net');
  console.log('      IMAP_PASSWORT=<App-Passwort ohne Leerzeichen>\n');
  process.exit(1);
}

if (!zustand.ready) {
  fail('Konfiguration', new Error(zustand.hinweis || `Fehlt: ${(zustand.fehlt || []).join(', ')}`));
  process.exit(1);
}
ok('Konfiguration', `${zustand.inbox} über ${zustand.host || zustand.driver}`);

try {
  const profil = await mailer.pruefeEinrichtung();
  ok('Anmeldung und Leserecht',
    `${profil.postfach}${profil.ordner ? ` (${profil.ordner})` : ''}, ${profil.nachrichten ?? '?'} Nachrichten`);
} catch (err) { alles = fail('Anmeldung', err); }

console.log(alles
  ? '\n  Postfach erreichbar. Der Reiter "Postfach" kann jetzt suchen.\n'
  : '\n  Es sind noch Schritte offen — siehe oben.\n');
process.exit(alles ? 0 : 1);
