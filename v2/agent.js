import Anthropic from '@anthropic-ai/sdk';
import { all, get } from '../db.js';
import { config, aiEnabled } from '../config.js';
import { erfasse, ereignis, setzeStatus } from './logbook.js';
import { buildFolderPath } from './storage/index.js';
import { Browsersteuerung, normalisiereDomain } from './browser/steuerung.js';
import { WERKZEUGE, Werkzeugausfuehrung, formatiereZustand } from './browser/werkzeuge.js';

// Automatisierung einer Aufgabe: Claude steuert einen echten Browser, meldet
// sich in Portalen an, laedt Belege herunter und legt sie ab.
//
// Passwoerter gelangen nie in den Modellkontext. Das Modell bekommt nur die
// Nummer eines Zugangs und ruft damit das Werkzeug "anmelden" auf; erst dort
// wird das Geheimnis entschluesselt und unmittelbar ins Formularfeld
// geschrieben. Es wird weder zurueckgegeben noch protokolliert.

const client = aiEnabled ? new Anthropic({ apiKey: config.anthropicApiKey }) : null;

const SYSTEM = `Du beschaffst Belege für die Vorbereitung einer deutschen Buchhaltung, indem du einen Browser bedienst.

Vorgehen:
- Lies den Seitenzustand, bevor du handelst. Nach jeder Aktion ändern sich die Element-Nummern.
- Melde dich ausschließlich über das Werkzeug "anmelden" an. Du kennst keine Passwörter und brauchst keine.
- Lade die Belege des genannten Zeitraums herunter und lege jeden einzeln mit "beleg_ablegen" ab.
- Benenne Dateien nach dem Muster JJJJ-MM-TT_Lieferant_Betrag.pdf.
- Übernimm Lieferant, Betrag und Datum nur, wenn du sie tatsächlich auf der Seite oder im Beleg gesehen hast. Rate nie.

Grenzen:
- Du darfst im Portal nichts verändern, bestellen, kündigen oder verschicken. Du holst nur Belege.
- Bei Zwei-Faktor-Abfrage, Captcha oder unklarer Anmeldung: "hilfe_anfordern" aufrufen, nicht herumprobieren.
- Wenn du dreimal am selben Punkt nicht weiterkommst, fordere Hilfe an statt es weiter zu versuchen.
- Wenn ein Zeitraum keine Belege enthält, ist das ein gültiges Ergebnis - melde es mit "fertig".

Arbeite zügig und in wenigen, gezielten Schritten. Antworte auf Deutsch.`;

export function beschreibeZugaenge(taskId) {
  const zugaenge = all(
    'SELECT id, label, url, username, has_mfa, notes, (secret_enc IS NOT NULL) AS hat_secret FROM credentials WHERE task_id = ?',
    taskId,
  );
  if (!zugaenge.length) return { text: 'Für diese Aufgabe sind keine Zugänge hinterlegt.', zugaenge };
  const text = zugaenge.map((z) =>
    `Zugang ${z.id}: ${z.label}` +
    (z.url ? `\n  Adresse: ${z.url}` : '') +
    (z.username ? `\n  Benutzer: ${z.username}` : '') +
    `\n  Passwort: ${z.hat_secret ? 'im Tresor hinterlegt, wird beim Anmelden eingesetzt' : 'NICHT hinterlegt'}` +
    (z.has_mfa ? '\n  ACHTUNG: Zwei-Faktor-Authentifizierung aktiv - hier nicht anmelden, sondern Hilfe anfordern' : '') +
    (z.notes ? `\n  Hinweis: ${z.notes}` : ''),
  ).join('\n');
  return { text, zugaenge };
}

// Erreichbar ist nur, was aus den hinterlegten Zugaengen folgt - plus was
// ausdruecklich in AGENT_ERLAUBTE_DOMAINS freigegeben wurde.
function erlaubteDomains(zugaenge) {
  const aus = zugaenge.map((z) => normalisiereDomain(z.url)).filter(Boolean);
  return [...new Set([...aus, ...config.agentZusatzDomains.map(normalisiereDomain)])].filter(Boolean);
}

/**
 * Fuehrt die Automatisierung einer Aufgabe aus.
 * @param {number} taskId
 * @param {(art: string, text: string, daten?: object) => void} onEreignis  Fortschrittsmeldung
 */
