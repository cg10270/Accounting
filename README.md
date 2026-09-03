# Buchhaltungsvorbereitung

Webanwendung zur Vorbereitung der monatlichen Buchhaltung: Aufgabenliste mit KI-Unterstützung,
Belegablage, Bankabgleich, Erstellung von Eigenbelegen und ein nachvollziehbares Logbuch.

**Stand:** Vollständig in den Grundzügen — Oberfläche, Datenmodell, Fachlogik,
Anbindung an Google Drive und Gmail sowie die KI-gesteuerte Belegbeschaffung im
Browser. Was noch offen ist, steht unter [Was noch fehlt](#was-noch-fehlt).

## Schnellstart

```bash
npm install
cp .env.example .env      # ANTHROPIC_API_KEY und VAULT_PASSPHRASE eintragen
npm run seed              # Standard-Aufgabenvorlagen anlegen
npm start                 # http://127.0.0.1:4000
```

Ohne `ANTHROPIC_API_KEY` läuft alles weiter, die KI-Funktionen liefern dann feste
Beispielantworten. Ohne `VAULT_PASSPHRASE` werden keine Passwörter angenommen.

## Funktionsumfang

| Bereich | Was es tut |
|---|---|
| **Aufgaben** | Liste je Zeitraum, in beliebiger Reihenfolge anspringbar. Erstellen und Ändern per KI-Prompt oder von Hand. Je Aufgabe: Status, hochgeladene Daten, eigener KI-Prompt, Zugangsdaten. |
| **Ablage** | Jede Datei landet unter `Buchhaltung/<Jahr>/<MM Monat>/<Aufgabe>/`. Die Übersicht in der Oberfläche ist virtuell — die Wahrheit liegt im Ablage-Backend. |
| **Belegbeschaffung** | Zu jeder Aufgabe kann die KI einen echten Chrome steuern: im Portal anmelden, Belege herunterladen, ablegen. Fortschritt läuft live mit. Siehe [docs/BROWSER.md](docs/BROWSER.md). |
| **Bankabgleich** | CSV-Import mit automatischer Erkennung von Trennzeichen, Spalten und deutschen Zahlenformaten. Buchungen werden zu Gruppen zusammengefasst und den vorhandenen Belegen gegenübergestellt: Anzahl, Summe, Belegsumme, Differenz. |
| **Beleganfragen** | Ein Kürzel an einer Buchung (z. B. `az`) verschickt eine Mail an `az@lexaid.net` mit der Bitte, den Beleg an `accounting@lexaid.net` zu senden. Jede Anfrage bekommt ein Ticket, das im Betreff mitläuft. |
| **Logbuch** | Append-only. Jede Anfrage und jeder KI-Lauf wird mit vollständigem Verlauf festgehalten. Die Erledigung wird im Postfach anhand des Tickets geprüft; ein eingegangener Beleg landet automatisch in der Ablage und wird im Bankabgleich gegengerechnet. |
| **Belegerstellung** | Bewirtungsbelege nach § 4 Abs. 5 Satz 1 Nr. 2 EStG und Spesenabrechnungen nach § 9 Abs. 4a EStG als PDF, zusammengeführt mit der Originalquittung. Die Quittung kann per KI ausgelesen werden. |

## Architektur

```
public/          Oberfläche (HTML, CSS, ein Modul JavaScript — kein Framework)
   │  REST
src/server.js    HTTP-Server, alle Endpunkte
src/db.js        SQLite-Schema (node:sqlite, keine native Abhängigkeit)
src/services/
   llm.js            Claude (Opus 5) für Aufgabenlisten und Automatisierung
   beleganalyse.js   Quittungen auslesen (PDF und Bild direkt an das Modell)
   docgen.js         Bewirtungsbeleg und Spesenabrechnung als PDF, Zusammenführung
   steuerregeln.js   Steuerliche Kennzahlen an einer Stelle
   vault.js          Zugangsdaten, AES-256-GCM
   agent.js          Agentenschleife für die Automatisierung einer Aufgabe
   browser/          Chrome-Steuerung und Werkzeugsatz des Agenten
   logbook.js        Logbuch, Beleganfragen, Erledigungsprüfung
   bank/csv.js       CSV-Parser für Kontoauszüge
   bank/grouping.js  Gruppenbildung und Belegabgleich
   ablage.js         Einziger Weg, auf dem Dateien ins System gelangen
   storage/          Ablage-Adapter: local (Dateisystem) | gdrive (Service Account)
   mail/             Mail-Adapter:   mock (data/outbox) | gmail (Service Account)
   google/           Anmeldung als Service Account, Drive- und Gmail-Aufrufe
```

Die Adapter in `storage/` und `mail/` haben dieselbe Schnittstelle. Der Wechsel auf
Google erfolgt über `STORAGE_DRIVER=gdrive` und `MAIL_DRIVER=gmail` in der `.env`,
ohne Änderung an der übrigen Anwendung. Die Einrichtung beschreibt
[docs/GOOGLE.md](docs/GOOGLE.md); `npm run google:check` prüft sie Schritt für Schritt.

## Umgang mit Zugangsdaten

Portal-Logins sind das größte Risiko des Systems. Deshalb gilt:

- Passwörter werden mit AES-256-GCM verschlüsselt abgelegt. Der Schlüssel wird aus
  `VAULT_PASSPHRASE` abgeleitet und existiert nur im Prozessspeicher.
- Die API gibt niemals Klartext zurück, nur `••••••••`.
- **Kein Passwort gelangt in den Modellkontext.** Die KI erhält ausschließlich eine
  Referenz („Zugang 1: Portal X, Benutzer y, Passwort im Tresor hinterlegt“). Aufgelöst
  wird sie erst unmittelbar im Anmeldeformular.
- Zugänge mit Zwei-Faktor-Authentifizierung werden als solche markiert. Ein KI-Lauf
  bricht dort mit dem Hinweis auf manuellen Eingriff ab, statt still zu scheitern.
- Der vom Agenten gesteuerte Chrome läuft ohne eigenen Passwortmanager, ohne
  Autofill und ohne Sync — sonst würde er die Portal-Zugangsdaten mitschneiden.
- Der Agent erreicht nur die Domains der hinterlegten Zugänge. Alles andere wird
  abgewiesen, bevor der Browser navigiert.

## Steuerliche Kennzahlen

Alle Sätze und Grenzen stehen in `src/services/steuerregeln.js` (Stand
Veranlagungszeitraum 2026): 70/30-Aufteilung bei Bewirtung, Kleinbetragsgrenze 250 €,
Verpflegungspauschalen 28 € / 14 € samt Kürzungen für gestellte Mahlzeiten.
**Vor dem produktiven Einsatz mit der Steuerkanzlei abstimmen.**

## Was noch fehlt

1. **Spalten-Zuordnung von Hand** — der CSV-Parser erkennt gängige Exporte selbst,
   eine Korrekturmöglichkeit in der Oberfläche fehlt noch.
2. **Gruppen zusammenführen** — die Gruppierung arbeitet heuristisch. Ein manuelles
   Verschmelzen und Umbenennen mit dauerhaften Regeln steht aus.
3. **Zeitplan** — Läufe werden heute von Hand gestartet. Ein wiederkehrender
   Monatslauf wäre der nächste sinnvolle Ausbau.

Zwei Dinge sind gegen Nachbauten geprüft, nicht gegen die echten Gegenstellen:
die Google-Anbindung gegen einen Testserver, der die APIs nachbildet und die
JWT-Signatur echt verifiziert, und die Browser-Steuerung gegen ein nachgebautes
Lieferantenportal mit einer skriptgesteuerten Modell-Attrappe. Der erste Lauf
mit echten Zugangsdaten sollte deshalb mit `npm run google:check` beginnen und
für die Belegbeschaffung mit einem unkritischen Portal starten.

## Entwicklung

```bash
npm run dev           # Server mit automatischem Neustart
npm run seed          # Vorlagen und Beispiel-Kürzel (mehrfach ausführbar)
npm run google:check  # Google-Einrichtung prüfen
```

Die Daten liegen unter `data/` (SQLite, Ablage, Postausgang) und sind nicht versioniert.
