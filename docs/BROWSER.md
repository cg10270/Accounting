# Browser-Steuerung

Zu jeder Aufgabe kann ein Prompt und ein Zugang hinterlegt werden. Der Knopf
**KI-Automatisierung starten** öffnet dann einen echten Chrome, meldet sich im
Portal an, lädt die Belege und legt sie im Zielordner ab. Der Fortschritt läuft
live in der Oberfläche mit.

## Zwei Betriebsarten

**Eigenes Profil (Voreinstellung).** Ohne weitere Einstellung startet das System
einen eigenen Chrome mit dauerhaftem Profil unter `data/chrome-profil`.
Anmeldungen bleiben über Läufe hinweg bestehen.

**Bestehendes Chrome übernehmen.** Praktischer, wenn du in vielen Portalen
ohnehin schon angemeldet bist:

```bash
chrome --remote-debugging-port=9222        # macOS: /Applications/Google\ Chrome.app/...
# in der .env:
CHROME_CDP_URL=http://127.0.0.1:9222
```

Vorhandene Sitzungen und Cookies werden mitbenutzt — das erspart einen großen
Teil der Anmeldungen. Beachte, dass der Agent damit auch Zugriff auf alles hat,
worin dieses Chrome angemeldet ist; die Domain-Schranke unten begrenzt das.

## Was der Agent darf

Der Werkzeugsatz ist bewusst klein: Seite öffnen, lesen, klicken, tippen,
anmelden, warten, Bildschirmfoto, Downloads auflisten, Beleg ablegen, Hilfe
anfordern, fertig.

Es gibt **kein** Werkzeug zum Ausführen von JavaScript und keines zum Hochladen
von Dateien. Der Agent holt Belege; er soll im Portal nichts verändern.

## Grenzen, die das System durchsetzt

| Grenze | Wirkung |
|---|---|
| **Domains** | Erreichbar sind nur die Domains der hinterlegten Zugänge, plus `AGENT_ERLAUBTE_DOMAINS`. Ein Aufruf anderswohin wird abgewiesen, bevor der Browser navigiert. |
| **Schritte** | `AGENT_MAX_SCHRITTE` (Vorgabe 40). Danach bricht der Lauf ab und bleibt offen. |
| **Zeit** | `AGENT_MAX_SEKUNDEN` (Vorgabe 600). |
| **Zwei-Faktor** | Ein als 2FA markierter Zugang lässt sich nicht automatisch anmelden. Der Versuch schlägt mit einer Anweisung fehl, stattdessen Hilfe anzufordern. |
| **Passwortmanager** | Chromes eigener Passwortmanager, Autofill und Sync sind abgeschaltet. Sonst würde der Browser die Portal-Zugangsdaten mitschneiden und womöglich in ein Google-Konto synchronisieren — genau das, was der Tresor verhindern soll. |

## Passwörter

Das Modell kennt keine Passwörter und braucht keine. Es sieht in der
Aufgabenbeschreibung nur:

```
Zugang 3: Lieferantenportal
  Adresse: https://portal.example
  Benutzer: buchhaltung
  Passwort: im Tresor hinterlegt, wird beim Anmelden eingesetzt
```

Für die Anmeldung ruft es `anmelden(zugang_id, benutzer_ref, passwort_ref, …)`
auf. Erst dort wird das Geheimnis entschlüsselt und unmittelbar in das
Formularfeld geschrieben. Es wird nicht zurückgegeben, nicht protokolliert und
landet nie im Modellkontext. Geprüft ist das mit einem Testlauf, der jede
Anfrage an die Modell-API auf das Klartextpasswort absucht.

## Warum ein Lauf nicht blind als erledigt gilt

Maßgeblich ist, was tatsächlich in der Ablage liegt — nicht, was das Modell
berichtet. Meldet ein Lauf sich als fertig, ohne dass ein Beleg abgelegt wurde,
und gab es dabei Fehler, bleibt die Aufgabe **offen**; die Behauptung des Laufs
steht daneben, damit die Abweichung sichtbar ist:

> Der Lauf meldet sich als fertig, es wurde aber kein Beleg abgelegt und es gab
> 1 Fehler. Bitte prüfen. Meldung des Laufs: "Alle Rechnungen des Monats
> erfolgreich heruntergeladen und abgelegt."

In der Buchhaltung ist ein falsch gesetztes Häkchen schlimmer als ein offener
Punkt.

## Abgelegte Belege

Jeder Beleg landet unter `Buchhaltung/<Jahr>/<MM Monat>/<Aufgabe>/` und bekommt
Lieferant, Betrag und Datum mit — soweit der Agent sie auf der Seite gesehen
hat. Damit rechnet der Bankabgleich sie unmittelbar gegen. Was der Agent nicht
zweifelsfrei lesen konnte, bleibt leer statt geraten.

## Fehlersuche

| Beobachtung | Ursache |
|---|---|
| „Kein Zugang mit Adresse hinterlegt" | Der Aufgabe fehlt ein Zugang mit URL — ohne die weiß der Agent nicht, welche Seite er öffnen darf. |
| „Domain … ist nicht freigegeben" | Das Portal leitet auf eine andere Domain um (etwa einen Anmeldedienst). Diese Domain in `AGENT_ERLAUBTE_DOMAINS` ergänzen. |
| Lauf endet mit „Manueller Eingriff nötig" | Zwei-Faktor, Captcha oder eine geänderte Anmeldemaske. Diese Portale bleiben Handarbeit. |
| „Schrittgrenze erreicht" | Das Portal braucht mehr Klicks als vorgesehen. `AGENT_MAX_SCHRITTE` erhöhen oder den Prompt der Aufgabe konkreter fassen. |
