// CSV-Import fuer Kontoauszuege. Deutsche Banken exportieren sehr
// unterschiedlich: Semikolon oder Komma, Latin-1 oder UTF-8, Vorspannzeilen
// vor der eigentlichen Kopfzeile, Betraege als "1.234,56". Der Parser erkennt
// das selbst und laesst sich in der Oberflaeche pro Spalte korrigieren.

const KANDIDATEN = {
  booking_date: ['buchungstag', 'buchungsdatum', 'datum', 'belegdatum', 'buchung'],
  value_date: ['wertstellung', 'valuta', 'wertstellungstag', 'valutadatum'],
  counterparty: ['beguenstigter', 'begünstigter', 'zahlungspflichtiger', 'auftraggeber',
    'empfaenger', 'empfänger', 'name', 'beguenstigter/zahlungspflichtiger',
    'begünstigter/zahlungspflichtiger', 'transaktionsbeschreibung', 'partnername'],
  purpose: ['verwendungszweck', 'buchungstext', 'vorgang', 'beschreibung', 'referenz', 'zweck'],
  amount: ['betrag', 'umsatz', 'soll/haben', 'betrag (eur)', 'betrag in eur', 'wert'],
  currency: ['waehrung', 'währung', 'currency', 'wkz'],
};

export function decodeBuffer(buffer) {
  const utf8 = buffer.toString('utf8');
  // U+FFFD zeigt an, dass die Bytes kein gueltiges UTF-8 waren.
  return utf8.includes('�') ? buffer.toString('latin1') : utf8;
}

export function detectDelimiter(text) {
  const probe = text.split(/\r?\n/).slice(0, 20).join('\n');
  const counts = [';', ',', '\t', '|'].map((d) => [d, (probe.split(d).length - 1)]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ';';
}

// RFC-4180-konform inkl. verdoppelter Anfuehrungszeichen im Feld.
export function parseRows(text, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else field += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === delimiter) { row.push(field); field = ''; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    if (c === '\r') continue;
    field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

const norm = (s) => String(s || '').trim().toLowerCase().replace(/[."']/g, '');

// Die Kopfzeile ist die erste Zeile, in der mindestens ein Datums- und ein
// Betragsfeld erkannt wird - so werden Vorspannzeilen uebersprungen.
export function findHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const cells = rows[i].map(norm);
    const hatDatum = cells.some((c) => KANDIDATEN.booking_date.includes(c));
    const hatBetrag = cells.some((c) => KANDIDATEN.amount.includes(c));
    if (hatDatum && hatBetrag) return i;
  }
  return 0;
}

export function mapColumns(headerCells) {
  const cells = headerCells.map(norm);
  const mapping = {};
  for (const [feld, namen] of Object.entries(KANDIDATEN)) {
    let idx = cells.findIndex((c) => namen.includes(c));
    if (idx === -1) idx = cells.findIndex((c) => c && namen.some((n) => c.includes(n)));
    if (idx !== -1) mapping[feld] = idx;
  }
  return mapping;
}

export function parseAmountToCents(value) {
  let s = String(value ?? '').trim();
  if (!s) return null;
  let vorzeichen = 1;
  if (/^\(.*\)$/.test(s)) { vorzeichen = -1; s = s.slice(1, -1); }
  if (/[SH]$/i.test(s) && /\d/.test(s)) {           // Soll/Haben-Kennzeichen
    if (/S$/i.test(s)) vorzeichen = -1;
    s = s.replace(/[SH]$/i, '').trim();
  }
  s = s.replace(/[^\d.,+-]/g, '');
  if (!s) return null;
  if (s.startsWith('-')) { vorzeichen *= -1; s = s.slice(1); }
  if (s.startsWith('+')) s = s.slice(1);

  // Welches Zeichen trennt die Nachkommastellen?
  //   beide vorhanden   -> das hintere trennt, das andere gruppiert Tausender
  //   nur eines, mehrfach -> alle gruppieren ("1.234.567")
  //   nur eines, einfach  -> genau drei Ziffern dahinter heisst gruppieren
  //                          ("1.000" sind tausend Euro, nicht eins), sonst
  //                          trennt es die Nachkommastellen ("84.20")
  const punkte = (s.match(/\./g) || []).length;
  const kommas = (s.match(/,/g) || []).length;

  if (punkte && kommas) {
    const trenner = s.lastIndexOf(',') > s.lastIndexOf('.') ? ',' : '.';
    const gruppierer = trenner === ',' ? '.' : ',';
    s = s.split(gruppierer).join('');
    s = s.replace(trenner, '.');
  } else if (punkte + kommas > 1) {
    s = s.replace(/[.,]/g, '');
  } else if (punkte + kommas === 1) {
    const zeichen = punkte ? '.' : ',';
    const stelle = s.indexOf(zeichen);
    const vorher = s.slice(0, stelle);
    // Drei Ziffern dahinter sprechen fuer eine Tausendergruppe - aber nur,
    // wenn davor ueberhaupt etwas von null Verschiedenes steht. "0,005" ist
    // ein Bruchteil, keine fuenf.
    const gruppiert = stelle === s.length - 4 && /^\d+$/.test(vorher) && !/^0+$/.test(vorher);
    s = gruppiert ? s.replace(zeichen, '') : s.replace(zeichen, '.');
  }
  const zahl = Number(s);
  if (!Number.isFinite(zahl)) return null;
  return Math.round(zahl * 100) * vorzeichen;
}

export function parseDate(value) {
  const s = String(value ?? '').trim();
  if (!s) return '';
  let m = s.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2,4})/);
  if (m) {
    let [, d, mo, y] = m;
    if (y.length === 2) y = String(2000 + Number(y));
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[0] : '';
}

/**
 * Liest einen CSV-Puffer ein.
 * @param {Buffer} buffer
 * @param {object} override  optionales Spalten-Mapping aus der Oberflaeche
 */
export function parseStatement(buffer, override = null) {
  const text = decodeBuffer(buffer);
  const delimiter = detectDelimiter(text);
  const rows = parseRows(text, delimiter);
  if (!rows.length) throw new Error('Die Datei enthaelt keine lesbaren Zeilen.');

  const headerIndex = findHeader(rows);
  const header = rows[headerIndex];
  const mapping = override && Object.keys(override).length ? override : mapColumns(header);

  if (mapping.amount === undefined || mapping.booking_date === undefined) {
    throw new Error(
      'Betrags- oder Datumsspalte nicht erkannt. Erkannte Kopfzeile: ' +
      header.join(' | ') + ' - bitte Spalten manuell zuordnen.',
    );
  }

  const cell = (row, key) => (mapping[key] === undefined ? '' : String(row[mapping[key]] ?? '').trim());
  const transaktionen = [];
  const verworfen = [];

  for (const row of rows.slice(headerIndex + 1)) {
    const cents = parseAmountToCents(cell(row, 'amount'));
    const datum = parseDate(cell(row, 'booking_date'));
    if (cents === null || !datum) { verworfen.push(row.join(delimiter)); continue; }
    transaktionen.push({
      booking_date: datum,
      value_date: parseDate(cell(row, 'value_date')) || datum,
      counterparty: cell(row, 'counterparty'),
      purpose: cell(row, 'purpose'),
      amount_cents: cents,
      currency: cell(row, 'currency') || 'EUR',
      raw: row.join(delimiter),
    });
  }

  return { delimiter, header, headerIndex, mapping, transaktionen, verworfen };
}
