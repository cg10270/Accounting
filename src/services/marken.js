import { normalizeName } from './bank/grouping.js';

// Wer steckt hinter dem Namen auf dem Kontoauszug?
//
// Der Bankauszug nennt die abrechnende Gesellschaft ("Facebook Ireland Ltd"),
// die Rechnung nennt die Marke ("Meta") - oder umgekehrt. Ohne eine
// gemeinsame Bezeichnung findet der Abgleich die beiden nie zusammen.
//
// Die Liste ist bewusst klein gehalten und deckt die Faelle ab, in denen
// Abrechner und Marke auseinanderfallen. Alles andere loest die Normalisierung
// des Namens von selbst.
export const MARKEN = {
  Meta: ['facebook', 'facebk', 'instagram', 'whatsapp', 'meta platforms', 'fb ads'],
  Google: ['google', 'youtube', 'alphabet', 'gsuite', 'doubleclick', 'firebase'],
  Microsoft: ['microsoft', 'msft', 'azure', 'office 365', 'microsoft 365', 'linkedin', 'github', 'skype'],
  Amazon: ['amazon', 'amzn', 'aws', 'audible', 'twitch'],
  Apple: ['apple', 'itunes', 'icloud'],
  Adobe: ['adobe', 'behance'],
  Salesforce: ['salesforce', 'slack'],
  Atlassian: ['atlassian', 'jira', 'confluence', 'trello', 'bitbucket'],
  OpenAI: ['openai', 'chatgpt'],
  Anthropic: ['anthropic', 'claude ai'],
  X: ['twitter', 'x corp'],
  TikTok: ['tiktok', 'bytedance'],
  HubSpot: ['hubspot'],
  Intuit: ['mailchimp', 'intuit'],
  Twilio: ['twilio', 'sendgrid'],
  Canva: ['canva'],
  Figma: ['figma'],
  Notion: ['notion'],
  Zoom: ['zoom video', 'zoom com', 'zoom'],
  Dropbox: ['dropbox'],
  Cloudflare: ['cloudflare'],
  Hetzner: ['hetzner'],
  IONOS: ['ionos', '1und1', '1 1 internet', 'united internet'],
  Strato: ['strato'],
  Telekom: ['telekom', 't mobile', 't online'],
  Vodafone: ['vodafone'],
  NFON: ['nfon'],
  Aircall: ['aircall'],
  Stripe: ['stripe'],
  PayPal: ['paypal'],
  Klarna: ['klarna'],
  Shopify: ['shopify'],
  Zapier: ['zapier'],
  Make: ['make com', 'integromat'],
  Miro: ['miro', 'realtimeboard'],
  Airtable: ['airtable'],
  Calendly: ['calendly'],
  Typeform: ['typeform'],
  DocuSign: ['docusign'],
  Lexware: ['lexoffice', 'lexware', 'haufe'],
  DATEV: ['datev'],
  Personio: ['personio'],
  Spotify: ['spotify'],
  Netflix: ['netflix'],
  'Deutsche Bahn': ['deutsche bahn', 'db vertrieb', 'db fernverkehr', 'bahn de'],
  Lufthansa: ['lufthansa', 'swiss int', 'austrian airlines'],
  Uber: ['uber'],
  Sixt: ['sixt'],
  'Booking.com': ['booking com', 'bookingcom'],
  Airbnb: ['airbnb'],
};

// Umgekehrter Index: Alias -> Marke, laengste Aliase zuerst, damit
// "microsoft 365" vor "microsoft" greift.
const ALIASSE = Object.entries(MARKEN)
  .flatMap(([marke, aliasse]) => aliasse.map((a) => [normalizeName(a, { psp: false }), marke]))
  .sort((a, b) => b[0].length - a[0].length);

/**
 * Bestimmt die Marke hinter einem Namen oder Buchungstext.
 * Liefert null, wenn nichts Bekanntes darin steckt - dann bleibt der
 * normalisierte Name selbst die Bezeichnung.
 */
export function erkenneMarke(text) {
  if (!text) return null;
  // Beide Lesarten pruefen: mit und ohne abgestreiften Zahlungsdienstleister.
  // "PayPal *Google" ist Google, "PayPal Europe" ist PayPal.
  const formen = [normalizeName(text), normalizeName(text, { psp: false })];
  for (const [alias, marke] of ALIASSE) {
    if (formen.some((f) => f === alias || f.includes(` ${alias} `) || f.startsWith(`${alias} `) || f.endsWith(` ${alias}`))) {
      return marke;
    }
  }
  return null;
}

/**
 * Die Bezeichnung, unter der Buchung und Beleg verglichen werden.
 * Bekannte Marke, sonst der markanteste Teil des Namens.
 */
export function vergleichsname(text) {
  const marke = erkenneMarke(text);
  if (marke) return marke.toLowerCase();
  const n = normalizeName(text);
  return n.split(' ').slice(0, 2).join(' ').trim();
}
