import fs from 'node:fs';
import { get } from '../../db.js';
import { decryptSecret } from '../vault.js';
import { speichereDatei } from '../ablage.js';

// Werkzeuge, die der Agent im Browser benutzen darf.
//
// Der Werkzeugsatz ist bewusst klein. Es gibt insbesondere KEIN Werkzeug zum
// Ausfuehren beliebigen JavaScripts und keines zum Hochladen von Dateien: der
// Agent soll Belege holen, nicht im Portal etwas veraendern.

export const WERKZEUGE = [
  {
    name: 'seite_oeffnen',
    description: 'Öffnet eine Adresse im Browser. Nur Domains der hinterlegten Zugänge sind erreichbar.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Vollständige Adresse inklusive https://' } },
      required: ['url'], additionalProperties: false,
    },
  },
  {
    name: 'seite_lesen',
    description: 'Liest den aktuellen Seitenzustand neu ein. Nach jeder Aktion ändern sich die Element-Nummern, deshalb bei Unsicherheit neu lesen.',
    strict: true,
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'klicken',
    description: 'Klickt das Element mit der angegebenen Nummer aus der Elementliste.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        ref: { type: 'integer', description: 'Nummer des Elements' },
        warum: { type: 'string', description: 'Kurz: was soll der Klick bewirken' },
      },
      required: ['ref', 'warum'], additionalProperties: false,
    },
  },
  {
    name: 'tippen',
    description: 'Schreibt Text in ein Eingabefeld. Für Passwörter NICHT verwenden - dafür gibt es anmelden.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        ref: { type: 'integer' },
        text: { type: 'string' },
        absenden: { type: 'boolean', description: 'Anschließend Enter drücken' },
      },
      required: ['ref', 'text', 'absenden'], additionalProperties: false,
    },
  },
  {
    name: 'anmelden',
    description:
      'Meldet mit einem hinterlegten Zugang an. Benutzername und Passwort werden serverseitig aus dem Tresor geholt und direkt in die Felder geschrieben - du bekommst sie nie zu sehen und brauchst sie auch nicht.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        zugang_id: { type: 'integer', description: 'ID des Zugangs aus der Aufgabenbeschreibung' },
        benutzer_ref: { type: 'integer', description: 'Nummer des Benutzernamen-Feldes, -1 wenn nicht vorhanden' },
        passwort_ref: { type: 'integer', description: 'Nummer des Passwort-Feldes, -1 wenn nicht vorhanden' },
        absenden_ref: { type: 'integer', description: 'Nummer der Anmelde-Schaltfläche, -1 für Enter' },
      },
      required: ['zugang_id', 'benutzer_ref', 'passwort_ref', 'absenden_ref'], additionalProperties: false,
    },
  },
  {
    name: 'warten',
    description: 'Wartet einige Sekunden, etwa während eine Seite oder ein Download lädt.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: { sekunden: { type: 'integer', description: '1 bis 30' } },
      required: ['sekunden'], additionalProperties: false,
    },
  },
  {
    name: 'bildschirmfoto',
    description: 'Liefert ein Bild der aktuellen Seite. Nützlich, wenn der Text allein nicht weiterhilft.',
    strict: true,
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'download_liste',
    description: 'Zeigt die bisher heruntergeladenen Dateien mit ihrer Nummer.',
    strict: true,
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'beleg_ablegen',
    description:
      'Legt eine heruntergeladene Datei als Beleg im Zielordner ab. Erst aufrufen, wenn die Datei wirklich heruntergeladen wurde.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        download_nr: { type: 'integer', description: 'Nummer aus download_liste' },
        dateiname: { type: 'string', description: 'Ablagename, Muster JJJJ-MM-TT_Lieferant_Betrag.pdf' },
        lieferant: { type: 'string', description: 'Name für den Bankabgleich, leer wenn unbekannt' },
        betrag_euro: { type: 'string', description: 'Bruttobetrag wie auf dem Beleg, z. B. 84,20 - leer wenn unbekannt' },
        datum: { type: 'string', description: 'Belegdatum als JJJJ-MM-TT, leer wenn unbekannt' },
      },
      required: ['download_nr', 'dateiname', 'lieferant', 'betrag_euro', 'datum'], additionalProperties: false,
    },
  },
  {
    name: 'hilfe_anfordern',
    description:
      'Bricht ab und fordert einen Menschen an - etwa bei Zwei-Faktor-Abfrage, Captcha, geänderter Anmeldung oder wenn ein Zugang fehlt.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: { grund: { type: 'string', description: 'Was genau blockiert, und was der Mensch tun müsste' } },
      required: ['grund'], additionalProperties: false,
    },
  },
  {
    name: 'fertig',
    description: 'Beendet den Lauf. Erst aufrufen, wenn alle erreichbaren Belege abgelegt sind.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        zusammenfassung: { type: 'string', description: 'Was wurde geholt, was fehlt und warum' },
        offene_punkte: { type: 'string', description: 'Was ein Mensch noch prüfen sollte, leer wenn nichts' },
      },
      required: ['zusammenfassung', 'offene_punkte'], additionalProperties: false,
    },
  },
];

// Der Seitenzustand wird als knapper Text uebergeben - eine HTML-Seite roh in
// den Kontext zu kippen kostet ein Vielfaches an Tokens ohne Mehrwert.
export function formatiereZustand(z) {
  const elemente = z.elemente.map((e) => {
    const marke = e.passwortfeld ? ' [Passwortfeld]' : '';
    return `  [${e.ref}] ${e.art}${marke} ${e.text || '(ohne Beschriftung)'}`;
  }).join('\n');
  return [
    `Seite: ${z.titel}`,
    `Adresse: ${z.url}`,
    '',
    'Sichtbarer Text:',
    z.text || '(kein Text)',
    '',
    `Bedienelemente (${z.elemente.length}):`,
    elemente || '  (keine)',
  ].join('\n');
}

