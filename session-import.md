# Import bestehender Gemini-CLI-Sessions

Stand: 22. August 2026
Analysierter Stand: GeminUI mit `@agentclientprotocol/sdk` 1.3.0, dokumentierte Gemini CLI ab 0.56.0

## Kurzfassung

Ja, es ist möglich — aber nicht als stiller Scan beim Anwendungsstart.

Die Gemini CLI legt ihre Sessions selbst ab, projektbezogen unter
`~/.gemini/tmp/<project_hash>/chats/` als JSONL, geschrieben vom
`ChatRecordingService`. GeminUI hat davon heute keine Kenntnis, weil die
Sidebar ausschließlich aus der eigenen SQLite-Datenbank kommt. Es gibt
zwischen beiden Welten keinen gemeinsamen Speicher, nur zwei mögliche
Brücken:

1. **Vertraglich** über ACP `session/load` — die Gemini CLI spielt den
   Verlauf selbst als `session/update`-Notifications zurück. Diesen Weg
   beherrscht die App bereits (`GeminiAcpSession.load`).
2. **Über die internen Dateien** — schnell und offline, aber kein Vertrag,
   sondern fremde Persistenz.

Der tragfähige Entwurf kombiniert beide: **billig anzeigen, teuer erst
fortsetzen.** Der Import erzeugt zunächst ein lesbares Archiv; ein
`session/load` passiert erst, wenn der Benutzer in einer importierten
Session tatsächlich weiterschreiben will.

Ein automatischer Import beim Start wird ausdrücklich nicht empfohlen
(Begründung in Abschnitt 5).

## 1. Ausgangslage: zwei getrennte Wahrheiten

| | Gemini CLI | GeminUI |
|---|---|---|
| Speicher | `~/.gemini/tmp/<project_hash>/chats/*.jsonl` | SQLite (`sessions`, `events`) |
| Zuordnung | Hash des Arbeitsverzeichnisses | `project_id` + Root-Fingerprint |
| Identität | Session-UUID | `appSessionId` + `providerSessionId` |
| Inhalt | Prompts, Antworten, Tool-Ausführungen, Tokenstatistik, Reasoning-Summaries | normalisierte Events (`seq`, `turn_id`, `event_type`, `payload_json`) |
| Aufbewahrung | Standard 30 Tage, konfigurierbar über `maxAge`, `maxCount`, `minRetention` | unbegrenzt bis zum Löschen durch den Benutzer |

Die App kennt bereits beide Identitäten getrennt (Abschnitt 10 in
`implementation.md`), und `binary-probe.ts` erkennt bereits, ob die
installierte CLI `--resume`, `--list-sessions` und `--delete-session`
unterstützt. Die Bausteine für einen Import sind damit größtenteils schon
vorhanden — es fehlt der Einstiegspunkt, die Kandidatenermittlung und ein
Herkunftsfeld im Datenmodell.

## 2. Drei Ausbaustufen

Der Begriff „Import“ verdeckt drei Funktionen mit sehr unterschiedlichem
Aufwand und Risiko. Sie sind einzeln lieferbar und bauen aufeinander auf.

### Stufe A — Katalog

Nur Metadaten: Datum, erster Prompt als Titel, Anzahl Nachrichten,
Session-UUID. Quelle: `gemini --list-sessions`, ausgeführt mit dem
Projekt-Hauptordner als `cwd`.

Nutzen: Die Sidebar kann zeigen „12 Terminal-Sessions in diesem Projekt“,
ohne eine Zeile Gesprächsinhalt zu lesen. Kein Prozess pro Session, kein
Zugriff auf fremde Dateiformate.

### Stufe B — Verlauf (Archiv, read-only)

Der tatsächliche Gesprächsverlauf landet als Events in der App-Datenbank
und ist in der Timeline lesbar, aber nicht fortsetzbar.

### Stufe C — Fortsetzbar

Die importierte Session wird zu einer vollwertigen App-Session: ein neuer
Prompt geht an dieselbe Gemini-Session weiter. Das hängt vollständig an
`session/load`.

