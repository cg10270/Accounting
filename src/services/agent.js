import { all, get } from '../db.js';
import { frageClaude, aiEnabled } from './llm.js';
import { erfasse, ereignis, setzeStatus } from './logbook.js';
import { buildFolderPath } from './storage/index.js';

// Automatisierung einer einzelnen Aufgabe.
//
// Wichtig fuer die Sicherheit: Passwoerter werden NIE in den Prompt geschrieben.
// Die KI bekommt nur die Referenz auf einen Zugang ("Zugang #3: Portal X,
// Benutzer y, Passwort im Tresor hinterlegt"). Erst der Browser-Agent loest die
// Referenz unmittelbar vor der Eingabe im Anmeldeformular auf. Damit taucht ein
// Geheimnis weder im Modellkontext noch im Logbuch auf.

const SYSTEM = `Du automatisierst einen Arbeitsschritt in der Vorbereitung einer deutschen Buchhaltung.
Du planst konkrete, ueberpruefbare Schritte: wo Belege liegen, wie sie beschafft werden,
unter welchem Namen sie abgelegt werden.
Du erfindest keine Belege und keine Betraege. Wenn eine Angabe fehlt, benennst du sie als offene Rueckfrage.
Antworte auf Deutsch, knapp und in nummerierten Schritten.`;

export function beschreibeZugaenge(taskId) {
  const zugaenge = all(
    'SELECT id, label, url, username, has_mfa, notes, (secret_enc IS NOT NULL) AS hat_secret FROM credentials WHERE task_id = ?',
    taskId,
  );
  if (!zugaenge.length) return { text: 'Für diese Aufgabe sind keine Zugänge hinterlegt.', zugaenge };
  const text = zugaenge.map((z, i) =>
    `Zugang ${i + 1} (id ${z.id}): ${z.label}` +
    (z.url ? `\n  URL: ${z.url}` : '') +
    (z.username ? `\n  Benutzer: ${z.username}` : '') +
    `\n  Passwort: ${z.hat_secret ? 'im Tresor hinterlegt, wird erst beim Anmelden eingesetzt' : 'nicht hinterlegt'}` +
    (z.has_mfa ? '\n  ACHTUNG: Zwei-Faktor-Authentifizierung aktiv – manuelle Bestätigung nötig' : '') +
    (z.notes ? `\n  Hinweis: ${z.notes}` : ''),
  ).join('\n');
  return { text, zugaenge };
}

/**
 * Fuehrt die hinterlegte Automatisierung einer Aufgabe aus.
 * Aktuell erzeugt sie den Arbeitsplan und dokumentiert ihn im Logbuch.
 * Die eigentliche Browser-Steuerung ist der naechste Ausbauschritt
 * (Claude Agent SDK + Playwright gegen ein bestehendes Chrome-Profil,
 * damit vorhandene Anmeldungen und Cookies erhalten bleiben).
 */
export async function laufeAufgabe(taskId) {
  const task = get('SELECT * FROM tasks WHERE id = ?', taskId);
  if (!task) throw new Error('Aufgabe nicht gefunden.');
  if (!task.prompt.trim()) throw new Error('Für diese Aufgabe ist kein Prompt hinterlegt.');

  const period = get('SELECT * FROM periods WHERE id = ?', task.period_id);
  const { text: zugangsText, zugaenge } = beschreibeZugaenge(taskId);
  const zielordner = buildFolderPath(period, task.title);

  const eintrag = erfasse({
    period_id: task.period_id,
    task_id: taskId,
    type: 'ki_lauf',
    subject: `KI-Lauf: ${task.title}`,
    status: 'offen',
  }, period);

  const prompt = [
    `Zeitraum: ${period.label} ${period.year}`,
    `Aufgabe: ${task.title}`,
    task.description ? `Beschreibung: ${task.description}` : null,
    '',
    'Arbeitsanweisung:',
    task.prompt,
    '',
    'Verfügbare Zugänge:',
    zugangsText,
    '',
    `Zielordner für alle Dateien: ${zielordner}`,
    '',
    'Gib zurück: die geplanten Schritte, die erwarteten Dateien und alle offenen Rückfragen.',
  ].filter((z) => z !== null).join('\n');

  try {
    const antwort = await frageClaude({ system: SYSTEM, prompt });
    ereignis(eintrag.id, 'plan erstellt', antwort.slice(0, 4000));

    const brauchtMfa = zugaenge.some((z) => z.has_mfa);
    const status = brauchtMfa ? 'offen' : 'gesendet';
    const hinweis = brauchtMfa
      ? 'Mindestens ein Zugang erfordert Zwei-Faktor-Authentifizierung – manueller Eingriff nötig.'
      : (aiEnabled ? 'Plan erstellt. Browser-Ausführung noch nicht aktiviert.' : 'Mock-Modus: kein API-Key gesetzt.');

    setzeStatus(eintrag.id, status, hinweis);
    return { logbook_id: eintrag.id, ticket: eintrag.ticket, plan: antwort, zielordner, hinweis };
  } catch (err) {
    setzeStatus(eintrag.id, 'fehlgeschlagen', err.message, err.message);
    throw err;
  }
}
