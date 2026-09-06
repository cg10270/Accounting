// Zieht Altbestand nach: lokal liegende Dateien nach Google Drive heben und
// noch nicht ausgelesene Belege auslesen.   Aufruf: npm run nachtragen
import { config, aiEnabled } from './config.js';
import { nachtragen } from './services/nachtragen.js';

console.log(`\nAblage: ${config.storageDriver} · KI: ${aiEnabled ? 'bereit' : 'kein API-Key'}\n`);

const bericht = await nachtragen(null);
console.log(`  ${bericht.geprueft} Dateien geprüft`);
console.log(`  ${bericht.verschoben} nach ${config.storageDriver} übertragen`);
console.log(`  ${bericht.ausgelesen} ausgelesen, ${bericht.uebersprungen} übersprungen (keine Rechnung)`);
for (const z of bericht.abgleich) console.log(`  Zeitraum ${z.period_id}: ${z.vorschlaege} Zuordnung(en)`);
for (const f of bericht.fehler) console.log(`  FEHLER ${f.filename} (${f.schritt}): ${f.fehler}`);
console.log('');
