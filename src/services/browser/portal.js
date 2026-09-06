import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../../config.js';
import { get } from '../../db.js';
import { decryptSecret } from '../vault.js';
import { speichereDatei } from '../ablage.js';

// Oeffnet das Portal eines Lieferanten, meldet an und faengt alles ab, was in
// diesem Fenster heruntergeladen wird. Der Beleg landet damit unmittelbar beim
// richtigen Lieferanten im richtigen Monat - ohne Datei im Download-Ordner und
// ohne Hochladen von Hand.
//
// Anders als eine KI-Automatisierung bleibt der Mensch am Steuer: Zwei-Faktor,
// Captcha oder eine ungewohnte Maske sind kein Abbruch, sondern schlicht
// etwas, das du selbst im offenen Fenster erledigst.

const ANMELDE_WOERTER = /anmelden|einloggen|login|log in|sign in|weiter|continue|next|submit/i;

// Laufende Sitzungen, je Lieferant hoechstens eine.
const sitzungen = new Map();

async function ladePlaywright() {
  try {
    return (await import('playwright')).chromium;
  } catch {
    throw new Error('Playwright ist nicht installiert. Bitte "npm install" ausführen.');
  }
}

function profilVerzeichnis(lieferantId) {
  // Je Lieferant ein eigenes Profil: Anmeldungen bleiben erhalten, aber die
  // Portale sehen nichts voneinander.
  return path.join(config.chromeProfilDir, `lieferant-${lieferantId}`);
}

// Chromes eigener Passwortmanager wuerde die Zugangsdaten mitschneiden und
// womoeglich in ein Google-Konto synchronisieren - genau das soll der Tresor
// verhindern.
const CHROME_SCHALTER = [
  '--disable-background-networking',
  '--disable-sync',
  '--disable-features=AutofillServerCommunication,PasswordManagerOnboarding,PasswordLeakDetection,Translate,OptimizationHints,MediaRouter',
  '--disable-save-password-bubble',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-client-side-phishing-detection',
  '--password-store=basic',
];

function haerteProfil(profilDir) {
  const datei = path.join(profilDir, 'Default', 'Preferences');
  fs.mkdirSync(path.dirname(datei), { recursive: true });
  let prefs = {};
  if (fs.existsSync(datei)) {
    try { prefs = JSON.parse(fs.readFileSync(datei, 'utf8')); } catch { prefs = {}; }
  }
  prefs.credentials_enable_service = false;
  prefs.credentials_enable_autosignin = false;
  prefs.profile = { ...(prefs.profile || {}), password_manager_enabled: false };
  prefs.autofill = { ...(prefs.autofill || {}), profile_enabled: false, credit_card_enabled: false };
  fs.writeFileSync(datei, JSON.stringify(prefs));
}

/**
 * Oeffnet das Portal eines Lieferanten fuer einen Zeitraum.
 * @returns {Promise<object>} Zustand der Sitzung
 */