export async function laufeAufgabe(taskId, onEreignis = () => {}) {
  const task = get('SELECT * FROM tasks WHERE id = ?', taskId);
  if (!task) throw new Error('Aufgabe nicht gefunden.');
  if (!task.prompt.trim()) throw new Error('Für diese Aufgabe ist kein Prompt hinterlegt.');

  const period = get('SELECT * FROM periods WHERE id = ?', task.period_id);
  const { text: zugangsText, zugaenge } = beschreibeZugaenge(taskId);
  const zielordner = buildFolderPath(period, task.title);
  const domains = erlaubteDomains(zugaenge);

  const eintrag = erfasse({
    period_id: task.period_id, task_id: taskId, type: 'ki_lauf',
    subject: `KI-Lauf: ${task.title}`, status: 'offen',
  }, period);

  const melde = (art, text, daten = {}) => {
    ereignis(eintrag.id, art, String(text).slice(0, 3000));
    onEreignis(art, text, daten);
  };

  if (!aiEnabled) {
    const hinweis = 'Kein ANTHROPIC_API_KEY gesetzt - die Automatisierung kann nicht laufen.';
    setzeStatus(eintrag.id, 'fehlgeschlagen', hinweis, hinweis);
    melde('abgebrochen', hinweis);
    return { logbook_id: eintrag.id, ticket: eintrag.ticket, status: 'fehlgeschlagen', hinweis, belege: [] };
  }
  if (!domains.length) {
    const hinweis = 'Kein Zugang mit Adresse hinterlegt - der Agent wüsste nicht, welche Seite er öffnen darf. ' +
      'Bitte bei der Aufgabe einen Zugang mit URL eintragen.';
    setzeStatus(eintrag.id, 'fehlgeschlagen', hinweis, hinweis);
    melde('abgebrochen', hinweis);
    return { logbook_id: eintrag.id, ticket: eintrag.ticket, status: 'fehlgeschlagen', hinweis, belege: [] };
  }

  melde('gestartet', `Zeitraum ${period.label} ${period.year}, erlaubte Domains: ${domains.join(', ')}`);

  const steuerung = new Browsersteuerung({ erlaubteDomains: domains });
  const ausfuehrung = new Werkzeugausfuehrung({
    steuerung, task, period,
    protokoll: (art, text) => melde(art, text),
  });

  const auftrag = [
    `Zeitraum: ${period.label} ${period.year} (${period.year}-${String(period.month).padStart(2, '0')})`,
    `Aufgabe: ${task.title}`,
    task.description ? `Beschreibung: ${task.description}` : null,
    '',
    'Arbeitsanweisung:',
    task.prompt,
    '',
    'Verfügbare Zugänge:',
    zugangsText,
    '',
    `Erlaubte Domains: ${domains.join(', ')}`,
    `Zielordner der Ablage: ${zielordner}`,
    '',
    'Beginne damit, die Adresse des passenden Zugangs zu öffnen.',
  ].filter((z) => z !== null).join('\n');

  const messages = [{ role: 'user', content: auftrag }];
  const beginn = Date.now();
  let schritte = 0;
  let fehlerzahl = 0;
  let ergebnis = null;

  try {
    await steuerung.starte();
    melde('browser', config.chromeCdpUrl ? 'Bestehendes Chrome übernommen.' : 'Browser gestartet.');

    while (true) {
      if (schritte >= config.agentMaxSchritte) {
        ergebnis = { art: 'grenze', grund: `Schrittgrenze von ${config.agentMaxSchritte} erreicht.` };
        break;
      }
      if ((Date.now() - beginn) / 1000 > config.agentMaxSekunden) {
        ergebnis = { art: 'grenze', grund: `Zeitgrenze von ${config.agentMaxSekunden} Sekunden erreicht.` };
        break;
      }

      const antwort = await client.messages.create({
        model: config.model,
        max_tokens: 8000,
        system: SYSTEM,
        tools: WERKZEUGE,
        messages,
      });

      if (antwort.stop_reason === 'refusal') {
        ergebnis = { art: 'abgelehnt', grund: antwort.stop_details?.explanation || 'ohne Angabe von Gründen' };
        break;
      }

      // Begleittext des Modells sichtbar machen - er erklaert die naechsten Schritte.
      for (const block of antwort.content) {
        if (block.type === 'text' && block.text.trim()) melde('überlegung', block.text.trim());
      }

      const aufrufe = antwort.content.filter((b) => b.type === 'tool_use');
      if (!aufrufe.length) {
        // Kein Werkzeugaufruf und kein Abschluss: das Modell ist stehengeblieben.
        ergebnis = { art: 'unklar', grund: 'Das Modell hat weder ein Werkzeug benutzt noch abgeschlossen.' };
        break;
      }

      messages.push({ role: 'assistant', content: antwort.content });

      const ergebnisse = [];
      for (const aufruf of aufrufe) {
        schritte++;
        melde('werkzeug', `${aufruf.name} ${knappeEingabe(aufruf.input)}`);
        const r = await ausfuehrung.fuehreAus(aufruf.name, aufruf.input);
        ergebnisse.push({
          type: 'tool_result',
          tool_use_id: aufruf.id,
          content: r.bloecke || r.text,
          ...(r.fehler ? { is_error: true } : {}),
        });
        if (r.fehler) { fehlerzahl++; melde('fehler', r.text); }
      }
      messages.push({ role: 'user', content: ergebnisse });

      if (ausfuehrung.abbruch) { ergebnis = ausfuehrung.abbruch; break; }
    }
  } catch (err) {
    ergebnis = { art: 'fehler', grund: err.message };
  } finally {
    await steuerung.schliesse();
  }

  const belege = ausfuehrung.abgelegt;
  const { status, hinweis } = bewerte(ergebnis, belege, schritte, fehlerzahl);
  setzeStatus(eintrag.id, status, hinweis, hinweis);
  melde('abgeschlossen', hinweis);

  return {
    logbook_id: eintrag.id, ticket: eintrag.ticket, status, hinweis,
    schritte, fehlerzahl, zielordner,
    belege: belege.map((b) => ({ id: b.id, filename: b.filename, storage_path: b.storage_path })),
    offene_punkte: ergebnis?.offene_punkte || '',
  };
}

