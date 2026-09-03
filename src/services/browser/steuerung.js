import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { config } from '../../config.js';

// Steuerung eines echten Chrome-Browsers fuer die Belegbeschaffung.
//
// Zwei Betriebsarten:
//   CHROME_CDP_URL gesetzt -> ein bereits laufendes Chrome wird uebernommen
//     (Start mit: chrome --remote-debugging-port=9222). Vorhandene Anmeldungen
//     und Cookies bleiben damit erhalten - das erspart viele Portal-Logins.
//   sonst -> eigenes, dauerhaftes Profilverzeichnis. Auch dort bleiben
//     Anmeldungen ueber Laeufe hinweg bestehen.

const KLICKBAR = 'a, button, input, select, textarea, [role=button], [role=link], [role=tab], [onclick]';

// Chrome soll ausschliesslich das tun, was der Agent ihm sagt. Ohne diese
// Schalter meldet der Browser im Hintergrund an Google-Dienste - und, was
// schwerer wiegt, sein Passwortmanager wuerde die Portal-Zugangsdaten
// mitschneiden und womoeglich in ein Google-Konto synchronisieren. Genau das
// soll der Tresor verhindern.
const CHROME_SCHALTER = [
  '--disable-background-networking',
  '--disable-sync',
  '--disable-features=AutofillServerCommunication,PasswordManagerOnboarding,PasswordLeakDetection,Translate,OptimizationHints,MediaRouter',
  '--disable-save-password-bubble',
  '--no-first-run',
  '--no-default-browser-check',
  '--no-service-autorun',
  '--disable-client-side-phishing-detection',
  '--password-store=basic',
];

// Zusaetzlich die Profileinstellungen setzen - die Schalter allein deaktivieren
// den Passwortmanager nicht zuverlaessig.
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

export class Browsersteuerung {
  constructor({ erlaubteDomains = [], downloadDir } = {}) {
    this.erlaubteDomains = erlaubteDomains.map(normalisiereDomain).filter(Boolean);
    this.downloadDir = downloadDir || fs.mkdtempSync(path.join(os.tmpdir(), 'buchhaltung-'));
    this.downloads = [];
    this.browser = null;
    this.kontext = null;
    this.seite = null;
  }

