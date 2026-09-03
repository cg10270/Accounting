import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config.js';

// Entwicklungs-Backend: bildet die Google-Drive-Ablage 1:1 auf dem Dateisystem ab.
export const name = 'local';

function abs(relPath) {
  const target = path.resolve(config.localStorageDir, relPath);
  if (!target.startsWith(path.resolve(config.localStorageDir))) throw new Error('Ungueltiger Pfad');
  return target;
}

export async function putFile(relPath, buffer) {
  const target = abs(relPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, buffer);
  return { storagePath: relPath, storageId: relPath, webUrl: '' };
}

// Verweise kommen als { path, id }. Lokal ist die Kennung der Pfad selbst.
export async function getFile({ path: relPath, id }) {
  return fs.readFileSync(abs(relPath || id));
}

export async function deleteFile({ path: relPath, id }) {
  const target = abs(relPath || id);
  if (fs.existsSync(target)) fs.unlinkSync(target);
}

export async function listFolder(relPath) {
  const target = abs(relPath);
  if (!fs.existsSync(target)) return [];
  return fs.readdirSync(target, { withFileTypes: true })
    .map((e) => ({ name: e.name, isFolder: e.isDirectory() }));
}

export function describe() {
  return { driver: 'local', root: config.localStorageDir, ready: true };
}
