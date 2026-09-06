# Geparkt für v2: autonome Belegbeschaffung

Diese Dateien sind der Stand vom 06.09.2026 — eine Agentenschleife, in der
Claude selbst einen Browser bedient, sich anmeldet und Belege herunterlädt.
Sie ist lauffähig und war gegen ein nachgebautes Lieferantenportal geprüft
(siehe Commit `396d445`).

**Warum geparkt:** In v1 holt der Mensch die Belege. Das System meldet nur an,
öffnet das Portal und fängt die Downloads ab — deutlich zuverlässiger, weil
Zwei-Faktor, Captcha und ungewohnte Masken kein Abbruch sind, sondern schlicht
etwas, das der Mensch im offenen Fenster erledigt.

| Datei | Inhalt |
|---|---|
| `agent.js` | Werkzeugschleife über die Messages-API, Schritt- und Zeitgrenzen, Bewertung eines Laufs gegen die tatsächliche Ablage |
| `werkzeuge.js` | Werkzeugsatz des Agenten samt Passwortgrenze |
| `steuerung.js` | Playwright-Hülle mit Seitenzustand, Domainschranke und Download-Erfassung |

**Zum Wiederbeleben** brauchen sie:
- `src/services/browser/portal.js` liefert heute die gehärteten Chrome-Schalter
  und die Download-Übernahme — davon lässt sich einiges übernehmen
- die Zugangsdaten liegen jetzt am Lieferanten (`lieferanten.secret_enc`),
  nicht mehr an der Aufgabe (`credentials.task_id`)
- `laufeAufgabe(taskId)` müsste zu `laufeLieferant(lieferantId, periodId)` werden

Der Grundsatz aus v1 gilt weiter: **ein Lauf gilt nur als erledigt, wenn ein
Beleg tatsächlich in der Ablage liegt** — nicht, weil das Modell es behauptet.
