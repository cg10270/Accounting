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
  return { storagePath: relPath, storageId: relPath };
}

export async function getFile(relPath) {
  return fs.readFileSync(abs(relPath));
}

export async function deleteFile(relPath) {
  const target = abs(relPath);
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
