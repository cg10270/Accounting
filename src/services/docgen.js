import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { BEWIRTUNG, REISEKOSTEN, euro, datumDe } from './steuerregeln.js';

// Erstellung von Eigenbelegen als PDF und Zusammenfuehrung mit der
// Originalquittung zu einem kombinierten Dokument.

const A4 = [595.28, 841.89];
const RAND = 56;
const SCHWARZ = rgb(0.1, 0.1, 0.12);
const GRAU = rgb(0.42, 0.44, 0.48);
const LINIE = rgb(0.8, 0.81, 0.84);

class Seite {
  constructor(pdf, fonts) {
    this.pdf = pdf;
    this.fonts = fonts;
    this.page = pdf.addPage(A4);
    this.y = A4[1] - RAND;
  }
  neueSeiteWennNoetig(hoehe) {
    if (this.y - hoehe < RAND) {
      this.page = this.pdf.addPage(A4);
      this.y = A4[1] - RAND;
    }
  }
  text(value, { size = 10, bold = false, farbe = SCHWARZ, x = RAND, dy = 14 } = {}) {
    this.neueSeiteWennNoetig(dy);
    this.page.drawText(sauber(value), {
      x, y: this.y, size, font: bold ? this.fonts.bold : this.fonts.regular, color: farbe,
    });
    this.y -= dy;
    return this;
  }
  titel(value) { return this.text(value, { size: 17, bold: true, dy: 26 }); }
  abschnitt(value) { this.luft(6); return this.text(value.toUpperCase(), { size: 8, bold: true, farbe: GRAU, dy: 14 }); }
  // Beschriftung links, Wert rechts daneben - das Standardlayout des Belegs.
  feld(label, wert, { bold = false } = {}) {
    this.neueSeiteWennNoetig(17);
    this.page.drawText(sauber(label), { x: RAND, y: this.y, size: 9.5, font: this.fonts.regular, color: GRAU });
    this.page.drawText(sauber(wert), {
      x: RAND + 165, y: this.y, size: 10,
      font: bold ? this.fonts.bold : this.fonts.regular, color: SCHWARZ,
    });
    this.y -= 17;
    return this;
  }
  // Mehrzeiliger Wert mit einfachem Wortumbruch
  block(label, wert, breite = 330) {
    const zeilen = umbrechen(sauber(wert), this.fonts.regular, 10, breite);
    this.neueSeiteWennNoetig(17 * Math.max(zeilen.length, 1));
    this.page.drawText(sauber(label), { x: RAND, y: this.y, size: 9.5, font: this.fonts.regular, color: GRAU });
    for (const zeile of zeilen.length ? zeilen : ['']) {
      this.page.drawText(zeile, { x: RAND + 165, y: this.y, size: 10, font: this.fonts.regular, color: SCHWARZ });
      this.y -= 15;
    }
    this.y -= 2;
    return this;
  }
  trennlinie() {
    this.neueSeiteWennNoetig(14);
    this.y -= 4;
    this.page.drawLine({
      start: { x: RAND, y: this.y }, end: { x: A4[0] - RAND, y: this.y },
      thickness: 0.7, color: LINIE,
    });
    this.y -= 12;
    return this;
  }
  luft(h = 10) { this.y -= h; return this; }
  unterschriftsfeld(beschriftung) {
    this.neueSeiteWennNoetig(60);
    this.y -= 34;
    this.page.drawLine({
      start: { x: RAND, y: this.y }, end: { x: RAND + 220, y: this.y },
      thickness: 0.7, color: SCHWARZ,
    });
    this.y -= 12;
    this.page.drawText(sauber(beschriftung), { x: RAND, y: this.y, size: 8.5, font: this.fonts.regular, color: GRAU });
    this.y -= 16;
    return this;
  }
  fussnote(value) {
    const zeilen = umbrechen(sauber(value), this.fonts.regular, 8, A4[0] - 2 * RAND);
    this.neueSeiteWennNoetig(11 * zeilen.length);
    for (const zeile of zeilen) {
      this.page.drawText(zeile, { x: RAND, y: this.y, size: 8, font: this.fonts.regular, color: GRAU });
      this.y -= 11;
    }
    return this;
  }
}

