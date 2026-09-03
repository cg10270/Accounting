// Legt eine Standard-Aufgabenvorlage und Beispiel-Kuerzel an.
// Mehrfach ausfuehrbar: bestehende Eintraege werden nicht doppelt angelegt.
import { all, get, run } from './db.js';
import { config } from './config.js';

const VORLAGEN = [
  ['Eingangsrechnungen sammeln', 'Alle Eingangsrechnungen des Monats aus Postfach und Lieferantenportalen zusammentragen.', 'belege',
   'Durchsuche das Postfach nach Rechnungen des Zeitraums, lade jede als PDF und lege sie im Zielordner ab. Benenne sie nach dem Muster JJJJ-MM-TT_Lieferant_Betrag.pdf.'],
  ['Ausgangsrechnungen exportieren', 'Gestellte Rechnungen aus dem Rechnungsprogramm exportieren.', 'belege',
   'Melde dich im Rechnungsprogramm an und exportiere alle Ausgangsrechnungen des Zeitraums als PDF.'],
  ['Kreditkartenabrechnung laden', 'Monatsabrechnung der Firmenkreditkarte aus dem Portal herunterladen.', 'bank',
   'Melde dich im Kreditkartenportal an und lade die Abrechnung des Zeitraums als PDF.'],
  ['Bankauszug importieren', 'Kontoauszug als CSV exportieren und im Reiter Bankabgleich hochladen.', 'bank', ''],
  ['Bewirtungsbelege erstellen', 'Zu allen Bewirtungsquittungen ordentliche Eigenbelege erzeugen.', 'belege', ''],
  ['Spesenabrechnungen erstellen', 'Reisekosten der Mitarbeitenden abrechnen, inkl. Verpflegungspauschalen.', 'belege', ''],
  ['Bankabgleich durchführen', 'Buchungsgruppen mit den Belegen abgleichen und fehlende Belege anfordern.', 'abgleich', ''],
  ['Lohnunterlagen ablegen', 'Lohnabrechnungen und Beitragsnachweise des Monats ablegen.', 'lohn', ''],
  ['Umsatzsteuervoranmeldung vorbereiten', 'Zahlen zusammenstellen und der Kanzlei bereitstellen.', 'steuern', ''],
  ['Unterlagen an die Kanzlei übergeben', 'Vollständigkeit prüfen und den Monatsordner freigeben.', 'abschluss', ''],
];

if (!get('SELECT id FROM task_templates LIMIT 1')) {
  for (const [i, [title, description, category, prompt]] of VORLAGEN.entries()) {
    run('INSERT INTO task_templates (position, title, description, prompt, category) VALUES (?, ?, ?, ?, ?)',
      i + 1, title, description, prompt, category);
  }
  console.log(`${VORLAGEN.length} Aufgabenvorlagen angelegt.`);
} else {
  console.log(`${all('SELECT id FROM task_templates').length} Aufgabenvorlagen vorhanden - unveraendert.`);
}

if (!get('SELECT id FROM shortcodes LIMIT 1')) {
  run('INSERT INTO shortcodes (code, email, name) VALUES (?, ?, ?)',
    'az', `az@${config.shortcodeDomain}`, '');
  console.log(`Beispiel-Kuerzel "az" angelegt (az@${config.shortcodeDomain}).`);
}
