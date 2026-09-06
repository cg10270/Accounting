# Portale anbinden

Zu jedem Lieferanten lassen sich Portaladresse und Zugang hinterlegen. Ein Klick
auf **Portal öffnen** startet einen Chrome, meldet an und springt zur
Rechnungsseite. Was du dort herunterlädst, landet automatisch beim richtigen
Lieferanten im richtigen Monat — keine Datei im Download-Ordner, kein Hochladen
von Hand.

## Felder je Lieferant

| Feld | Zweck |
|---|---|
| **Portal-Adresse** | Wo die Anmeldung stattfindet. |
| **Direkt zu den Rechnungen** | Adresse, die nach der Anmeldung angesteuert wird. Erspart das Durchklicken. |
| **Benutzername, Passwort** | Werden beim Anmelden eingesetzt. Das Passwort verlässt den Server nicht. |
| **Verlangt Bestätigungscode** | Markiert Zwei-Faktor. Kein Hindernis — du gibst den Code im offenen Fenster ein. |
| **Erkennungsmuster** | Woran Buchungen im Kontoauszug erkannt werden. Leer = der Name selbst. |
| **Belege je Monat** | Optionaler Sollwert; die Ansicht zeigt dann `1/3` statt nur `1`. |

## Wie die Anmeldung funktioniert

Ohne weitere Angaben sucht das System selbst:

1. Ist weder ein Passwortfeld noch ein Anmeldeformular zu sehen, bist du
   vermutlich schon angemeldet — es passiert nichts.
2. Der Benutzername wird in das erste sichtbare Text- oder E-Mail-Feld
   geschrieben.
3. Zweistufige Masken (erst Benutzer, dann Passwort) werden erkannt: das System
   schickt ab und wartet, bis das Passwortfeld erscheint.
4. Das Passwort wird eingesetzt und das Formular abgeschickt.

Greift die Erkennung bei einem Portal nicht, lassen sich unter **Lieferanten →
Ändern** CSS-Selektoren für Benutzer-, Passwortfeld und Anmeldeknopf
hinterlegen. Eine misslungene Anmeldung ist ohnehin kein Abbruch: das Fenster
steht offen, du machst es von Hand.

## Ein eigenes Profil je Lieferant

Jeder Lieferant bekommt ein eigenes Chrome-Profil unter
`data/chrome-profil/lieferant-<id>`. Anmeldungen bleiben damit über Monate
hinweg bestehen, aber die Portale sehen nichts voneinander.

Chromes eigener Passwortmanager, Autofill und Sync sind abgeschaltet. Sonst
würde der Browser die Portal-Zugangsdaten mitschneiden und womöglich in ein
Google-Konto synchronisieren — genau das, was der Tresor verhindern soll.

## Einstellungen

```bash
BROWSER_SICHTBAR=1                 # 0 = unsichtbar (nur sinnvoll für Tests)
CHROME_PROFIL_DIR=./data/chrome-profil
CHROME_EXECUTABLE=                 # leer = mitgeliefertes Chromium
```

## Grenzen

- Das System muss auf **deinem** Rechner laufen, nicht auf einem Server: das
  Browserfenster muss sichtbar sein, damit du darin arbeiten kannst.
- Downloads werden nur in dem Fenster übernommen, das die Anwendung geöffnet
  hat. Lädst du in einem anderen Browser herunter, zieh die Datei in die
  Ablagefläche des Lieferanten.
- Schließt du das Fenster, endet die Übernahme. Der nächste Klick auf
  **Portal öffnen** startet eine neue Sitzung.
