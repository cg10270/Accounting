// Zeigt, was im Postfach tatsaechlich liegt - zur Fehlersuche, wenn die
// Beleg-Suche nichts findet.   Aufruf: npm run mail:suche ["suchausdruck"]
import { config } from './config.js';
import * as gmail from './services/google/gmail.js';

if (config.mailDriver !== 'gmail') {
  console.log(`\nMAIL_DRIVER steht auf "${config.mailDriver}" - dieser Befehl prüft nur den Gmail-Zugang.\n`);
  process.exit(1);
}

const query = process.argv[2] || 'has:attachment';
const profil = await gmail.pruefeEinrichtung();
console.log(`\nPostfach ${profil.postfach} - ${profil.nachrichten} Nachrichten insgesamt`);

const treffer = await gmail.sucheNachrichten(query, 10);
console.log(`Suche "${query}": ${treffer.length} Treffer${treffer.length === 10 ? ' (nur die ersten 10)' : ''}\n`);
for (const n of treffer) {
  const anhaenge = (n.anhaenge || []).map((a) => a.filename).join(', ') || 'keine';
  console.log(`  ${(n.empfangen || n.datum).slice(0, 10)}  ${n.from}\n      ${n.subject}\n      Anhänge: ${anhaenge}`);
}
console.log('');