// pdf-lib schreibt die Standardschriften in WinAnsi. Zeichen ausserhalb dieses
// Vorrats (z.B. Emoji, geschweifte Anfuehrungszeichen) wuerden einen Fehler
// ausloesen, deshalb werden sie vorher ersetzt.
function sauber(value) {
  return String(value ?? '')
    .replace(/[‘’‚]/g, "'")
    .replace(/[“”„]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/[^\x20-\x7E\xA0-\xFF€]/g, '');
}

function umbrechen(text, font, size, maxBreite) {
  const zeilen = [];
  for (const absatz of String(text).split('\n')) {
    let aktuell = '';
    for (const wort of absatz.split(/\s+/).filter(Boolean)) {
      const versuch = aktuell ? `${aktuell} ${wort}` : wort;
      if (font.widthOfTextAtSize(versuch, size) > maxBreite && aktuell) {
        zeilen.push(aktuell);
        aktuell = wort;
      } else aktuell = versuch;
    }
    zeilen.push(aktuell);
  }
  return zeilen.filter((z, i, a) => z !== '' || a.length === 1);
}

async function neuesDokument() {
  const pdf = await PDFDocument.create();
  const fonts = {
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
  };
  return { pdf, seite: new Seite(pdf, fonts), fonts };
}

/**
 * Bewirtungsbeleg nach § 4 Abs. 5 Satz 1 Nr. 2 EStG.
 * Pflichtangaben: Tag, Ort, bewirtete Personen, Anlass, Hoehe der Aufwendungen,
 * Unterschrift des Bewirtenden. Die Originalrechnung ist beizufuegen.
 */
export async function erstelleBewirtungsbeleg(d) {
  const brutto = Number(d.brutto_cents || 0);
  const trinkgeld = Number(d.trinkgeld_cents || 0);
  const gesamt = brutto + trinkgeld;
  const abziehbar = Math.round(gesamt * BEWIRTUNG.abziehbar_anteil);
  const nichtAbziehbar = gesamt - abziehbar;

  const { pdf, seite } = await neuesDokument();

  seite.titel('Bewirtungsbeleg');
  seite.text(`Eigenbeleg zur Bewirtung aus geschäftlichem Anlass - ${BEWIRTUNG.rechtsgrundlage}`,
    { size: 9, farbe: GRAU, dy: 20 });
  seite.trennlinie();

  seite.abschnitt('Bewirtung');
  seite.feld('Tag der Bewirtung', datumDe(d.datum), { bold: true });
  seite.feld('Gaststätte', d.restaurant);
  seite.block('Anschrift', [d.strasse, [d.plz, d.ort].filter(Boolean).join(' ')].filter(Boolean).join(', '));

  seite.abschnitt('Anlass');
  seite.block('Konkreter Anlass', d.anlass);

  seite.abschnitt('Bewirtete Personen');
  seite.block('Teilnehmer', formatTeilnehmer(d.teilnehmer));
  seite.feld('Anzahl Personen', String(zaehleTeilnehmer(d.teilnehmer)));
  seite.feld('Bewirtende Person', d.bewirtender || '');

  seite.abschnitt('Aufwendungen');
  seite.feld('Rechnungsbetrag (brutto)', euro(brutto));
  seite.feld('Trinkgeld', euro(trinkgeld));
  seite.feld('Gesamtaufwand', euro(gesamt), { bold: true });
  seite.luft(4);
  seite.feld(`Abziehbar (${Math.round(BEWIRTUNG.abziehbar_anteil * 100)} %)`, euro(abziehbar), { bold: true });
  seite.feld(`Nicht abziehbar (${Math.round(BEWIRTUNG.nicht_abziehbar_anteil * 100)} %)`, euro(nichtAbziehbar));
  if (d.ust_cents) seite.feld('Enthaltene Umsatzsteuer', `${euro(d.ust_cents)} (voll als Vorsteuer abziehbar)`);

  if (d.zahlungsart) { seite.abschnitt('Zahlung'); seite.feld('Zahlungsart', d.zahlungsart); }

  seite.trennlinie();
  seite.text('Die beigefügte Originalrechnung der Gaststätte ist Bestandteil dieses Belegs.',
    { size: 9, farbe: GRAU, dy: 16 });
  seite.unterschriftsfeld(`Ort, Datum und Unterschrift der bewirtenden Person${d.bewirtender ? ` (${d.bewirtender})` : ''}`);

  const hinweise = [];
  if (gesamt >= BEWIRTUNG.kleinbetragsgrenze_cents) {
    hinweise.push(
      `Hinweis: Der Gesamtbetrag liegt bei oder ueber ${euro(BEWIRTUNG.kleinbetragsgrenze_cents)}. ` +
      'Die Gaststättenrechnung muss deshalb auf den Namen des bewirtenden Unternehmens ausgestellt sein.',
    );
  }
  hinweise.push(
    'Die Rechnung der Gaststätte muss maschinell erstellt und elektronisch aufgezeichnet sein ' +
    'und Name und Anschrift der Gaststätte, Tag der Bewirtung, die einzelnen Speisen und Getränke ' +
    'sowie den Rechnungsbetrag enthalten.',
  );
  seite.luft(6);
  for (const h of hinweise) { seite.fussnote(h); seite.luft(3); }

  return { bytes: await pdf.save(), zusammenfassung: { gesamt_cents: gesamt, abziehbar_cents: abziehbar, nicht_abziehbar_cents: nichtAbziehbar } };
}