  async starte() {
    fs.mkdirSync(this.downloadDir, { recursive: true });

    if (config.chromeCdpUrl) {
      this.browser = await chromium.connectOverCDP(config.chromeCdpUrl);
      this.kontext = this.browser.contexts()[0] || await this.browser.newContext({ acceptDownloads: true });
      this.seite = this.kontext.pages()[0] || await this.kontext.newPage();
    } else {
      haerteProfil(config.chromeProfilDir);
      this.kontext = await chromium.launchPersistentContext(config.chromeProfilDir, {
        headless: !config.browserSichtbar,
        acceptDownloads: true,
        downloadsPath: this.downloadDir,
        args: CHROME_SCHALTER,
        ...(config.chromeExecutable ? { executablePath: config.chromeExecutable } : {}),
      });
      this.seite = this.kontext.pages()[0] || await this.kontext.newPage();
    }

    this.seite.setDefaultTimeout(20_000);

    // Heruntergeladene Dateien einsammeln, damit sie spaeter abgelegt werden koennen.
    this.kontext.on('page', (p) => p.on('download', (d) => this.#nimmDownload(d)));
    this.seite.on('download', (d) => this.#nimmDownload(d));
    return this;
  }

  async #nimmDownload(download) {
    const name = download.suggestedFilename() || `download-${this.downloads.length + 1}`;
    const ziel = path.join(this.downloadDir, `${Date.now()}-${name}`);
    try {
      await download.saveAs(ziel);
      this.downloads.push({ dateiname: name, pfad: ziel, groesse: fs.statSync(ziel).size });
    } catch (err) {
      this.downloads.push({ dateiname: name, pfad: null, fehler: err.message });
    }
  }

  // --- Sicherheitsgrenze -----------------------------------------------------

  // Der Agent steuert einen Browser mit bestehenden Anmeldungen. Ohne Schranke
  // koennte ein irregefuehrtes Modell auf beliebigen Seiten landen - deshalb
  // sind nur die Domains der hinterlegten Zugaenge erreichbar.
  pruefeDomain(url) {
    let ziel;
    try { ziel = new URL(url); } catch { throw new Error(`"${url}" ist keine gültige Adresse.`); }
    if (!['http:', 'https:'].includes(ziel.protocol)) {
      throw new Error(`Das Protokoll ${ziel.protocol} ist nicht zugelassen.`);
    }
    const host = normalisiereDomain(ziel.hostname);
    const erlaubt = this.erlaubteDomains.some((d) => host === d || host.endsWith(`.${d}`));
    if (!erlaubt) {
      throw new Error(
        `Die Domain ${host} ist für diese Aufgabe nicht freigegeben. ` +
        `Erlaubt sind: ${this.erlaubteDomains.join(', ') || '(keine)'}. ` +
        'Zugelassen werden die Domains der hinterlegten Zugänge sowie AGENT_ERLAUBTE_DOMAINS.',
      );
    }
    return ziel.toString();
  }

  // --- Aktionen --------------------------------------------------------------

  async oeffne(url) {
    const geprueft = this.pruefeDomain(url);
    await this.seite.goto(geprueft, { waitUntil: 'domcontentloaded' });
    return this.zustand();
  }

  async klicke(ref) {
    const ziel = this.seite.locator(`[data-ki-ref="${Number(ref)}"]`);
    if (!await ziel.count()) throw new Error(`Element ${ref} gibt es auf dieser Seite nicht (mehr). Bitte die Seite neu lesen.`);
    await ziel.first().click({ timeout: 15_000 });
    await this.#beruhigen();
    return this.zustand();
  }

  async tippe(ref, text, { absenden = false } = {}) {
    const ziel = this.seite.locator(`[data-ki-ref="${Number(ref)}"]`);
    if (!await ziel.count()) throw new Error(`Element ${ref} gibt es auf dieser Seite nicht (mehr). Bitte die Seite neu lesen.`);
    await ziel.first().fill(String(text));
    if (absenden) { await ziel.first().press('Enter'); await this.#beruhigen(); }
    return this.zustand();
  }

  /**
   * Fuellt ein Anmeldeformular. Das Passwort wird hier hineingereicht und
   * unmittelbar in das Feld geschrieben - es steht nirgends im Modellkontext
   * und wird auch nicht zurueckgegeben.
   */
  async melde_an({ benutzerRef, passwortRef, benutzer, passwort, absendenRef }) {
    if (benutzerRef != null && benutzer) await this.tippe(benutzerRef, benutzer);
    if (passwortRef != null && passwort) {
      const feld = this.seite.locator(`[data-ki-ref="${Number(passwortRef)}"]`);
      if (!await feld.count()) throw new Error(`Passwortfeld ${passwortRef} nicht gefunden.`);
      await feld.first().fill(passwort);
    }
    if (absendenRef != null) await this.klicke(absendenRef);
    else { await this.seite.keyboard.press('Enter'); await this.#beruhigen(); }
    return this.zustand();
  }

  async warte(sekunden = 2) {
    await this.seite.waitForTimeout(Math.min(Math.max(Number(sekunden) || 1, 1), 30) * 1000);
    return this.zustand();
  }

  async #beruhigen() {
    // Nach einer Aktion kurz auf Netzwerkruhe warten, aber nie daran haengen
    // bleiben: viele Portale halten dauerhaft offene Verbindungen.
    await this.seite.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
  }

  async screenshot() {
    return this.seite.screenshot({ type: 'png', fullPage: false });
  }

  /**
   * Verdichteter Seitenzustand: sichtbarer Text plus durchnummerierte
   * Bedienelemente. Die Nummern sind die Handhabe fuer klicke() und tippe().
   */
  async zustand() {
    const daten = await this.seite.evaluate((auswahl) => {
      document.querySelectorAll('[data-ki-ref]').forEach((el) => el.removeAttribute('data-ki-ref'));

      const sichtbar = (el) => {
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return false;
        const s = getComputedStyle(el);
        return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
      };
      const beschriftung = (el) => {
        const kandidaten = [
          el.getAttribute('aria-label'),
          el.labels?.[0]?.innerText,
          el.getAttribute('placeholder'),
          el.getAttribute('title'),
          el.getAttribute('name'),
          el.getAttribute('value'),
          el.innerText,
          el.getAttribute('alt'),
        ];
        return (kandidaten.find((k) => k && k.trim()) || '').trim().replace(/\s+/g, ' ').slice(0, 90);
      };

      const elemente = [];
      let ref = 0;
      for (const el of document.querySelectorAll(auswahl)) {
        if (!sichtbar(el) || el.disabled) continue;
        el.setAttribute('data-ki-ref', String(++ref));
        const typ = el.tagName === 'INPUT' ? (el.type || 'text') : el.tagName.toLowerCase();
        elemente.push({
          ref,
          art: typ,
          text: beschriftung(el),
          ...(el.tagName === 'A' && el.href ? { ziel: el.href.slice(0, 160) } : {}),
          ...(typ === 'password' ? { passwortfeld: true } : {}),
        });
        if (ref >= 150) break;
      }

      const text = (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 6000);
      return { titel: document.title, url: location.href, text, elemente };
    }, KLICKBAR);

    return daten;
  }

  async schliesse() {
    try {
      if (config.chromeCdpUrl) await this.browser?.close();
      else await this.kontext?.close();
    } catch { /* ein bereits geschlossener Browser ist kein Fehler */ }
  }
}

function normalisiereDomain(wert) {
  let s = String(wert || '').trim().toLowerCase();
  if (!s) return '';
  if (s.includes('://')) { try { s = new URL(s).hostname; } catch { return ''; } }
  return s.replace(/^www\./, '');
}

export { normalisiereDomain };
