import { config } from '../../config.js';
import * as local from './local.js';
import * as gdrive from './googleDrive.js';

const drivers = { local, gdrive };
export const storage = drivers[config.storageDriver] || local;

// Einheitliche Ordnerstruktur, unabhaengig vom Backend:
//   Buchhaltung/<Jahr>/<MM Monat>/<Aufgabe>/<Datei>
export function buildFolderPath(period, taskTitle) {
  const monat = String(period.month).padStart(2, '0');
  return [
    'Buchhaltung',
    String(period.year),
    `${monat} ${period.label}`,
    sanitize(taskTitle || 'Ohne Zuordnung'),
  ].join('/');
}

export function buildPath(period, taskTitle, filename) {
  return `${buildFolderPath(period, taskTitle)}/${sanitize(filename)}`;
}

export function sanitize(value) {
  return String(value || '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'unbenannt';
}