/**
 * Spesenabrechnung fuer Reisekosten - insbesondere fuer Rechnungen von Hotels,
 * Buchungsportalen und Fluggesellschaften, die auf einen privaten Namen lauten,
 * aber mit der Firmenkreditkarte bezahlt wurden.
 */
export async function erstelleSpesenabrechnung(d) {
  const positionen = Array.isArray(d.positionen) ? d.positionen : [];
  const summePositionen = positionen.reduce((s, p) => s + Number(p.betrag_cents || 0), 0);
  const verpflegung = berechneVerpflegung(d.verpflegung || {});
  const gesamt = summePositionen + verpflegung.summe_cents;

  const { pdf, seite, fonts } = await neuesDokument();

  seite.titel('Spesenabrechnung');
  seite.text(`Reisekostenabrechnung - ${REISEKOSTEN.rechtsgrundlage}`, { size: 9, farbe: GRAU, dy: 20 });
  seite.trennlinie();

  seite.abschnitt('Reisender und Anlass');
  seite.feld('Name', d.reisender || '');
  seite.block('Grund der Reise', d.reisegrund || '');
  seite.feld('Reiseziel', d.reiseziel || '');
  seite.feld('Beginn', `${datumDe(d.beginn_datum)}${d.beginn_zeit ? ', ' + d.beginn_zeit + ' Uhr' : ''}`);
  seite.feld('Ende', `${datumDe(d.ende_datum)}${d.ende_zeit ? ', ' + d.ende_zeit + ' Uhr' : ''}`);

  if (positionen.length) {
    seite.abschnitt('Belegte Aufwendungen');
    for (const p of positionen) {
      seite.feld(
        `${datumDe(p.datum)} ${p.art || ''}`.trim(),
        `${p.beschreibung || ''}   ${euro(p.betrag_cents)}`.trim(),
      );
    }
    seite.feld('Summe Belege', euro(summePositionen), { bold: true });
  }

  if (verpflegung.tage.length) {
    seite.abschnitt('Verpflegungsmehraufwand');
    for (const t of verpflegung.tage) {
      const details = [t.bezeichnung, t.kuerzungen.length ? `abzgl. ${t.kuerzungen.join(', ')}` : null]
        .filter(Boolean).join(', ');
      seite.feld(datumDe(t.datum), `${details}   ${euro(t.betrag_cents)}`);
    }
    seite.feld('Summe Verpflegungspauschale', euro(verpflegung.summe_cents), { bold: true });
  }

  seite.trennlinie();
  seite.feld('Erstattungsbetrag gesamt', euro(gesamt), { bold: true });

  if (d.firmenkarte) {
    seite.luft(6);
    seite.fussnote(
      'Die Aufwendungen wurden mit der Firmenkreditkarte bezahlt. Soweit Rechnungen auf einen ' +
      'privaten Namen lauten, dienen sie hier als Nachweis der betrieblichen Veranlassung; ' +
      'eine Auszahlung an die reisende Person erfolgt nicht.',
    );
  }

  seite.unterschriftsfeld('Ort, Datum und Unterschrift der reisenden Person');
  seite.unterschriftsfeld('Sachlich und rechnerisch richtig (Freigabe)');

  return { bytes: await pdf.save(), zusammenfassung: { gesamt_cents: gesamt, belege_cents: summePositionen, verpflegung_cents: verpflegung.summe_cents } };
}