## 3. Der vertragliche Weg: ACP `session/load`

Ablauf pro Session:

1. **Capability prüfen.** ACP-Handshake liefert `loadSession`;
   `capabilities.ts` normalisiert das bereits. Fehlt die Fähigkeit, wird
   Stufe C gar nicht erst angeboten.
2. **Kandidaten ermitteln.** `gemini --list-sessions` im Hauptordner des
   Projekts. Die Zuordnung zum App-Projekt ergibt sich dadurch implizit,
   weil die CLI selbst nach Arbeitsverzeichnis scoped. **Das ist der
   entscheidende Punkt:** GeminUI muss den `project_hash` nicht nachbauen
   und umgeht damit die fehleranfällige Multi-Root-, Symlink- und
   Windows-Pfad-Zuordnung.
3. **Vorschau.** Dialog mit Mehrfachauswahl; bereits importierte Sessions
   sind erkennbar und nicht erneut auswählbar.
4. **Datensatz anlegen.** `sessions`-Zeile mit `provider_session_id` =
   Gemini-UUID, `status = 'disconnected'`, `origin = 'cli-import'`. Der
   vorhandene CHECK auf `provider = 'gemini-cli'` und der Status
   `disconnected` existieren bereits — kein neuer Zustand nötig.
5. **Laden.** ACP-Prozess mit dem **aktuellen** Root-Satz starten,
   `session/load` mit der vollen UUID senden.
6. **Normalisieren.** Die zurückgespielten `session/update`-Notifications
   laufen durch den bestehenden `event-normalizer` und werden ab `seq = 1`
   persistiert. Kein zweiter Renderer-Pfad, keine Sonderdarstellung.
7. **Abschließen.** Root-Revision und Fingerprint erfassen, Titel aus dem
   ersten Prompt ableiten, Prozess wieder freigeben.

Vorteil: Es ist der einzige Weg, der auf einem Vertrag beruht, und er
liefert Stufe B und C in einem Zug.

Nachteil: `session/load` hatte in aktuellen Releases Regressionen beim
Zurückspielen der Historie (siehe `implementation.md` §19.1 und den
offiziellen Issue). Ein Import, der auf einen leeren Replay läuft, erzeugt
leere Archivsessions — schlimmer als gar kein Import. Deshalb gilt die
dort bereits festgelegte Regel unverändert: **bei fehlender oder
fehlerhafter Fähigkeit keine scheinbar erfolgreiche Fortsetzung anzeigen.**

## 4. Der schnelle Weg: JSONL lesen

Aus den Dateien lässt sich ohne Prozessstart alles gewinnen: `sessionId`,
`projectHash`, `model`, `startTime`, `lastUpdated`, `messageCount`,
`displayName`, die Nachrichten selbst und die Tokenstatistik.

`token-usage.md` hat dazu bereits eine Position: nicht für Live-Tracking
und nicht standardmäßig für Backfills; eine spätere Importfunktion müsste
„versionsgebunden, read-only und mit klarer Vorschau“ gebaut werden. Diese
Bedingungen gelten weiter und sind erfüllbar:

- ausschließlich lesender Zugriff, niemals schreiben oder löschen;
- tolerantes Schema — unbekannte Felder ignorieren, defekte Zeilen
  überspringen statt den Import abzubrechen;
- an eine geprüfte CLI-Versionsspanne gebunden, mit Fixtures pro Version;
- hinter einem Feature-Flag, mit sichtbarer Herkunftsangabe an jeder
  importierten Session.

Nachteil bleibt: Das Format ist interne Persistenz der CLI und kann sich
jederzeit ändern. Der Parser ist damit dauerhaft Wartungslast.

## 5. Warum nicht automatisch beim Start

- **Startzeit.** Der vertragliche Weg braucht pro Session einen
  CLI-Prozess samt Handshake. Bei 40 alten Sessions sind das Minuten statt
  Millisekunden — genau im kritischsten Moment der App.
- **`session/load` ist kein reiner Lesevorgang.** Es startet Prozesse und
  berührt Kontext- und Tokenzustand einer fremden Session. Das darf nicht
  ungefragt passieren.
