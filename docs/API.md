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

## Lieferanten
| Methode | Pfad | Zweck |
|---|---|---|
| GET | `/api/lieferanten` | Stammdaten aller Lieferanten inkl. Erkennungsmuster |
| POST | `/api/lieferanten` | `{name, url?, rechnungen_url?, username?, secret?, has_mfa?, erwartet?, muster?}` |
| PATCH | `/api/lieferanten/:id` | Felder ändern. `secret` weglassen = Passwort unverändert, `""` = löschen |
| DELETE | `/api/lieferanten/:id` | Löschen. Belege und Buchungen bleiben, verlieren aber die Zuordnung |

## Checkliste
| Methode | Pfad | Zweck |
|---|---|---|
| GET | `/api/periods/:id/checkliste` | Die Hauptansicht: Bereiche → Lieferantengruppen → Positionen, mit Bankabgleich je Gruppe |
| GET | `/api/bereiche` | Bereiche mit ihren Positionen |
| POST | `/api/bereiche` | `{name, nummer?}` |
| POST | `/api/positionen` | `{bereich_id, name, lieferant_id?, hinweis?}` |
| PATCH | `/api/positionen/:id` | Felder ändern; `aktiv: 0` blendet aus, ohne die Historie zu verlieren |
| DELETE | `/api/positionen/:id` | Position löschen |
| POST | `/api/periods/:pid/positionen/:posid/status` | `{status: "offen"\|"erledigt"\|"entfaellt", notiz?, von?}` |
| POST | `/api/periods/:pid/positionen/:posid/dateien` | Beleg hochladen; zählt zugleich beim Lieferanten der Position |

## Lieferantenansicht (flach)
| Methode | Pfad | Zweck |
|---|---|---|
| GET | `/api/periods/:id/monat` | Je Lieferant Bank gegen Belege, plus Buchungen ohne Zuordnung und Summen |
| GET | `/api/periods/:pid/lieferanten/:lid/details` | Einzelbuchungen und Belege eines Lieferanten |
| POST | `/api/periods/:pid/lieferanten/:lid/status` | `{status: "offen"\|"erledigt"\|"entfaellt", notiz?, von?}` |
| POST | `/api/periods/:pid/lieferanten/:lid/dateien` | Beleg hochladen; Bytes im Body, Name im Header `X-Filename` |
| POST | `/api/periods/:id/zuordnen` | Buchungen neu zuordnen, etwa nach Musteränderung |
| POST | `/api/bank/buchungen/:id/lieferant` | `{lieferant_id}` ordnet zu, `{}` legt aus der Buchung einen Lieferanten an |

## Portal
| Methode | Pfad | Zweck |
|---|---|---|
| POST | `/api/periods/:pid/lieferanten/:lid/portal` | Öffnet den Browser und meldet an |
| GET | `/api/lieferanten/:id/portal` | Stand der Sitzung inkl. übernommener Belege |
| DELETE | `/api/lieferanten/:id/portal` | Sitzung beenden |
| GET | `/api/portale` | Alle offenen Sitzungen |

## Postfach
| Methode | Pfad | Zweck |
|---|---|---|
| POST | `/api/periods/:id/postfach/suche` | `{nachlaufTage}` — durchsucht das Buchhaltungspostfach, liefert Vorschläge mit erkanntem Lieferanten |
| POST | `/api/periods/:id/postfach/uebernehmen` | `{auswahl: [{message_id, attachment_id, filename, mime, lieferant_id?, betrag_cents?}]}` |

Doppelte Übernahmen werden zweifach verhindert: über die Kennung des Anhangs und
über die Prüfsumme des Inhalts — dieselbe Rechnung kann als Original und als
Weiterleitung hereinkommen.

## Aufgaben
| Methode | Pfad | Zweck |
|---|---|---|
| GET | `/api/periods/:id/tasks` | Aufgaben inkl. Dateien und Zugängen |
| POST | `/api/periods/:id/tasks` | `{title, description?, prompt?, category?}` |
| PATCH | `/api/tasks/:id` | Felder ändern; `status: "erledigt"` setzt Zeitpunkt und Person |
| DELETE | `/api/tasks/:id` | Aufgabe löschen |
| POST | `/api/periods/:id/als-vorlage` | Aktuelle Liste als Vorlage sichern |
| POST | `/api/periods/:id/ki/aufgaben` | `{prompt, modus: "ersetzen"\|"ergaenzen"}` — erledigte Aufgaben bleiben erhalten |

## Dateien
| Methode | Pfad | Zweck |
|---|---|---|
| POST | `/api/tasks/:id/dateien` | Rohe Bytes im Body, Name im Header `X-Filename` |
| GET | `/api/dateien/:id/inhalt` | Datei ausliefern |
| PATCH | `/api/dateien/:id` | `{vendor, amount_cents, doc_date, task_id}` — Zuordnung für den Bankabgleich |
| DELETE | `/api/dateien/:id` | Datei löschen |
| POST | `/api/dateien/:id/analyse` | `{art: "bewirtung"\|"spesen"}` — Quittung per KI auslesen |

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
