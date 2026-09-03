// Bildet aus Einzelbuchungen Gruppen (z.B. 20 Abbuchungen "Google" -> eine
// Zeile "Google") und stellt ihnen die vorhandenen Belege gegenueber.

// Rechtsformen, Zahlungsdienstleister-Praefixe und Referenznummern stoeren die
// Gruppierung und werden vor dem Vergleich entfernt.
const RECHTSFORMEN = [
  'gmbh & co kg', 'gmbh und co kg', 'gmbh', 'ag', 'ug', 'kg', 'ohg', 'gbr', 'ev', 'se',
  'ltd', 'limited', 'inc', 'llc', 'plc', 'bv', 'nv', 'sarl', 'sa', 'spa', 'srl',
  'co', 'corp', 'company', 'haftungsbeschraenkt',
];
const ZAHLUNGSDIENSTLEISTER = ['paypal', 'stripe', 'klarna', 'adyen', 'sumup', 'mollie', 'shopify'];

export function normalizeName(value) {
  let s = String(value || '')
    .toLowerCase()
    .replace(/[äöüß]/g, (c) => ({ ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' }[c]))
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // "PayPal *Google" oder "PP.1234.PP / Google" -> "google"
  for (const psp of ZAHLUNGSDIENSTLEISTER) {
    const m = s.match(new RegExp(`^(?:pp\\s+\\d+\\s+pp\\s+)?${psp}\\s+(.+)$`));
    if (m && m[1].length > 2) { s = m[1]; break; }
  }

  s = s.split(' ')
    .filter((w) => w && !RECHTSFORMEN.includes(w))
    .filter((w) => !/^\d{4,}$/.test(w))   // reine Referenznummern
    .join(' ');

  return s.trim();
}

// Woerter, die als erstes Namenswort nichts unterscheiden - "Restaurant Adler"
// und "Restaurant Krone" duerfen nicht zusammenfallen.
const GENERISCHE_WOERTER = new Set([
  'restaurant', 'gaststaette', 'gasthaus', 'gasthof', 'hotel', 'pension', 'cafe', 'bar',
  'baeckerei', 'metzgerei', 'apotheke', 'praxis', 'kanzlei', 'buero', 'firma', 'agentur',
  'dr', 'prof', 'stadt', 'gemeinde', 'zum', 'zur', 'der', 'die', 'das', 'sankt', 'st',
  'deutsche', 'deutscher', 'deutsches', 'erste', 'neue', 'alte',
]);

// Der Gruppenschluessel ist der markanteste Namensteil. In aller Regel ist das
// das erste Wort - so fallen "Google Ireland", "Google Cloud" und "PayPal *Google"
// in eine Gruppe "Google", wie es fuer den Abgleich gebraucht wird. Nur wenn das
// erste Wort nichts unterscheidet, kommt das zweite dazu.
export function groupKeyFor(tx) {
  const basis = normalizeName(tx.counterparty) || normalizeName(tx.purpose);
  if (!basis) return 'ohne-zuordnung';
  const woerter = basis.split(' ').filter(Boolean);
  if (!woerter.length) return 'ohne-zuordnung';
  const anzahl = GENERISCHE_WOERTER.has(woerter[0]) ? 2 : 1;
  return woerter.slice(0, anzahl).join(' ');
}

// Anzeigename der Gruppe: der Schluessel in lesbarer Schreibweise.
// "google" -> "Google", "restaurant adler" -> "Restaurant Adler".
export function labelFor(tx, key) {
  if (!key || key === 'ohne-zuordnung') return 'Ohne Zuordnung';
  return key.split(' ')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Stellt Buchungsgruppen und Belege gegenueber.
 * @param {Array} transaktionen  Zeilen aus bank_tx
 * @param {Array} belege         Zeilen aus artifacts (mit vendor + amount_cents)
 * @param {Map}   ueberschreibungen  optional: group_key -> Anzeigename
 */
export function buildGroups(transaktionen, belege = []) {
  const gruppen = new Map();

  for (const tx of transaktionen) {
    const key = tx.group_key || groupKeyFor(tx);
    if (!gruppen.has(key)) {
      gruppen.set(key, {
        key,
        label: tx.group_label || labelFor(tx, key),
        buchungen: [],
        anzahl: 0,
        summe_cents: 0,
        belege: [],
        belege_anzahl: 0,
        belege_summe_cents: 0,
        differenz_cents: 0,
      });
    }
    const g = gruppen.get(key);
    g.buchungen.push(tx);
    g.anzahl += 1;
    g.summe_cents += tx.amount_cents;
  }

  // Belege denselben Schluessel zuordnen
  for (const beleg of belege) {
    const key = groupKeyFor({ counterparty: beleg.vendor, purpose: beleg.filename });
    const g = gruppen.get(key);
    if (!g) continue;
    g.belege.push(beleg);
    g.belege_anzahl += 1;
    g.belege_summe_cents += beleg.amount_cents || 0;
  }

  for (const g of gruppen.values()) {
    // Ausgaben stehen im Auszug negativ, Belege positiv - fuer die Differenz
    // wird der Betrag der Buchungen betragsmaessig verglichen.
    g.differenz_cents = Math.abs(g.summe_cents) - g.belege_summe_cents;
    g.vollstaendig = g.differenz_cents === 0 && g.belege_anzahl > 0;
    g.buchungen.sort((a, b) => a.booking_date.localeCompare(b.booking_date));
  }

  return [...gruppen.values()].sort((a, b) => Math.abs(b.summe_cents) - Math.abs(a.summe_cents));
}

export const formatEuro = (cents) =>
  (cents / 100).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
