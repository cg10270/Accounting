# Buchhaltungsvorbereitung

Webanwendung, die die monatlich wiederkehrende Belegvorbereitung strukturiert.
Die **Checkliste** gliedert den Monat in Bereiche und Positionen; je **Lieferant**
steht nebeneinander, was die Bank sagt und was an Belegen vorliegt.

**Grundsatz von v1: Das System organisiert, der Mensch beschafft.** Ein Klick
meldet dich im Portal an und öffnet die Rechnungsseite; was du dort
herunterlädst, wird automatisch übernommen. Die autonome Beschaffung durch die
KI ist gebaut, aber für v2 geparkt (siehe [v2/](v2/README.md)).

## Schnellstart

```bash
npm install
cp .env.example .env      # VAULT_PASSPHRASE eintragen
npm run seed              # Aufgabenvorlagen anlegen
npm run seed:checkliste   # Monatscheckliste mit Bereichen und Lieferanten
npm start                 # http://127.0.0.1:4000
npm test                  # 48 Tests
```

## Die Checkliste

Der Monat ist in Bereiche gegliedert, darunter stehen die Positionen, die
abgehakt werden:

```
▾ 3  Stripe                                                          2/6
     Stripe            Bank 2 · 12.061,40 €   Belege 1 · 12.480,00 €   Δ …   [Portal]
       ☑ Rechnungen              2 Dateien
       ☑ Gutschriften            1 Datei
       ☐ Offene Posten
       ☐ Zahlungsausfälle
       ☐ Payout Report
       ☐ Gebührenreport

▾ 6  Software & SaaS                                                 0/6
     ☐ OpenAI            Bank 1 · −128,40 €   keine Belege   Δ 128,40 €   [Portal]
     ☐ Anthropic (Claude) Bank 1 · −340,00 €  keine Belege   Δ 340,00 €   [Portal]
```

Der Zuschnitt folgt der Wirklichkeit: **Anmeldung und Bankabgleich gehören zum
Lieferanten, die Häkchen zu den Positionen darunter.** Aus einem Stripe-Login
kommen sechs verschiedene Dokumente — die will man einzeln abhaken, den
Bankbetrag aber nur einmal sehen. Trägt ein Lieferant nur eine gleichnamige
Position, stehen beide in einer Zeile.

`npm run seed:checkliste` legt die Checkliste samt der zwölf Lieferanten an.
Bereiche und Positionen sind danach in der Oberfläche änderbar.

## Der Monatsablauf

1. **Kontoauszug importieren** (CSV). Die Buchungen werden anhand hinterlegter
   Muster automatisch den Lieferanten zugeordnet.
2. **Postfach durchsuchen.** Holt Belege aus `accounting@lexaid.net` für den
   Monat samt Nachlauf in den Folgemonat. Signaturbilder und Zertifikate werden
   aussortiert, bereits übernommene Anhänge erkannt.
3. **Portal öffnen** je Lieferant. Anmeldung läuft automatisch, du lädst die
   Belege herunter, sie landen sofort beim richtigen Lieferanten.
4. **Fehlendes anfordern.** Kürzel an einer Buchung schickt eine Mail mit
   Ticket; die Antwort wird automatisch abgelegt.
5. **Abhaken.** Von Hand, mit Blick auf die Differenz zwischen Bank und Belegen.

## Die Monatsansicht

| Lieferant | Bank | Belege | Differenz | Erledigt | |
|---|---|---|---|---|---|
| Google | 3 · −1.274,48 € | 1 · 1.274,48 € | ✓ 0,00 € | ☐ | Portal öffnen |
| Muster AG | 1 · 3.570,00 € | — | Δ 3.570,00 € | ☐ | |

Aufklappen zeigt die Einzelbuchungen neben den Belegen, mit Ablagefeld und
Monatsnotiz. Buchungen ohne Lieferant stehen darunter und lassen sich per Klick
zu einem neuen Lieferanten machen — der Buchungstext wird dabei als
Erkennungsmuster übernommen.

## Weitere Funktionen