export async function oeffnePortal(lieferantId, periodId) {
  const lieferant = get('SELECT * FROM lieferanten WHERE id = ?', Number(lieferantId));
  if (!lieferant) throw new Error('Lieferant nicht gefunden.');
  if (!lieferant.url) throw new Error(`Für "${lieferant.name}" ist keine Portaladresse hinterlegt.`);
  const period = get('SELECT * FROM periods WHERE id = ?', Number(periodId));
  if (!period) throw new Error('Zeitraum nicht gefunden.');

  await schliessePortal(lieferantId).catch(() => {});

  const chromium = await ladePlaywright();
  const profilDir = profilVerzeichnis(lieferant.id);
  haerteProfil(profilDir);
  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), `portal-${lieferant.id}-`));

  const kontext = await chromium.launchPersistentContext(profilDir, {
    headless: !config.browserSichtbar,
    acceptDownloads: true,
    downloadsPath: downloadDir,
    viewport: null,
    args: CHROME_SCHALTER,
    ...(config.chromeExecutable ? { executablePath: config.chromeExecutable } : {}),
  });

  const sitzung = {
    lieferant, period, kontext, downloadDir,
    gestartet: Date.now(),
    uebernommen: [],   // was in diesem Fenster heruntergeladen und abgelegt wurde
    fehler: [],
  };
  sitzungen.set(lieferant.id, sitzung);

  // Downloads jeder Seite dieses Fensters abfangen, auch neu geoeffneter.
  const beobachte = (seite) => seite.on('download', (d) => uebernimmDownload(sitzung, d));
  kontext.on('page', beobachte);
  for (const s of kontext.pages()) beobachte(s);

  // Schliesst der Mensch das Fenster, endet die Sitzung von selbst.
  kontext.on('close', () => sitzungen.delete(lieferant.id));

  const seite = kontext.pages()[0] || await kontext.newPage();
  seite.setDefaultTimeout(30_000);
  sitzung.seite = seite;

  await seite.goto(lieferant.url, { waitUntil: 'domcontentloaded' });
  sitzung.anmeldung = await versucheAnmeldung(seite, lieferant);

  // Nach der Anmeldung direkt zur Rechnungsliste, wenn hinterlegt.
  if (lieferant.rechnungen_url) {
    await seite.goto(lieferant.rechnungen_url, { waitUntil: 'domcontentloaded' }).catch((err) => {
      sitzung.fehler.push(`Rechnungsseite konnte nicht geöffnet werden: ${err.message}`);
    });
  }

  return zustand(lieferant.id);
}

/**
 * Fuellt das Anmeldeformular. Das Passwort wird hier aus dem Tresor geholt und
 * unmittelbar ins Feld geschrieben - es verlaesst den Server nicht.
 *
 * Erkennt auch zweistufige Masken (erst Benutzer, dann Passwort), wie sie
 * grosse Anbieter verwenden.
 */
async function versucheAnmeldung(seite, lieferant) {
  if (!lieferant.username && !lieferant.secret_enc) {
    return { art: 'keine', text: 'Kein Zugang hinterlegt - bitte im Portal selbst anmelden.' };
  }

  const passwort = lieferant.secret_enc ? decryptSecret(lieferant.secret_enc) : '';
  const schritte = [];

  try {
    // Schon angemeldet? Dann gibt es kein Passwortfeld und keinen Anmeldeknopf.
    const hatPasswortfeld = await sichtbar(seite, lieferant.sel_passwort || 'input[type=password]');
    const hatBenutzerfeld = await sichtbar(seite, lieferant.sel_benutzer || benutzerAuswahl());

    if (!hatPasswortfeld && !hatBenutzerfeld) {
      return { art: 'bereits', text: 'Es war kein Anmeldeformular zu sehen - vermutlich bist du bereits angemeldet.' };
    }

    // Stufe 1: Benutzername
    if (lieferant.username && hatBenutzerfeld) {
      await fuelle(seite, lieferant.sel_benutzer || benutzerAuswahl(), lieferant.username);
      schritte.push('Benutzername eingetragen');
    }

    // Zweistufig: Passwortfeld erscheint erst nach dem Absenden.
    if (!hatPasswortfeld) {
      await abschicken(seite, lieferant.sel_absenden);
      schritte.push('Weiter geklickt');
      await seite.waitForTimeout(1200);
      await seite.waitForSelector(lieferant.sel_passwort || 'input[type=password]', { timeout: 10_000 })
        .catch(() => {});
    }

    if (passwort && await sichtbar(seite, lieferant.sel_passwort || 'input[type=password]')) {
      await fuelle(seite, lieferant.sel_passwort || 'input[type=password]', passwort);
      schritte.push('Passwort eingesetzt');
      await abschicken(seite, lieferant.sel_absenden);
      schritte.push('Anmeldung abgeschickt');
      await seite.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
    }

    if (lieferant.has_mfa) {
      return {
        art: 'mfa',
        text: `${schritte.join(', ')}. Dieser Zugang verlangt einen Bestätigungscode - bitte im Fenster eingeben.`,
      };
    }
    return { art: 'ok', text: schritte.length ? schritte.join(', ') + '.' : 'Nichts auszufüllen gefunden.' };
  } catch (err) {
    // Eine misslungene Anmeldung ist kein Abbruch: das Fenster steht offen,
    // du machst es von Hand.
    return { art: 'fehler', text: `Automatische Anmeldung nicht möglich (${err.message}). Bitte im Fenster selbst anmelden.` };
  }
}

