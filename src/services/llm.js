import Anthropic from '@anthropic-ai/sdk';
import { config, aiEnabled } from '../config.js';

// Ein einziger Client fuer alle KI-Aufrufe. Ohne API-Key laeuft das System im
// Mock-Modus weiter, damit die Oberflaeche vollstaendig testbar bleibt.
const client = aiEnabled ? new Anthropic({ apiKey: config.anthropicApiKey }) : null;

const AUFGABEN_SYSTEM = `Du unterstuetzt die monatliche Vorbereitung einer deutschen Finanzbuchhaltung.
Du erstellst und pflegst Aufgabenlisten fuer die Belegvorbereitung: Belege beschaffen,
sortieren, pruefen und ablegen - bis zur Uebergabe an die Steuerkanzlei.
Formuliere Aufgaben knapp, konkret und in der Reihenfolge, in der man sie sinnvoll abarbeitet.
Jede Aufgabe beschreibt genau einen abschliessbaren Schritt. Antworte auf Deutsch.`;

// Strict Tool Use erzwingt ein schemakonformes Ergebnis - kein Nachparsen von Freitext.
const AUFGABEN_TOOL = {
  name: 'aufgabenliste_ausgeben',
  description: 'Gibt die vollstaendige Aufgabenliste fuer die Buchhaltungsvorbereitung zurueck.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      aufgaben: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Kurzer Aufgabentitel, max. 80 Zeichen' },
            description: { type: 'string', description: 'Was konkret zu tun ist, 1-3 Saetze' },
            category: {
              type: 'string',
              description: 'Grobe Einordnung',
              enum: ['belege', 'bank', 'lohn', 'steuern', 'abgleich', 'abschluss', 'allgemein'],
            },
            prompt: {
              type: 'string',
              description: 'Arbeitsanweisung fuer die spaetere KI-Automatisierung dieser Aufgabe. Leer lassen, wenn die Aufgabe nur manuell erledigt werden kann.',
            },
          },
          required: ['title', 'description', 'category', 'prompt'],
          additionalProperties: false,
        },
      },
    },
    required: ['aufgaben'],
    additionalProperties: false,
  },
};

function firstToolInput(response, toolName) {
  for (const block of response.content) {
    if (block.type === 'tool_use' && block.name === toolName) return block.input;
  }
  throw new Error('Die KI hat kein verwertbares Ergebnis geliefert.');
}

/**
 * Erzeugt oder ueberarbeitet eine Aufgabenliste.
 * @param {string} anweisung  Freitext-Prompt des Nutzers
 * @param {Array}  bestand    Bereits vorhandene Aufgaben (fuer Aenderungen/Erweiterungen)
 */
export async function generiereAufgaben(anweisung, bestand = []) {
  if (!aiEnabled) return mockAufgaben(anweisung, bestand);

  const kontext = bestand.length
    ? `\n\nBestehende Aufgabenliste (als JSON):\n${JSON.stringify(
        bestand.map((t) => ({ title: t.title, description: t.description, category: t.category, prompt: t.prompt })),
        null, 2,
      )}\n\nGib die vollstaendige neue Liste zurueck - uebernimm unveraendert, was bleiben soll, und setze die Aenderung um.`
    : '';

  const response = await client.messages.create({
    model: config.model,
    max_tokens: 16000,
    system: AUFGABEN_SYSTEM,
    tools: [AUFGABEN_TOOL],
    tool_choice: { type: 'tool', name: AUFGABEN_TOOL.name },
    messages: [{ role: 'user', content: anweisung + kontext }],
  });

  if (response.stop_reason === 'refusal') {
    throw new Error(`Anfrage wurde abgelehnt: ${response.stop_details?.explanation || 'kein Grund angegeben'}`);
  }
  const { aufgaben } = firstToolInput(response, AUFGABEN_TOOL.name);
  return aufgaben;
}

/**
 * Freier Aufruf fuer die Automatisierung einer einzelnen Aufgabe.
 * Zugangsdaten werden hier bewusst NICHT mitgegeben - der Aufrufer uebergibt
 * nur Referenzen; das Einloesen passiert erst im Browser-Agenten.
 */
export async function frageClaude({ system, prompt, maxTokens = 16000 }) {
  if (!aiEnabled) {
    return `[Mock-Modus] Kein ANTHROPIC_API_KEY gesetzt. Der Prompt wäre gewesen:\n\n${prompt}`;
  }
  const response = await client.messages.create({
    model: config.model,
    max_tokens: maxTokens,
    ...(system ? { system } : {}),
    messages: [{ role: 'user', content: prompt }],
  });
  if (response.stop_reason === 'refusal') {
    throw new Error(`Anfrage wurde abgelehnt: ${response.stop_details?.explanation || 'kein Grund angegeben'}`);
  }
  return response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}

// --- Mock-Modus -------------------------------------------------------------

const STANDARD_AUFGABEN = [
  ['Eingangsrechnungen sammeln', 'Alle Eingangsrechnungen des Monats aus Postfach und Portalen zusammentragen und ablegen.', 'belege', 'Durchsuche das Postfach nach Rechnungen des Zeitraums und lege jede als PDF ab.'],
  ['Ausgangsrechnungen exportieren', 'Gestellte Rechnungen aus dem Rechnungsprogramm exportieren und ablegen.', 'belege', 'Exportiere alle Ausgangsrechnungen des Zeitraums als PDF.'],
  ['Kreditkartenabrechnung laden', 'Monatsabrechnung der Firmenkreditkarte aus dem Portal herunterladen.', 'bank', 'Melde dich im Kreditkartenportal an und lade die Abrechnung des Zeitraums.'],
  ['Bankauszug importieren', 'Kontoauszug als CSV exportieren und im Bankabgleich hochladen.', 'bank', ''],
  ['Bewirtungs- und Reisekosten erfassen', 'Belege der Mitarbeitenden einsammeln und Spesenabrechnungen erstellen.', 'belege', ''],
  ['Bankabgleich durchführen', 'Buchungsgruppen mit den vorhandenen Belegen abgleichen und Lücken anfordern.', 'abgleich', ''],
  ['Lohnunterlagen bereitstellen', 'Lohnabrechnungen und Beitragsnachweise des Monats ablegen.', 'lohn', ''],
  ['Unterlagen an die Kanzlei übergeben', 'Vollständigkeit prüfen und den Monatsordner freigeben.', 'abschluss', ''],
];

function mockAufgaben(anweisung, bestand) {
  const neu = STANDARD_AUFGABEN.map(([title, description, category, prompt]) => ({ title, description, category, prompt }));
  if (!bestand.length) return neu;
  const vorhanden = new Set(bestand.map((t) => t.title.toLowerCase()));
  return [
    ...bestand.map((t) => ({ title: t.title, description: t.description, category: t.category, prompt: t.prompt })),
    ...neu.filter((t) => !vorhanden.has(t.title.toLowerCase())).slice(0, 2),
  ];
}

export { aiEnabled };