- **Erwartungshaltung.** Ein Terminal-Verlauf ungefragt in eine
  Anwendungsdatenbank zu kopieren, ist eine Datenentscheidung des
  Benutzers, keine Startroutine.
- **Divergenz.** Nach dem Import existieren zwei Wahrheiten. Die CLI
  löscht ihre Kopie nach 30 Tagen, GeminUI nicht. Wer das nicht bewusst
  ausgelöst hat, versteht die Abweichung später nicht.

**Empfohlener Kompromiss:** Beim ersten Öffnen eines Projekts einmal
billig prüfen, ob es überhaupt CLI-Sessions gibt (Stufe A, ein Aufruf),
und einen unaufdringlichen Hinweis in der Sidebar anzeigen:
„12 Terminal-Sessions gefunden — importieren?“. Der teure Teil passiert
erst nach dem Klick. Ein Zeitstempel pro Projekt
(`cli_import_prompted_at`) verhindert, dass die Frage wiederkehrt.

## 6. Empfehlung: Anzeige und Fortsetzung entkoppeln

Der eleganteste Zuschnitt trennt zwei Dinge, die intuitiv
zusammengehören:

1. **Import = Archivieren.** Verlauf einlesen (Stufe B), Session als
   `disconnected` und `origin = 'cli-import'` speichern. Schnell, offline,
   ohne Prozess — wahlweise aus JSONL oder aus einem `session/load`.
2. **Fortsetzen = Lazy Resume.** Erst wenn der Benutzer in einer
   importierten Session schreibt, wird `session/load` mit der gespeicherten
   UUID versucht. Gelingt es, wird die Session zu einer normalen
   App-Session. Gelingt es nicht, bleibt sie ein sauber lesbares Archiv,
   und die App bietet stattdessen an, eine neue Session mit dem alten
   Verlauf als Kontext zu starten.

Damit hängt der sichtbare Nutzen nicht an der instabilsten Stelle des
Stacks, und die bekannte `session/load`-Regression degradiert die
Funktion, statt sie zu blockieren.

## 7. Datenmodell

Neue Migration (nächste freie Version: 12):

```sql
ALTER TABLE sessions ADD COLUMN origin TEXT NOT NULL DEFAULT 'app'
  CHECK(origin IN ('app', 'cli-import'));
ALTER TABLE sessions ADD COLUMN import_source TEXT
  CHECK(import_source IS NULL OR import_source IN ('acp-load', 'jsonl'));
ALTER TABLE sessions ADD COLUMN imported_at TEXT;

CREATE UNIQUE INDEX sessions_imported_provider_unique
  ON sessions(project_id, provider_session_id)
  WHERE origin = 'cli-import';
```

Der partielle UNIQUE-Index ist die Idempotenz: Ein zweiter Importlauf
derselben CLI-Session erzeugt keine Dublette, unabhängig davon, wie oft
der Dialog geöffnet wird.

Zusätzlich sollte das erste Event einer importierten Session ein
synthetisches `session.imported` sein, das Quelle, CLI-Version und
Importzeitpunkt trägt. Damit ist die Timeline selbsterklärend, und
`payload_json` bleibt der einzige Ort für Herkunftsdetails.

## 8. Oberfläche

- **Einstieg:** Kontextmenü der Sidebar-Sektion und der leere Zustand
  („Noch keine Sessions — aus dem Terminal importieren?“).
- **Dialog:** Tabelle mit Datum, Titel/erstem Prompt, Nachrichtenzahl und
  Status (`neu` / `bereits importiert`), Mehrfachauswahl, Fortschritt pro
  Zeile statt eines globalen Balkens.
- **Gekennzeichnete Sessions:** Badge „CLI“ in der Sidebar, Banner über der
  Timeline: „Am 22.08. aus dem Terminal importiert. Der Verlauf stammt aus
  der Gemini CLI und kann unvollständig sein.“
- **Fortsetzen:** eigener Button, der den Lazy Resume auslöst — mit der
  Root-Divergenz-Warnung aus `implementation.md` §10.2 Schritt 4, falls
  sich der Root-Satz seit der CLI-Session geändert hat.