const benutzerAuswahl = () =>
  'input[type=email], input[type=text], input[name*=user i], input[name*=email i], input[id*=user i], input[id*=email i]';

async function sichtbar(seite, auswahl) {
  const ziel = seite.locator(auswahl).first();
  return ziel.isVisible({ timeout: 3_000 }).catch(() => false);
}

async function fuelle(seite, auswahl, wert) {
  await seite.locator(auswahl).first().fill(wert, { timeout: 10_000 });
}

async function abschicken(seite, selektor) {
  if (selektor) { await seite.locator(selektor).first().click({ timeout: 10_000 }); return; }

  const knoepfe = seite.locator('button[type=submit], input[type=submit], button');
  const anzahl = await knoepfe.count();
  for (let i = 0; i < Math.min(anzahl, 25); i++) {
    const knopf = knoepfe.nth(i);
    if (!await knopf.isVisible().catch(() => false)) continue;
    const text = ((await knopf.innerText().catch(() => '')) || (await knopf.getAttribute('value')) || '').trim();
    const typ = await knopf.getAttribute('type');
    if (typ === 'submit' || ANMELDE_WOERTER.test(text)) {
      await knopf.click({ timeout: 10_000 });
      return;
    }
  }
  // Kein passender Knopf gefunden - viele Formulare senden auch mit Enter.
  await seite.keyboard.press('Enter');
}

// --- Downloads --------------------------------------------------------------

async function uebernimmDownload(sitzung, download) {
  const name = download.suggestedFilename() || `beleg-${Date.now()}.pdf`;
  const zwischen = path.join(sitzung.downloadDir, `${Date.now()}-${name}`);
  try {
    await download.saveAs(zwischen);
    const inhalt = fs.readFileSync(zwischen);

    const datei = await speichereDatei({
      periodId: sitzung.period.id,
      filename: name,
      mime: mimeFuer(name),
      buffer: inhalt,
      source: 'portal',
      ordner: sitzung.lieferant.name,
    });
    // Zuordnung setzen, damit der Beleg sofort gegen die Bank rechnet.
    const { run } = await import('../../db.js');
    run('UPDATE artifacts SET lieferant_id = ?, vendor = ? WHERE id = ?',
      sitzung.lieferant.id, sitzung.lieferant.name, datei.id);

    sitzung.uebernommen.push({ id: datei.id, filename: datei.filename, groesse: inhalt.length });
  } catch (err) {
    sitzung.fehler.push(`${name}: ${err.message}`);
  }
}

function mimeFuer(dateiname) {
  const endung = String(dateiname).toLowerCase().split('.').pop();
  return {
    pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    csv: 'text/csv', xml: 'application/xml', zip: 'application/zip',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  }[endung] || 'application/octet-stream';
}

// --- Zustand und Ende --------------------------------------------------------

export function zustand(lieferantId) {
  const s = sitzungen.get(Number(lieferantId));
  if (!s) return { offen: false };
  return {
    offen: true,
    lieferant: s.lieferant.name,
    lieferant_id: s.lieferant.id,
    period_id: s.period.id,
    anmeldung: s.anmeldung,
    uebernommen: s.uebernommen,
    fehler: s.fehler,
    laeuft_seit: Math.round((Date.now() - s.gestartet) / 1000),
  };
}

export function offeneSitzungen() {
  return [...sitzungen.keys()].map((id) => zustand(id));
}

export async function schliessePortal(lieferantId) {
  const s = sitzungen.get(Number(lieferantId));
  if (!s) return { offen: false };
  const ergebnis = zustand(lieferantId);
  sitzungen.delete(Number(lieferantId));
  await s.kontext.close().catch(() => {});
  fs.rmSync(s.downloadDir, { recursive: true, force: true });
  return { ...ergebnis, offen: false, geschlossen: true };
}

export async function schliesseAlle() {
  for (const id of [...sitzungen.keys()]) await schliessePortal(id).catch(() => {});
}
