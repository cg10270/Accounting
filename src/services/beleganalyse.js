import Anthropic from '@anthropic-ai/sdk';
import { config, aiEnabled } from '../config.js';

// Liest eine hochgeladene Quittung aus und schlaegt die Belegfelder vor.
// Claude bekommt das PDF bzw. Bild direkt - kein separates OCR noetig.
// Was nicht sicher lesbar ist, bleibt leer und wird in der Oberflaeche erfragt;
// erfundene Betraege waeren im Steuerkontext schlimmer als eine Luecke.

const client = aiEnabled ? new Anthropic({ apiKey: config.anthropicApiKey }) : null;

const SYSTEM = `Du liest Quittungen und Rechnungen fuer die deutsche Buchhaltung aus.
Du uebernimmst ausschliesslich Angaben, die tatsaechlich auf dem Beleg stehen.
Was nicht zweifelsfrei lesbar ist, laesst du leer und vermerkst es unter offene_punkte.
Du raetst niemals einen Betrag, ein Datum oder einen Namen.
Betraege gibst du in Cent als ganze Zahl an (12,90 Euro entspricht 1290).`;

const WERKZEUG = {
  name: 'belegdaten_ausgeben',
  description: 'Gibt die aus dem Beleg gelesenen Daten strukturiert zurueck.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      lesbar: { type: 'boolean', description: 'Ist der Beleg ausreichend lesbar?' },
      belegart: { type: 'string', enum: ['bewirtung', 'hotel', 'transport', 'sonstiges', 'unbekannt'] },
      haendler: { type: 'string', description: 'Name des Restaurants, Hotels oder Anbieters' },
      strasse: { type: 'string' },
      plz: { type: 'string' },
      ort: { type: 'string' },
      datum: { type: 'string', description: 'Belegdatum im Format JJJJ-MM-TT, sonst leer' },
      brutto_cents: { type: 'integer', description: 'Rechnungsbetrag brutto in Cent, 0 wenn nicht lesbar' },
      trinkgeld_cents: { type: 'integer', description: 'Ausgewiesenes Trinkgeld in Cent, 0 wenn keines' },
      ust_cents: { type: 'integer', description: 'Ausgewiesene Umsatzsteuer in Cent, 0 wenn nicht ausgewiesen' },
      zahlungsart: { type: 'string', description: 'z.B. Kreditkarte, EC, bar - leer wenn unbekannt' },
      rechnungsempfaenger: { type: 'string', description: 'Auf wen die Rechnung ausgestellt ist, leer wenn ohne Angabe' },
      positionen: {
        type: 'array',
        description: 'Einzelpositionen, soweit lesbar',
        items: {
          type: 'object',
          properties: {
            bezeichnung: { type: 'string' },
            betrag_cents: { type: 'integer' },
          },
          required: ['bezeichnung', 'betrag_cents'],
          additionalProperties: false,
        },
      },
      offene_punkte: {
        type: 'array',
        description: 'Angaben, die beim Nutzer erfragt werden muessen',
        items: { type: 'string' },
      },
    },
    required: ['lesbar', 'belegart', 'haendler', 'strasse', 'plz', 'ort', 'datum', 'brutto_cents',
      'trinkgeld_cents', 'ust_cents', 'zahlungsart', 'rechnungsempfaenger', 'positionen', 'offene_punkte'],
    additionalProperties: false,
  },
};

const PFLICHTFELDER = {
  bewirtung: [
    ['haendler', 'Name der Gaststätte'],
    ['ort', 'Ort der Bewirtung'],
    ['datum', 'Tag der Bewirtung'],
    ['brutto_cents', 'Rechnungsbetrag'],
  ],
  spesen: [
    ['haendler', 'Name des Anbieters'],
    ['datum', 'Belegdatum'],
    ['brutto_cents', 'Rechnungsbetrag'],
  ],
};

export async function analysiereQuittung({ buffer, mime, filename, art = 'bewirtung' }) {
  if (!aiEnabled) {
    return {
      ki: false,
      lesbar: false,
      hinweis: 'Kein ANTHROPIC_API_KEY gesetzt - der Beleg wurde nicht ausgelesen. Bitte die Felder manuell ausfüllen.',
      offene_punkte: (PFLICHTFELDER[art] || PFLICHTFELDER.bewirtung).map(([, label]) => label),
      positionen: [],
    };
  }

  const typ = String(mime || '').toLowerCase();
  let anhang;
  if (typ.includes('pdf')) {
    anhang = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } };
  } else if (typ.includes('png') || typ.includes('jpeg') || typ.includes('jpg') || typ.includes('webp')) {
    const medienTyp = typ.includes('png') ? 'image/png' : typ.includes('webp') ? 'image/webp' : 'image/jpeg';
    anhang = { type: 'image', source: { type: 'base64', media_type: medienTyp, data: buffer.toString('base64') } };
  } else {
    throw new Error(`Belege vom Typ ${mime || 'unbekannt'} können nicht ausgelesen werden (PDF, PNG oder JPEG).`);
  }

  const auftrag = art === 'spesen'
    ? 'Lies diesen Reisebeleg (Hotel, Flug, Bahn oder Buchungsportal) aus.'
    : 'Lies diese Bewirtungsquittung aus.';

  const response = await client.messages.create({
    model: config.model,
    max_tokens: 16000,
    system: SYSTEM,
    tools: [WERKZEUG],
    tool_choice: { type: 'tool', name: WERKZEUG.name },
    messages: [{
      role: 'user',
      content: [anhang, { type: 'text', text: `${auftrag}\nDateiname: ${filename || 'unbekannt'}` }],
    }],
  });

  if (response.stop_reason === 'refusal') {
    throw new Error(`Auslesen abgelehnt: ${response.stop_details?.explanation || 'kein Grund angegeben'}`);
  }
  const block = response.content.find((b) => b.type === 'tool_use' && b.name === WERKZEUG.name);
  if (!block) throw new Error('Der Beleg konnte nicht ausgelesen werden.');

  const daten = block.input;
  // Fehlende Pflichtangaben ergaenzen die Rueckfragenliste, damit die
  // Oberflaeche gezielt nachfragen kann.
  const offen = new Set(daten.offene_punkte || []);
  for (const [feld, label] of PFLICHTFELDER[art] || PFLICHTFELDER.bewirtung) {
    if (!daten[feld]) offen.add(label);
  }
  if (art === 'bewirtung') {
    offen.add('Bewirtete Personen (alle Teilnehmer namentlich)');
    offen.add('Konkreter Anlass der Bewirtung');
  }
  return { ki: true, ...daten, offene_punkte: [...offen] };
}
