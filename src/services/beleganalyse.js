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

// --- Eingangsrechnungen aus dem Postfach -------------------------------------

const RECHNUNG_SYSTEM = `Du liest Eingangsrechnungen fuer die deutsche Buchhaltung aus.
Du uebernimmst ausschliesslich Angaben, die tatsaechlich auf dem Beleg stehen.
Was nicht zweifelsfrei lesbar ist, laesst du leer bzw. auf 0.
Du raetst niemals einen Betrag, ein Datum oder einen Namen.
Betraege gibst du in Cent als ganze Zahl an (12,90 Euro entspricht 1290).
Der Aussteller ist der Rechnungssteller, nicht der Empfaenger (die LexAid GmbH).
Du kennst die Konzerne hinter den Marken und nennst sie: eine Rechnung von
"Facebook Ireland Ltd" gehoert zu Meta, eine von "Google Ireland Ltd" zu Google.`;

function rechnungWerkzeug(lieferanten) {
  return {
    name: 'rechnungsdaten_ausgeben',
    description: 'Gibt die aus der Eingangsrechnung gelesenen Daten strukturiert zurueck.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        lesbar: { type: 'boolean', description: 'Ist der Beleg eine lesbare Rechnung oder Quittung?' },
        aussteller: { type: 'string', description: 'Firmenname des Rechnungsstellers, leer wenn nicht lesbar' },
        rechnungsnummer: { type: 'string' },
        datum: { type: 'string', description: 'Rechnungsdatum im Format JJJJ-MM-TT, sonst leer' },
        brutto_cents: { type: 'integer', description: 'Endbetrag brutto in Cent, 0 wenn nicht lesbar' },
        ust_cents: { type: 'integer', description: 'Ausgewiesene Umsatzsteuer in Cent, 0 wenn nicht ausgewiesen' },
        waehrung: { type: 'string', description: 'Waehrungskuerzel, z.B. EUR oder USD' },
        leistung: { type: 'string', description: 'Was abgerechnet wird, in wenigen Worten' },
        marke: {
          type: 'string',
          description: 'Die Marke oder der Konzern hinter dem Aussteller, unter der die Zahlung im '
            + 'Kontoauszug erscheint. Beispiele: "Facebook Ireland Ltd" -> Meta, "Google Ireland Ltd" -> Google, '
            + '"Microsoft Ireland Operations" -> Microsoft. Bei kleinen Anbietern der Firmenname selbst.',
        },
        lieferant: {
          type: 'string',
          description: 'Passender Lieferant aus der Stammdatenliste. Leer lassen, wenn keiner sicher passt.',
          enum: ['', ...lieferanten.map((l) => l.name)],
        },
        begruendung: { type: 'string', description: 'Ein Satz: woran der Lieferant erkannt wurde' },
      },
      required: ['lesbar', 'aussteller', 'rechnungsnummer', 'datum', 'brutto_cents', 'ust_cents',
        'waehrung', 'leistung', 'marke', 'lieferant', 'begruendung'],
      additionalProperties: false,
    },
  };
}

// Claude liest PDFs und Bilder unmittelbar - ein separates OCR gibt es nicht.
function anhangBlock(buffer, mime, filename) {
  const typ = `${mime || ''} ${filename || ''}`.toLowerCase();
  if (typ.includes('pdf')) {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } };
  }
  if (/png|jpe?g|webp/.test(typ)) {
    const medienTyp = typ.includes('png') ? 'image/png' : typ.includes('webp') ? 'image/webp' : 'image/jpeg';
    return { type: 'image', source: { type: 'base64', media_type: medienTyp, data: buffer.toString('base64') } };
  }
  throw new Error(`Belege vom Typ ${mime || 'unbekannt'} können nicht ausgelesen werden (PDF, PNG oder JPEG).`);
}

/**
 * Liest eine Eingangsrechnung aus und ordnet sie einem Lieferanten der
 * Stammdaten zu. Die Zuordnung ist ein Vorschlag - entschieden wird in der
 * Oberflaeche.
 * @param {object} p
 * @param {Buffer} p.buffer
 * @param {string} p.mime
 * @param {string} p.filename
 * @param {Array}  p.lieferanten  [{ id, name }]
 * @param {string} p.absender     Absender der Mail, als zusaetzlicher Hinweis
 * @param {string} p.betreff      Betreff der Mail, als zusaetzlicher Hinweis
 */
export async function analysiereRechnung({ buffer, mime, filename, lieferanten = [], absender = '', betreff = '' }) {
  if (!aiEnabled) {
    return {
      ki: false,
      lesbar: false,
      hinweis: 'Kein ANTHROPIC_API_KEY gesetzt - der Beleg wurde nicht ausgelesen.',
    };
  }

  const werkzeug = rechnungWerkzeug(lieferanten);
  const response = await client.messages.create({
    model: config.model,
    max_tokens: 4000,
    system: RECHNUNG_SYSTEM,
    tools: [werkzeug],
    tool_choice: { type: 'tool', name: werkzeug.name },
    messages: [{
      role: 'user',
      content: [
        anhangBlock(buffer, mime, filename),
        {
          type: 'text',
          text: [
            'Lies diese Eingangsrechnung aus und ordne sie einem Lieferanten zu.',
            `Dateiname: ${filename || 'unbekannt'}`,
            absender ? `Mail von: ${absender}` : '',
            betreff ? `Betreff: ${betreff}` : '',
            '',
            'Stammdaten-Lieferanten:',
            ...lieferanten.map((l) => `- ${l.name}`),
          ].filter(Boolean).join('\n'),
        },
      ],
    }],
  });

  if (response.stop_reason === 'refusal') {
    throw new Error(`Auslesen abgelehnt: ${response.stop_details?.explanation || 'kein Grund angegeben'}`);
  }
  const block = response.content.find((b) => b.type === 'tool_use' && b.name === werkzeug.name);
  if (!block) throw new Error('Der Beleg konnte nicht ausgelesen werden.');

  const daten = block.input;
  const gewaehlt = daten.lieferant ? lieferanten.find((l) => l.name === daten.lieferant) : null;
  return { ki: true, ...daten, lieferant: gewaehlt ? { id: gewaehlt.id, name: gewaehlt.name } : null };
}
