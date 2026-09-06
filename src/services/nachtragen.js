import fs from 'node:fs';
import path from 'node:path';
import { all, get, run } from '../db.js';
import { config } from '../config.js';
import { storage } from './storage/index.js';
import { ergaenzeBelegdaten } from './belegdaten.js';
import { gleicheAb, markiereBuchungen } from './abgleich.js';

// Holt nach, was fuer aeltere Belege noch fehlt.
//
// Zwei Rueckstaende entstehen im Betrieb: Dateien, die vor dem Umschalten auf
// Google Drive lokal abgelegt wurden, und Belege aus der Zeit, bevor sie beim
// Eingang ausgelesen wurden. Beides laesst sich nachziehen, ohne etwas neu
// hochladen zu muessen.

// Lokal ist die Kennung der Pfad selbst - daran ist eine noch nicht nach
// Drive uebertragene Datei zu erkennen.
const liegtLokal = (a) => a.storage_id === a.storage_path;

const lokalerPfad = (a) => path.join(config.localStorageDir, a.storage_path);

/**
 * @param {number|null} periodId  null = alle Zeitraeume
 */
export async function nachtragen(periodId = null, { verschieben = true, auslesen = true } = {}) {
  const wo = periodId ? 'WHERE period_id = ?' : '';
  const params = periodId ? [Number(periodId)] : [];
  const dateien = all(`SELECT * FROM artifacts ${wo} ORDER BY id`, ...params);

  const bericht = { geprueft: dateien.length, verschoben: 0, ausgelesen: 0, uebersprungen: 0, fehler: [] };

  for (const a of dateien) {
    let inhalt = null;
    const lesen = () => {
      if (inhalt) return inhalt;
      const datei = lokalerPfad(a);
      if (liegtLokal(a) && fs.existsSync(datei)) inhalt = fs.readFileSync(datei);
      return inhalt;
    };

    // 1 - noch lokal liegende Dateien ins eingestellte Backend heben
    if (verschieben && liegtLokal(a) && config.storageDriver !== 'local') {
      try {
        const buffer = lesen();
        if (!buffer) throw new Error(`Datei fehlt unter ${lokalerPfad(a)}`);
        const abgelegt = await storage.putFile(a.storage_path, buffer, a.mime);
        run('UPDATE artifacts SET storage_path = ?, storage_id = ?, web_url = ? WHERE id = ?',
          abgelegt.storagePath, abgelegt.storageId, abgelegt.webUrl || '', a.id);
        bericht.verschoben++;
      } catch (err) {
        bericht.fehler.push({ id: a.id, filename: a.filename, schritt: 'ablegen', fehler: err.message });
        continue;
      }
    }

    // 2 - Belege ohne Betrag auslesen. Tabellen und Kontoauszuege sind keine
    // Rechnungen; ergaenzeBelegdaten sortiert sie am Dateityp aus.
    if (auslesen && a.amount_cents == null) {
      try {
        const aktuell = get('SELECT * FROM artifacts WHERE id = ?', a.id);
        const buffer = lesen() ?? await storage.getFile({ path: aktuell.storage_path, id: aktuell.storage_id });
        const ergebnis = await ergaenzeBelegdaten(a.id, { buffer, mime: a.mime, filename: a.filename });
        if (ergebnis.ki) bericht.ausgelesen++;
        else bericht.uebersprungen++;
      } catch (err) {
        bericht.fehler.push({ id: a.id, filename: a.filename, schritt: 'auslesen', fehler: err.message });
      }
    }
  }

  // 3 - mit dem neuen Wissen neu abgleichen
  const zeitraeume = periodId ? [Number(periodId)]
    : all('SELECT DISTINCT period_id AS id FROM artifacts').map((r) => r.id);
  bericht.abgleich = zeitraeume.map((id) => {
    markiereBuchungen(id);
    return { period_id: id, ...gleicheAb(id) };
  });

  return bericht;
}
