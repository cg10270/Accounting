// Legt die monatliche Checkliste an: Bereiche, Lieferanten und Positionen.
// Mehrfach ausfuehrbar - Vorhandenes wird nicht doppelt angelegt.
//
//   npm run seed:checkliste
//
// Die Portaladressen sind die Startseiten der Anbieter und sollten nach der
// ersten Anmeldung durch die direkte Rechnungsadresse ergaenzt werden
// (Lieferanten > Aendern > "Direkt zu den Rechnungen").
import { get } from './db.js';
import { legeAn as legeLieferantAn, listeLieferanten } from './services/lieferanten.js';
import { legeBereichAn, legePositionAn, listeBereiche } from './services/checkliste.js';

const LIEFERANTEN = [
  { name: 'Finom',            url: 'https://app.finom.co',                          muster: ['finom'] },
  { name: 'Cleverlohn',       url: '',                                              muster: ['cleverlohn'] },
  { name: 'Stripe',           url: 'https://dashboard.stripe.com',                  muster: ['stripe'] },
  { name: 'Google Ads',       url: 'https://ads.google.com',                        muster: ['google ads', 'google adwords'] },
  { name: 'Meta Ads',         url: 'https://business.facebook.com',                 muster: ['meta platforms', 'facebook'] },
  { name: 'LinkedIn Ads',     url: 'https://www.linkedin.com/campaignmanager',      muster: ['linkedin'] },
  { name: 'OpenAI',           url: 'https://platform.openai.com',                   muster: ['openai'] },
  { name: 'Anthropic',        url: 'https://console.anthropic.com',                 muster: ['anthropic', 'claude'] },
  { name: 'Google Workspace', url: 'https://admin.google.com',                      muster: ['google workspace', 'google cloud', 'gsuite'] },
  { name: 'HubSpot',          url: 'https://app.hubspot.com',                       muster: ['hubspot'] },
  { name: 'Slack',            url: 'https://slack.com',                             muster: ['slack'] },
  { name: 'Canva',            url: 'https://www.canva.com',                         muster: ['canva'] },
];

const CHECKLISTE = [
  { nummer: 1, name: 'Bank & Zahlungsverkehr', positionen: [
    { name: 'Finom mt49.sta',            lieferant: 'Finom', hinweis: 'Buchungsdatei für DATEV' },
    { name: 'Finom Monatsauszug',        lieferant: 'Finom', hinweis: 'Auch als CSV laden und oben importieren' },
    { name: 'Finom Gebührenabrechnung',  lieferant: 'Finom' },
    { name: 'Kreditkartenbelege Finom',  lieferant: 'Finom', hinweis: 'Einzelbelege zu den Kartenumsätzen' },
  ]},
  { nummer: 2, name: 'Personal', positionen: [
    { name: 'Cleverlohn Buchungsliste DATEV', lieferant: 'Cleverlohn' },
  ]},
  { nummer: 3, name: 'Stripe', positionen: [
    { name: 'Rechnungen',      lieferant: 'Stripe' },
    { name: 'Gutschriften',    lieferant: 'Stripe' },
    { name: 'Offene Posten',   lieferant: 'Stripe' },
    { name: 'Zahlungsausfälle', lieferant: 'Stripe' },
    { name: 'Payout Report',   lieferant: 'Stripe' },
    { name: 'Gebührenreport',  lieferant: 'Stripe' },
  ]},
  { nummer: 4, name: 'Eingangsrechnungen', positionen: [
    { name: 'DATEV/Gotess Upload' },
    { name: 'Fehlende Belege',        hinweis: 'Kürzel an der Buchung eintragen — das System fragt per Mail an' },
    { name: 'Wiederkehrende Abbucher', hinweis: 'Buchungen ohne Lieferant unten in dieser Ansicht' },
  ]},
  { nummer: 5, name: 'Werbekosten', positionen: [
    { name: 'Google Ads',   lieferant: 'Google Ads' },
    { name: 'Meta Ads',     lieferant: 'Meta Ads' },
    { name: 'LinkedIn Ads', lieferant: 'LinkedIn Ads' },
  ]},
  { nummer: 6, name: 'Software & SaaS', positionen: [
    { name: 'OpenAI',            lieferant: 'OpenAI' },
    { name: 'Anthropic (Claude)', lieferant: 'Anthropic' },
    { name: 'Google Workspace',  lieferant: 'Google Workspace' },
    { name: 'HubSpot',           lieferant: 'HubSpot' },
    { name: 'Slack',             lieferant: 'Slack' },
    { name: 'Canva',             lieferant: 'Canva' },
  ]},
  { nummer: 7, name: 'Reisen & Auslagen', positionen: [
    { name: 'Reisekosten',  hinweis: 'Spesenabrechnung unter "Belege erstellen"' },
    { name: 'Bewirtungen',  hinweis: 'Bewirtungsbeleg unter "Belege erstellen"' },
    { name: 'Auslagen' },
  ]},
  { nummer: 8, name: 'Monatsabschluss', positionen: [
    { name: 'Abgleich Bank / Belege',   hinweis: 'Alle Differenzen in dieser Ansicht auf null' },
    { name: 'Rückfragen an Mitarbeiter', hinweis: 'Stand der Anfragen im Logbuch' },
    { name: 'Monatsprüfung' },
  ]},
];

// --- Anlegen -----------------------------------------------------------------

const vorhandeneLieferanten = new Map(listeLieferanten().map((l) => [l.name, l]));
let neueLieferanten = 0;

for (const l of LIEFERANTEN) {
  if (vorhandeneLieferanten.has(l.name)) continue;
  vorhandeneLieferanten.set(l.name, legeLieferantAn(l));
  neueLieferanten++;
}

const vorhandeneBereiche = new Map(listeBereiche().map((b) => [b.name, b]));
let neueBereiche = 0;
let neuePositionen = 0;

for (const bereich of CHECKLISTE) {
  let ziel = vorhandeneBereiche.get(bereich.name);
  if (!ziel) {
    ziel = legeBereichAn({ name: bereich.name, nummer: bereich.nummer });
    vorhandeneBereiche.set(bereich.name, ziel);
    neueBereiche++;
  }
  for (const p of bereich.positionen) {
    const schon = get('SELECT id FROM positionen WHERE bereich_id = ? AND name = ?', ziel.id, p.name);
    if (schon) continue;
    legePositionAn({
      bereich_id: ziel.id,
      name: p.name,
      hinweis: p.hinweis || '',
      lieferant_id: p.lieferant ? vorhandeneLieferanten.get(p.lieferant)?.id ?? null : null,
    });
    neuePositionen++;
  }
}

console.log(`Checkliste: ${neueBereiche} Bereich(e), ${neuePositionen} Position(en), ${neueLieferanten} Lieferant(en) angelegt.`);
if (neueLieferanten) {
  console.log('\nHinweise:');
  console.log('  - Die Portaladressen sind Startseiten. Nach der ersten Anmeldung');
  console.log('    unter Lieferanten > Ändern die direkte Rechnungsadresse eintragen.');
  console.log('  - Zugangsdaten sind noch nicht hinterlegt.');
  console.log('  - "Google Ads" und "Google Workspace" erscheinen im Kontoauszug oft');
  console.log('    beide nur als "GOOGLE". Wenn die Zuordnung danebengeht, die Muster');
  console.log('    anhand des echten Buchungstexts nachschärfen.');
}