| Bereich | Was es tut |
|---|---|
| **Belegerstellung** | Bewirtungsbelege nach § 4 Abs. 5 Satz 1 Nr. 2 EStG und Spesenabrechnungen nach § 9 Abs. 4a EStG als PDF, zusammengeführt mit der Originalquittung. |
| **Beleganfragen** | Kürzel an einer Buchung (z. B. `az`) schickt eine Mail an `az@lexaid.net`. Jede Anfrage bekommt ein Ticket; die Antwort wird erkannt und der Beleg abgelegt. |
| **Logbuch** | Append-only, mit vollständigem Verlauf je Vorgang. |
| **Weitere Aufgaben** | Für Arbeiten ohne Lieferantenbezug: Lohn, Umsatzsteuervoranmeldung, Übergabe an die Kanzlei. |
| **Ablage** | `Buchhaltung/<Jahr>/<MM Monat>/<Lieferant>/` — lokal oder in Google Drive. |

## Architektur

```
public/          Oberfläche (HTML, CSS, ein Modul JavaScript — kein Framework)
   │  REST
src/server.js    HTTP-Server, alle Endpunkte
src/db.js        SQLite-Schema (node:sqlite, keine native Abhängigkeit)
src/services/
   lieferanten.js    Stammdaten, Zuordnung der Buchungen, Monatsrollup
   postfach.js       Belege aus dem Mailpostfach holen
   browser/portal.js Portal öffnen, anmelden, Downloads übernehmen
   ablage.js         Einziger Weg, auf dem Dateien ins System gelangen
   docgen.js         Bewirtungsbeleg und Spesenabrechnung als PDF
   steuerregeln.js   Steuerliche Kennzahlen an einer Stelle
   vault.js          Zugangsdaten, AES-256-GCM
   logbook.js        Logbuch, Beleganfragen, Erledigungsprüfung
   bank/             CSV-Parser und Namensnormalisierung
   storage/          Ablage-Adapter: local | gdrive (Service Account)
   mail/             Mail-Adapter:   mock  | gmail (Service Account)
   google/           Anmeldung als Service Account, Drive- und Gmail-Aufrufe
test/            48 Tests auf der Logik, die Geld trägt
v2/              Geparkt: autonome Belegbeschaffung durch die KI
```

## Umgang mit Zugangsdaten

- Passwörter liegen AES-256-GCM-verschlüsselt; der Schlüssel wird aus
  `VAULT_PASSPHRASE` abgeleitet und existiert nur im Prozessspeicher.
- Die API gibt niemals Klartext zurück, nur `••••••••`. Ein leeres Passwortfeld
  beim Ändern bedeutet „unverändert", nicht „löschen".
- Das Passwort wird erst beim Anmelden entschlüsselt und unmittelbar in das
  Formularfeld geschrieben.
- Der geöffnete Chrome läuft ohne eigenen Passwortmanager, ohne Autofill und
  ohne Sync — sonst schnitte er genau die Zugangsdaten mit, die der Tresor
  schützen soll.
- Zwei-Faktor ist kein Hindernis: das Fenster steht offen, du gibst den Code
  selbst ein.

## Steuerliche Kennzahlen

Alle Sätze und Grenzen stehen in `src/services/steuerregeln.js` (Stand
Veranlagungszeitraum 2026): 70/30-Aufteilung bei Bewirtung, Kleinbetragsgrenze
250 €, Verpflegungspauschalen 28 € / 14 € samt Kürzungen.
**Vor dem produktiven Einsatz mit der Steuerkanzlei abstimmen.**

## Einrichtung

- **Google Drive und Gmail** — [docs/GOOGLE.md](docs/GOOGLE.md),
  Einrichtung prüfen mit `npm run google:check`
- **Portal-Anmeldung** — [docs/PORTALE.md](docs/PORTALE.md)
- **API** — [docs/API.md](docs/API.md)

## Was noch offen ist

1. **Spalten-Zuordnung von Hand** — der CSV-Parser erkennt gängige Exporte
   selbst; eine Korrekturmöglichkeit in der Oberfläche fehlt.
2. **Beträge aus Belegen auslesen** — heute tippst du den Betrag ein. Die
   KI-Auslesung ist gebaut (`beleganalyse.js`) und für die Belegerstellung im
   Einsatz, aber in der Monatsansicht noch nicht angeschlossen.
3. **Wiederkehrender Monatslauf** — Zeiträume werden von Hand angelegt.

Die Google-Anbindung ist gegen einen Nachbau geprüft, nicht gegen ein reales
Workspace-Konto. Der erste Lauf mit echten Zugangsdaten sollte deshalb mit
`npm run google:check` beginnen.