## 9. Kanten und Risiken

- **Selbstimport.** Läuft GeminUI selbst über ACP, schreibt die CLI
  möglicherweise ebenfalls nach `chats/`. Die eigenen
  `provider_session_id`-Werte müssen vor der Anzeige herausgefiltert
  werden, sonst bietet die App an, ihre eigenen Sessions zu importieren.
- **Menschenlesbare Ausgabe.** `--list-sessions` ist kein JSON-API. Der
  Parser bleibt isoliert und versionsgetestet (`implementation.md` §19.2).
  Falls die CLI nur einen flüchtigen Listenindex liefert, wird unmittelbar
  vor der Aktion neu gelistet; Indizes werden nie gespeichert.
- **Root-Divergenz.** Eine CLI-Session lief eventuell mit anderem `cwd`
  oder anderen `--include-directories`. Fortsetzen ohne Warnung wäre
  irreführend.
- **Event-Fenster.** Die Event-Repository-Grenzen liegen bei 1000 Events
  pro Batch und Abfrage; der Renderer abonniert ab Sequenz null. Lange
  CLI-Sessions müssen beim Import in Batches geschrieben und beim Öffnen
  ab dem Ende gelesen werden, sonst zeigt die Timeline nach einem Neustart
  nur den Anfang.
- **Aufbewahrung.** Die CLI löscht ihre Kopie nach Ablauf der Retention.
  Import ist ein Kopiervorgang, keine Verknüpfung.
- **Verfügbarkeit.** Ältere CLI-Versionen kennen weder `--list-sessions`
  noch `session/load`. Die Funktion muss vollständig verschwinden, statt
  mit Fehlern zu antworten.

## 10. Aufwandsschätzung

| Stufe | Inhalt | Aufwand |
|---|---|---|
| A | Migration, Kandidatenermittlung, Dialog, Sidebar-Hinweis | 1–2 Tage |
| B über `session/load` | Load-Pfad ohne UI-Session, Event-Persistenz, Dedupe | 1–2 Tage + Contract-Test-Gate |
| B über JSONL | Parser, Fixtures, Feature-Flag, Versionsbindung | 2–3 Tage |
| C | Lazy Resume, Root-Divergenz-Flow, Fehlerpfade | 1 Tag auf Basis von B |

## 11. Testplan

- **Parser:** Fixtures der `--list-sessions`-Ausgabe je geprüfter
  CLI-Version; leere Liste; Session ohne Titel; Sonderzeichen und Umbrüche
  im ersten Prompt; abweichende Spaltenbreiten.
- **Idempotenz:** Import derselben Session zweimal erzeugt genau eine
  Zeile; paralleler Doppelklick ebenfalls.
- **Filter:** App-eigene Sessions tauchen im Dialog nicht auf.
- **Load-Vertrag:** echte CLI-Version, zwei Turns mit einem eindeutigen
  Merkwort, anschließend Import und Fortsetzung — das Merkwort muss im
  zurückgespielten Verlauf vorkommen (identisches Muster wie der
  Resume-Contract-Test in §19.1).
- **Degradation:** CLI ohne `loadSession` → Archiv wird angezeigt,
  Fortsetzen ist deaktiviert und begründet, kein stiller Neustart.
- **Umfang:** Session mit über 1000 Nachrichten → Batch-Schreiben,
  vollständige Timeline nach App-Neustart.

## Quellen

- [Gemini CLI: Session Management](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/session-management.md)
- [Gemini CLI Docs: Session management](https://geminicli.com/docs/cli/session-management/)
- [DeepWiki: Session Management (google-gemini/gemini-cli)](https://deepwiki.com/google-gemini/gemini-cli/3.9-session-management)
- [ACP session/load regression](https://github.com/google-gemini/gemini-cli/issues/28693)
- interne Vorgaben: `implementation.md` §10.2, §10.3, §19.1, §19.2 sowie
  `token-usage.md` („`~/.gemini/tmp/.../chats` automatisch parsen“)