// Bewertet den Lauf. Maßgeblich ist, was tatsächlich abgelegt wurde - nicht,
// was das Modell behauptet. Ein Modell, das "erledigt" meldet, ohne dass ein
// Beleg in der Ablage liegt, darf die Aufgabe nicht als erledigt markieren:
// in der Buchhaltung ist ein falsches Häkchen schlimmer als ein offener Punkt.
function bewerte(ergebnis, belege, schritte, fehlerzahl = 0) {
  const anzahl = `${belege.length} Beleg(e) abgelegt`;
  const zusatz = `(${anzahl}, ${schritte} Schritte${fehlerzahl ? `, ${fehlerzahl} Fehler` : ''})`;

  switch (ergebnis?.art) {
    case 'fertig': {
      // Ohne Beleg und mit Fehlern im Lauf ist die Zusammenfassung nicht belastbar.
      if (!belege.length && fehlerzahl > 0) {
        return {
          status: 'offen',
          hinweis:
            `Der Lauf meldet sich als fertig, es wurde aber kein Beleg abgelegt und es gab ${fehlerzahl} Fehler. ` +
            `Bitte prüfen. Meldung des Laufs: "${ergebnis.zusammenfassung}" ${zusatz}`,
        };
      }
      const zusammenfassung = belege.length
        ? ergebnis.zusammenfassung
        : `Kein Beleg gefunden. Meldung des Laufs: "${ergebnis.zusammenfassung}"`;
      return {
        status: 'erledigt',
        hinweis: [zusammenfassung, ergebnis.offene_punkte ? `Offen: ${ergebnis.offene_punkte}` : null, zusatz]
          .filter(Boolean).join(' '),
      };
    }
    case 'hilfe':
      return { status: 'offen', hinweis: `Manueller Eingriff nötig: ${ergebnis.grund} ${zusatz}` };
    case 'grenze':
      return { status: 'offen', hinweis: `Abgebrochen: ${ergebnis.grund} ${zusatz}` };
    case 'abgelehnt':
      return { status: 'fehlgeschlagen', hinweis: `Das Modell hat die Anfrage abgelehnt: ${ergebnis.grund}` };
    case 'fehler':
      return { status: 'fehlgeschlagen', hinweis: `Fehler im Lauf: ${ergebnis.grund} ${zusatz}` };
    default:
      return { status: 'offen', hinweis: `Lauf ohne klares Ergebnis beendet: ${ergebnis?.grund || 'unbekannt'} ${zusatz}` };
  }
}

function knappeEingabe(eingabe) {
  const teile = Object.entries(eingabe || {})
    .filter(([, v]) => v !== '' && v !== null && v !== undefined)
    .map(([k, v]) => `${k}=${String(v).slice(0, 70)}`);
  return teile.length ? `(${teile.join(', ')})` : '';
}
