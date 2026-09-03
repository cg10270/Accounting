# Google Workspace anbinden

Das System spricht Google Drive und Gmail über **einen** Service Account mit
domainweiter Delegierung. Er handelt im Namen eines Postfachs — üblicherweise
`accounting@lexaid.net`. Es ist kein Nutzer-Login und keine Zustimmungsseite nötig.

## 1. Google-Cloud-Projekt

1. [console.cloud.google.com](https://console.cloud.google.com) → neues Projekt anlegen
2. **APIs und Dienste → Bibliothek** → aktivieren:
   - Google Drive API
   - Gmail API

## 2. Service Account

1. **IAM und Verwaltung → Dienstkonten → Dienstkonto erstellen**
2. Nach dem Anlegen: **Schlüssel → Schlüssel hinzufügen → JSON**
3. Die heruntergeladene Datei nach `secrets/service-account.json` legen
   (`secrets/` ist von der Versionierung ausgeschlossen)
4. Die **Client-ID** des Dienstkontos notieren — eine lange Zahl, sichtbar in der
   Detailansicht des Dienstkontos. Sie wird im nächsten Schritt gebraucht.

## 3. Domainweite Delegierung freigeben

Das ist der Schritt, an dem es erfahrungsgemäß hakt. In der **Google-Workspace-
Admin-Konsole** (nicht in der Cloud Console):

**Sicherheit → Zugriffs- und Datenkontrolle → API-Steuerung → Domainweite
Delegierung verwalten → Neu hinzufügen**

- Client-ID: die aus Schritt 2
- OAuth-Bereiche, kommagetrennt und **exakt** so:

```
https://www.googleapis.com/auth/drive,
https://www.googleapis.com/auth/gmail.send,
https://www.googleapis.com/auth/gmail.readonly
```

Nach dem Speichern dauert es einige Minuten, bis die Freigabe greift.

## 4. Zielordner in Drive

1. In Drive den Ordner anlegen, unter dem alles abgelegt werden soll
2. Ihn für das Postfach aus `GOOGLE_IMPERSONATE_USER` freigeben
   (bei einer geteilten Ablage genügt die Mitgliedschaft)
3. Die Ordner-ID aus der Adresszeile kopieren — der Teil hinter `/folders/`

## 5. Konfiguration

In der `.env`:

```bash
STORAGE_DRIVER=gdrive
MAIL_DRIVER=gmail
GOOGLE_SERVICE_ACCOUNT_JSON=./secrets/service-account.json
GOOGLE_IMPERSONATE_USER=accounting@lexaid.net
DRIVE_ROOT_FOLDER_ID=1AbC...
MAIL_FROM=accounting@lexaid.net
ACCOUNTING_INBOX=accounting@lexaid.net
```

## 6. Prüfen

```bash
npm run google:check
```

Das Skript geht die Kette einzeln durch — Konfiguration, Schlüsseldatei, Freigabe
je Bereich, Zielordner, eine echte Schreib-, Lese- und Löschprobe, Postfach — und
nennt bei jedem Fehlschlag die konkrete Ursache.

## Häufige Fehler

| Meldung | Ursache |
|---|---|
| `unauthorized_client` | Die Bereiche in Schritt 3 fehlen oder stimmen nicht genau. Auch nach einer Korrektur einige Minuten warten. |
| `invalid_grant` | `GOOGLE_IMPERSONATE_USER` existiert nicht oder gehört nicht zur Domain. Seltener: die Serverzeit weicht stark ab. |
| Ordner „nicht sichtbar“ | `DRIVE_ROOT_FOLDER_ID` falsch, oder der Ordner ist für das Postfach nicht freigegeben. Drive meldet Nichtfreigegebenes als „nicht gefunden“. |
| Privater Schlüssel unlesbar | Der PEM-Block in der JSON-Datei ist beschädigt. Einfach einen neuen Schlüssel erzeugen. |

## Wie das System Drive nutzt

- **Ordner**: Der Pfad `Buchhaltung/<Jahr>/<MM Monat>/<Aufgabe>/` wird Ebene für
  Ebene aufgelöst und angelegt, was fehlt. Gefundene Ordner-IDs werden gemerkt.
- **Ablegen**: Bis 5 MB als Multipart-Upload, darüber wiederaufnehmbar. Existiert
  im Zielordner bereits eine Datei gleichen Namens, wird ihr Inhalt ersetzt —
  ein zweiter Lauf erzeugt also keine Dubletten.
- **Lesen**: Über die Drive-Datei-ID, nicht über den Pfad. Wird ein Ordner in
  Drive umbenannt oder eine Datei verschoben, bleiben die Verweise gültig.
- **Löschen**: Dateien wandern in den Papierkorb statt endgültig gelöscht zu
  werden — eine versehentlich entfernte Rechnung bleibt wiederherstellbar.

## Wie das System Gmail nutzt

- **Versand**: als `MAIL_FROM`, mit `Reply-To` auf das Buchhaltungspostfach.
  Betreffzeilen mit Umlauten oder `€` werden nach RFC 2047 kodiert.
- **Erledigungsprüfung**: Suche nach `in:inbox "<Ticket>"`. Der Zusatz `in:inbox`
  schließt die eigene, gesendete Nachricht aus.
- **Eingegangene Belege** werden heruntergeladen und unter
  `Buchhaltung/<Jahr>/<MM Monat>/Beleganfragen/` abgelegt. Sie erhalten
  Zuordnung, Betrag und Datum der angefragten Buchung, damit der Bankabgleich
  sie sofort gegenrechnet.
