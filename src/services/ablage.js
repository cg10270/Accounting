import crypto from 'node:crypto';
import { get, run } from '../db.js';
import { storage, buildPath, sanitize } from './storage/index.js';

/**
 * Legt eine Datei im Ablage-Backend ab und verzeichnet sie in der Datenbank.
 * Einziger Weg, auf dem Dateien ins System gelangen - egal ob manuell
 * hochgeladen, von der KI beschafft, als Eigenbeleg erzeugt oder per Mail
 * eingegangen.
 */
export async function speichereDatei({ periodId, taskId = null, lieferantId = null, filename, mime, buffer, source, ordner = null }) {
  const period = get('SELECT * FROM periods WHERE id = ?', periodId);
  if (!period) throw new Error('Zeitraum nicht gefunden.');
  const task = taskId ? get('SELECT * FROM tasks WHERE id = ?', taskId) : null;

  // Ohne Aufgabe entscheidet der Aufrufer ueber den Ordner - sonst landen
  // eingegangene Belege unter dem missverstaendlichen "Ohne Zuordnung".
  const relPath = buildPath(period, ordner || task?.title, filename);
  const checksum = crypto.createHash('sha256').update(buffer).digest('hex');

  // Dieselbe Datei zweimal hochzuladen ist der Normalfall, nicht die Ausnahme:
  // eine Rechnung kommt per Mail und wird zusaetzlich aus dem Portal geholt.
  // Die Dublette wird gar nicht erst abgelegt - sonst zaehlt sie im Abgleich
  // doppelt und ein Beleg schliesst zwei Buchungen.
  const vorhanden = get('SELECT * FROM artifacts WHERE period_id = ? AND checksum = ?', periodId, checksum);
  if (vorhanden) {
    if (!process.env.STILL) console.log(`Dublette zu #${vorhanden.id} ${vorhanden.filename} - nicht abgelegt`);
    return { ...vorhanden, doppelt: true };
  }

  const abgelegt = await storage.putFile(relPath, buffer, mime);

  const r = run(
    `INSERT INTO artifacts (period_id, task_id, lieferant_id, filename, mime, size, checksum,
                            storage_path, storage_id, web_url, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    periodId, taskId, lieferantId, sanitize(filename), mime, buffer.length, checksum,
    abgelegt.storagePath, abgelegt.storageId, abgelegt.webUrl || '', source,
  );
  const eintrag = get('SELECT * FROM artifacts WHERE id = ?', Number(r.lastInsertRowid));
  // Jede abgelegte Datei erscheint im Terminal: so ist nachpruefbar, wie viele
  // von hundert Uploads wirklich angekommen sind.
  if (!process.env.STILL) console.log(`abgelegt #${eintrag.id} ${eintrag.storage_path}`);
  return eintrag;
}

// Verweis auf eine abgelegte Datei, wie ihn die Backends erwarten.
export const verweis = (datei) => ({ path: datei.storage_path, id: datei.storage_id });

export async function leseDatei(datei) {
  return storage.getFile(verweis(datei));
}