export class Werkzeugausfuehrung {
  /**
   * @param {object} kontext  { steuerung, task, period, protokoll }
   */
  constructor(kontext) {
    Object.assign(this, kontext);
    this.abgelegt = [];
    this.abbruch = null;     // { art: 'hilfe' | 'fertig', ... }
  }

  async fuehreAus(name, eingabe) {
    const fn = this[`w_${name}`];
    if (!fn) return { text: `Unbekanntes Werkzeug "${name}".`, fehler: true };
    try {
      return await fn.call(this, eingabe);
    } catch (err) {
      // Fehler gehen als Ergebnis zurueck, nicht als Ausnahme: das Modell soll
      // sich davon erholen koennen (Element weg, Seite langsam, Klick daneben).
      return { text: `Fehler: ${err.message}`, fehler: true };
    }
  }

  async w_seite_oeffnen({ url }) {
    return { text: formatiereZustand(await this.steuerung.oeffne(url)) };
  }
  async w_seite_lesen() {
    return { text: formatiereZustand(await this.steuerung.zustand()) };
  }
  async w_klicken({ ref }) {
    return { text: formatiereZustand(await this.steuerung.klicke(ref)) };
  }
  async w_tippen({ ref, text, absenden }) {
    return { text: formatiereZustand(await this.steuerung.tippe(ref, text, { absenden })) };
  }
  async w_warten({ sekunden }) {
    return { text: formatiereZustand(await this.steuerung.warte(sekunden)) };
  }

  async w_anmelden({ zugang_id, benutzer_ref, passwort_ref, absenden_ref }) {
    const zugang = get('SELECT * FROM credentials WHERE id = ? AND task_id = ?', Number(zugang_id), this.task.id);
    if (!zugang) throw new Error(`Zugang ${zugang_id} gehört nicht zu dieser Aufgabe.`);
    if (zugang.has_mfa) {
      throw new Error(
        'Dieser Zugang ist mit Zwei-Faktor-Authentifizierung geschützt. ' +
        'Melde dich nicht an, sondern rufe hilfe_anfordern auf.',
      );
    }
    if (!zugang.secret_enc) throw new Error(`Für Zugang ${zugang_id} ist kein Passwort hinterlegt. Bitte hilfe_anfordern aufrufen.`);

    // Das Passwort existiert nur innerhalb dieses Aufrufs.
    const passwort = decryptSecret(zugang.secret_enc);
    const zustand = await this.steuerung.melde_an({
      benutzerRef: benutzer_ref >= 0 ? benutzer_ref : null,
      passwortRef: passwort_ref >= 0 ? passwort_ref : null,
      benutzer: zugang.username,
      passwort,
      absendenRef: absenden_ref >= 0 ? absenden_ref : null,
    });
    return { text: `Anmeldung mit "${zugang.label}" versucht.\n\n${formatiereZustand(zustand)}` };
  }

  async w_bildschirmfoto() {
    const bild = await this.steuerung.screenshot();
    return {
      bloecke: [
        { type: 'text', text: 'Aktuelle Ansicht:' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: bild.toString('base64') } },
      ],
    };
  }

  async w_download_liste() {
    const liste = this.steuerung.downloads;
    if (!liste.length) return { text: 'Es wurde noch nichts heruntergeladen.' };
    return {
      text: liste.map((d, i) =>
        `  [${i}] ${d.dateiname}${d.pfad ? ` (${Math.round(d.groesse / 1024)} kB)` : ` — FEHLER: ${d.fehler}`}`,
      ).join('\n'),
    };
  }

  async w_beleg_ablegen({ download_nr, dateiname, lieferant, betrag_euro, datum }) {
    const download = this.steuerung.downloads[Number(download_nr)];
    if (!download) throw new Error(`Es gibt keinen Download mit der Nummer ${download_nr}.`);
    if (!download.pfad) throw new Error(`Download ${download_nr} ist fehlgeschlagen: ${download.fehler}`);

    const inhalt = fs.readFileSync(download.pfad);
    const datei = await speichereDatei({
      periodId: this.task.period_id,
      taskId: this.task.id,
      filename: dateiname || download.dateiname,
      mime: mimeFuer(dateiname || download.dateiname),
      buffer: inhalt,
      source: 'ki',
    });

    const cents = betragZuCents(betrag_euro);
    if (lieferant || cents !== null || datum) {
      const { run } = await import('../../db.js');
      run('UPDATE artifacts SET vendor = ?, amount_cents = ?, doc_date = ? WHERE id = ?',
        lieferant || '', cents, datum || null, datei.id);
    }
    this.abgelegt.push(datei);
    this.protokoll?.('beleg abgelegt', `${datei.filename} → ${datei.storage_path}`);
    return { text: `Abgelegt als "${datei.filename}" unter ${datei.storage_path}.` };
  }

  async w_hilfe_anfordern({ grund }) {
    this.abbruch = { art: 'hilfe', grund };
    return { text: 'Verstanden - der Lauf wird beendet und ein Mensch übernimmt.' };
  }

  async w_fertig({ zusammenfassung, offene_punkte }) {
    this.abbruch = { art: 'fertig', zusammenfassung, offene_punkte };
    return { text: 'Lauf beendet.' };
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

function betragZuCents(wert) {
  const s = String(wert || '').trim();
  if (!s) return null;
  const zahl = Number(s.replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(zahl) && zahl !== 0 ? Math.round(Math.abs(zahl) * 100) : null;
}
