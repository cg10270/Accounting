// Probiert eine Anmeldung am Postfach, ohne die .env anzufassen.
//
//   npm run mail:test                       fragt Adresse und Passwort ab
//   npm run mail:test -- adresse@firma.de   fragt nur das Passwort ab
//
// Das Passwort wird verdeckt eingegeben und landet damit nicht im
// Verlauf des Terminals.
import readline from 'node:readline';
import { config } from './config.js';

function frage(text, verdeckt = false) {
  return new Promise((antwort) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (verdeckt) {
      // Die Eingabe soll nicht sichtbar sein - Terminals zeigen Passwoerter nie.
      rl._writeToOutput = (zeichen) => {
        if (zeichen.includes(text)) rl.output.write(text);
      };
    }
    rl.question(text, (wert) => { rl.close(); if (verdeckt) process.stdout.write('\n'); antwort(wert); });
  });
}

const argumente = process.argv.slice(2);
const benutzer = argumente[0] || await frage('Adresse des Postfachs: ');
const rohesPasswort = argumente[1] || await frage('App-Passwort (bleibt unsichtbar): ', true);
const passwort = rohesPasswort.replace(/\s/g, '');

console.log(`\n  Adresse:  ${benutzer}`);
console.log(`  Passwort: ${passwort.length} Zeichen` +
  (passwort.length === 16 ? ' — passt zu einem App-Passwort' : ' — ACHTUNG: App-Passwörter haben genau 16'));
console.log(`  Server:   ${config.imapHost}:${config.imapPort}\n`);

const { ImapFlow } = await import('imapflow');
const client = new ImapFlow({
  host: config.imapHost, port: config.imapPort, secure: true,
  auth: { user: benutzer, pass: passwort },
  logger: false,
  connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000,
});

try {
  await client.connect();
  const status = await client.status('INBOX', { messages: true });
  console.log(`  ✓ Anmeldung erfolgreich — ${status.messages} Nachrichten im Posteingang.\n`);
  console.log('  Diese Werte in die .env eintragen:');
  console.log('      MAIL_DRIVER=imap');
  console.log(`      IMAP_USER=${benutzer}`);
  console.log(`      IMAP_PASSWORT=${passwort}\n`);
  await client.logout();
} catch (err) {
  const text = String(err?.responseText || err?.message || err);
  console.log(`  ✗ Fehlgeschlagen: ${text}\n`);
  if (/Invalid credentials|AUTHENTICATIONFAILED/i.test(text)) {
    console.log('  Bei bestätigtem Nutzerkonto und freigegebenem IMAP bleibt fast immer eine Ursache:');
    console.log('  das App-Passwort gehört zu einem anderen Google-Konto als der angegebenen Adresse.');
    console.log('  App-Passwörter sind kontogebunden — erzeuge es angemeldet als genau diese Adresse.\n');
  }
  process.exit(1);
}