// Verpflegungspauschalen inkl. Kuerzung bei gestellten Mahlzeiten.
export function berechneVerpflegung(eingabe) {
  const tage = [];
  for (const tag of eingabe.tage || []) {
    const voll = tag.art === 'voll';
    let betrag = voll ? REISEKOSTEN.pauschale_voller_tag_cents : REISEKOSTEN.pauschale_teiltag_cents;
    const kuerzungen = [];
    if (tag.fruehstueck) { betrag -= REISEKOSTEN.kuerzung_fruehstueck_cents; kuerzungen.push('Frühstück'); }
    if (tag.mittagessen) { betrag -= REISEKOSTEN.kuerzung_mittagessen_cents; kuerzungen.push('Mittagessen'); }
    if (tag.abendessen) { betrag -= REISEKOSTEN.kuerzung_abendessen_cents; kuerzungen.push('Abendessen'); }
    // Die Kuerzung kann die Pauschale hoechstens auf null reduzieren.
    betrag = Math.max(0, betrag);
    tage.push({
      datum: tag.datum,
      bezeichnung: voll ? 'Voller Tag (24 Std.)' : 'An-/Abreise oder über 8 Std.',
      kuerzungen,
      betrag_cents: betrag,
    });
  }
  return { tage, summe_cents: tage.reduce((s, t) => s + t.betrag_cents, 0) };
}

function formatTeilnehmer(teilnehmer) {
  if (!teilnehmer) return '';
  const liste = Array.isArray(teilnehmer) ? teilnehmer : String(teilnehmer).split(/[\n;]+/);
  return liste
    .map((t) => (typeof t === 'string' ? t : [t.name, t.firma].filter(Boolean).join(', ')))
    .map((t) => t.trim()).filter(Boolean)
    .join('\n');
}
function zaehleTeilnehmer(teilnehmer) {
  return formatTeilnehmer(teilnehmer).split('\n').filter(Boolean).length;
}

/**
 * Fuegt den erstellten Beleg mit der Originalquittung zu einem PDF zusammen.
 * Bilder (Foto der Quittung) werden auf eine eigene Seite eingepasst.
 * @param {Uint8Array} belegBytes
 * @param {Array<{buffer: Buffer, mime: string, filename: string}>} anlagen
 */
export async function kombiniere(belegBytes, anlagen = []) {
  const ziel = await PDFDocument.create();
  const beleg = await PDFDocument.load(belegBytes);
  for (const s of await ziel.copyPages(beleg, beleg.getPageIndices())) ziel.addPage(s);

  for (const anlage of anlagen) {
    const mime = (anlage.mime || '').toLowerCase();
    try {
      if (mime.includes('pdf')) {
        const quelle = await PDFDocument.load(anlage.buffer, { ignoreEncryption: true });
        for (const s of await ziel.copyPages(quelle, quelle.getPageIndices())) ziel.addPage(s);
      } else if (mime.includes('png') || mime.includes('jpeg') || mime.includes('jpg')) {
        const bild = mime.includes('png')
          ? await ziel.embedPng(anlage.buffer)
          : await ziel.embedJpg(anlage.buffer);
        const seite = ziel.addPage(A4);
        const maxB = A4[0] - 2 * RAND;
        const maxH = A4[1] - 2 * RAND;
        const faktor = Math.min(maxB / bild.width, maxH / bild.height, 1);
        const b = bild.width * faktor;
        const h = bild.height * faktor;
        seite.drawImage(bild, { x: (A4[0] - b) / 2, y: (A4[1] - h) / 2, width: b, height: h });
      } else {
        throw new Error(`Format ${mime || 'unbekannt'} kann nicht angehängt werden`);
      }
    } catch (err) {
      // Eine unlesbare Anlage darf den Beleg nicht verhindern - sie wird als
      // Fehlseite dokumentiert, damit die Luecke in der Ablage sichtbar bleibt.
      const { pdf, seite } = await neuesDokument();
      seite.titel('Anlage konnte nicht eingebunden werden');
      seite.feld('Datei', anlage.filename || '(ohne Namen)');
      seite.feld('Typ', anlage.mime || 'unbekannt');
      seite.block('Grund', err.message);
      seite.luft(8);
      seite.fussnote('Die Originaldatei liegt unverändert im Ablageordner dieser Aufgabe.');
      const hilfs = await PDFDocument.load(await pdf.save());
      for (const s of await ziel.copyPages(hilfs, hilfs.getPageIndices())) ziel.addPage(s);
    }
  }

  return await ziel.save();
}
