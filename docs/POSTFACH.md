# Postfach anbinden (App-Passwort)

Der einfachste Weg, Belege aus `accounting@lexaid.net` zu holen: ein
App-Passwort. Kein Cloud-Projekt, keine Admin-Freigaben — fünf Minuten.

Ein App-Passwort gilt nur für dieses eine Programm und lässt sich einzeln
widerrufen, ohne das Kontopasswort zu ändern.

## 1. Zwei-Faktor-Bestätigung muss aktiv sein

Ohne sie bietet Google keine App-Passwörter an. Prüfen unter
[myaccount.google.com/security](https://myaccount.google.com/security) →
*Bestätigung in zwei Schritten*.

Melde dich dafür mit dem Konto an, dessen Postfach durchsucht werden soll —
also `accounting@lexaid.net`, nicht mit deinem persönlichen Konto.

## 2. App-Passwort erzeugen

[myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)

Einen Namen vergeben, etwa `Buchhaltungsvorbereitung`. Google zeigt dann 16
Buchstaben in vier Blöcken, zum Beispiel `abcd efgh ijkl mnop`.

**Die Leerzeichen weglassen** — einzutragen ist `abcdefghijklmnop`.

Das Passwort wird nur einmal angezeigt. Kommst du nicht sofort dazu, es
einzutragen: erst in den Passwortmanager, dann weiter.

## 3. IMAP muss für die Domain erlaubt sein

Als Workspace-Administrator: Admin-Konsole → *Apps* → *Google Workspace* →
*Gmail* → *Endnutzerzugriff* → **IMAP-Zugriff aktivieren**.

In den meisten Workspace-Konten ist das schon an. Ist es aus, meldet der
nächste Schritt eine Zeitüberschreitung.

## 4. In die `.env` eintragen

```bash
MAIL_DRIVER=imap
IMAP_USER=accounting@lexaid.net
IMAP_PASSWORT=abcdefghijklmnop
```

Die `.env` liegt im Projektordner und ist von der Versionierung ausgeschlossen
— das App-Passwort landet nie auf GitHub.

## 5. Prüfen

```bash
npm run mail:check
```

Das Skript verbindet sich, meldet sich an und zählt die Nachrichten im
Postfach. Schlägt etwas fehl, nennt es die Ursache statt eines Fehlercodes.

Danach im Reiter **Postfach** auf *Postfach durchsuchen*.

## Häufige Fehler

| Meldung | Ursache |
|---|---|
| Anmeldung fehlgeschlagen | Google meldet dasselbe für mehrere Ursachen. Der Reihe nach: Ist die Adresse ein eigenes Nutzerkonto und kein Alias oder keine Gruppe? Ist der IMAP-Zugriff für das Konto freigegeben (auch bei richtigem Passwort lehnt Google sonst genau so ab)? Gehört das App-Passwort zu genau diesem Konto? Wurde versehentlich das Kontopasswort eingetragen? |
| Server hat nicht rechtzeitig geantwortet | Eine Firewall sperrt Port 993. Bei langsamer Verbindung `IMAP_TIMEOUT_MS` erhöhen. |
| Server nicht erreichbar | `IMAP_HOST` prüfen; für Google ist es `imap.gmail.com`. |
| Suche findet nichts, obwohl Mails da sind | Der Zeitraum umfasst den Monat plus Nachlauf. Kamen die Rechnungen später, den Nachlauf im Reiter *Postfach* erhöhen. |

## Was das System mit dem Postfach macht

- **Lesen**, um Belege zu finden — Beträge, Betreffzeilen und Anhänge werden
  nur gelesen, nie verändert oder gelöscht.
- **Senden**, wenn du an einer Buchung ein Kürzel einträgst: dann geht eine
  Beleganfrage raus, und die Antwort wird am Ticket wiedererkannt.

Beim Durchsuchen werden bewusst nur Kopfdaten und der Aufbau der Nachrichten
geladen, nicht die Anhänge selbst — sonst zöge eine Monatssuche schnell
hunderte Megabyte. Heruntergeladen wird erst, was du auswählst.

## Wenn du später doch den Service Account willst

Der ist weiterhin eingebaut: `MAIL_DRIVER=gmail` plus die Einrichtung in
[GOOGLE.md](GOOGLE.md). Vorteil dort: kein Passwort im System, und es
funktioniert unverändert weiter, wenn jemand sein Kontopasswort ändert.
Umschalten ist eine Zeile in der `.env`.
