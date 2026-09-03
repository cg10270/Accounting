import crypto from 'node:crypto';
import { get, run } from '../db.js';
import { storage, buildPath, sanitize } from './storage/index.js';

/**
 * Legt eine Datei im Ablage-Backend ab und verzeichnet sie in der Datenbank.
 * Einziger Weg, auf dem Dateien ins System gelangen - egal ob manuell
 * hochgeladen, von der KI beschafft, als Eigenbeleg erzeugt oder per Mail
 * eingegangen.
 */
export async function speichereDatei({ periodId, taskId = null, filename, mime, buffer, source, ordner = null }) {
  const period = get('SELECT * FROM periods WHERE id = ?', periodId);
  if (!period) throw new Error('Zeitraum nicht gefunden.');
  const task = taskId ? get('SELECT * FROM tasks WHERE id = ?', taskId) : null;

  // Ohne Aufgabe entscheidet der Aufrufer ueber den Ordner - sonst landen
  // eingegangene Belege unter dem missverstaendlichen "Ohne Zuordnung".
  const relPath = buildPath(period, ordner || task?.title, filename);
  const abgelegt = await storage.putFile(relPath, buffer, mime);
  const checksum = crypto.createHash('sha256').update(buffer).digest('hex');

  const r = run(
    `INSERT INTO artifacts (period_id, task_id, filename, mime, size, checksum, storage_path, storage_id, web_url, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    periodId, taskId, sanitize(filename), mime, buffer.length, checksum,
    abgelegt.storagePath, abgelegt.storageId, abgelegt.webUrl || '', source,
  );
  return get('SELECT * FROM artifacts WHERE id = ?', Number(r.lastInsertRowid));
}

// Verweis auf eine abgelegte Datei, wie ihn die Backends erwarten.
export const verweis = (datei) => ({ path: datei.storage_path, id: datei.storage_id });

export async function leseDatei(datei) {
  return storage.getFile(verweis(datei));
}
