# API-Referenz

Alle Endpunkte liefern JSON. Fehler kommen als `{ "fehler": "…" }` mit Status 400 oder 404.

## System
| Methode | Pfad | Zweck |
|---|---|---|
| GET | `/api/status` | Zustand von KI, Tresor, Ablage und Mail |

## Zeiträume
| Methode | Pfad | Zweck |
|---|---|---|
| GET | `/api/periods` | Alle Zeiträume mit Fortschritt |
| POST | `/api/periods` | `{year, month, aus_vorlagen?}` — legt an und instanziiert die Vorlagen |

## Aufgaben
| Methode | Pfad | Zweck |
|---|---|---|
| GET | `/api/periods/:id/tasks` | Aufgaben inkl. Dateien und Zugängen |
| POST | `/api/periods/:id/tasks` | `{title, description?, prompt?, category?}` |
| PATCH | `/api/tasks/:id` | Felder ändern; `status: "erledigt"` setzt Zeitpunkt und Person |
| DELETE | `/api/tasks/:id` | Aufgabe löschen |
| POST | `/api/periods/:id/als-vorlage` | Aktuelle Liste als Vorlage sichern |
| POST | `/api/periods/:id/ki/aufgaben` | `{prompt, modus: "ersetzen"\|"ergaenzen"}` — erledigte Aufgaben bleiben erhalten |
| POST | `/api/tasks/:id/ki/lauf` | Automatisierung dieser Aufgabe starten |

## Dateien
| Methode | Pfad | Zweck |
|---|---|---|
| POST | `/api/tasks/:id/dateien` | Rohe Bytes im Body, Name im Header `X-Filename` |
| GET | `/api/dateien/:id/inhalt` | Datei ausliefern |
| PATCH | `/api/dateien/:id` | `{vendor, amount_cents, doc_date, task_id}` — Zuordnung für den Bankabgleich |
| DELETE | `/api/dateien/:id` | Datei löschen |
| POST | `/api/dateien/:id/analyse` | `{art: "bewirtung"\|"spesen"}` — Quittung per KI auslesen |

## Zugangsdaten
| Methode | Pfad | Zweck |
|---|---|---|
| POST | `/api/tasks/:id/zugaenge` | `{label, url?, username?, secret?, has_mfa?, notes?}` |
| DELETE | `/api/zugaenge/:id` | Zugang löschen |

Das Passwort wird verschlüsselt gespeichert und nie zurückgegeben.

## Bankabgleich
| Methode | Pfad | Zweck |
|---|---|---|
| POST | `/api/periods/:id/bank/import` | CSV im Body, Name im Header `X-Filename` |
| GET | `/api/periods/:id/bank/gruppen` | Gruppen mit Summen, Belegen und Differenz |
| PATCH | `/api/bank/buchungen/:id` | `{tag, note, group_key, group_label, anfragen?}` |

Ein **neu gesetztes** `tag` löst die Beleganfrage per Mail aus. Ein erneutes Speichern
desselben Kürzels sendet keine zweite Mail; `anfragen: false` unterdrückt den Versand.

## Logbuch
| Methode | Pfad | Zweck |
|---|---|---|
| GET | `/api/periods/:id/logbuch` | Einträge mit vollständigem Verlauf |
| POST | `/api/logbuch/:id/pruefen` | Einen Eintrag auf Erledigung prüfen |
| POST | `/api/periods/:id/logbuch/pruefen` | Alle offenen Einträge prüfen |

## Kürzel
| Methode | Pfad | Zweck |
|---|---|---|
| GET | `/api/kuerzel` | Alle Kürzel |
| POST | `/api/kuerzel` | `{code, email?, name?}` — ohne `email` wird `code@lexaid.net` verwendet |
| DELETE | `/api/kuerzel/:id` | Kürzel löschen |

## Belegerstellung
| Methode | Pfad | Zweck |
|---|---|---|
| POST | `/api/periods/:id/belege/bewirtung` | Bewirtungsbeleg erzeugen und mit Anlagen zusammenführen |
| POST | `/api/periods/:id/belege/spesen` | Spesenabrechnung erzeugen |

Pflichtangaben Bewirtung: `datum`, `restaurant`, `anlass`, `teilnehmer`, `brutto_cents`.
Pflichtangaben Spesen: `reisender`, `reisegrund`, `beginn_datum`.
Beträge durchgehend in Cent. `anlagen` ist eine Liste von Datei-IDs, die als
Originalquittung an das erzeugte PDF angehängt werden.
