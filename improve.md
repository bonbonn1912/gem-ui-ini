# Verbesserungsvorschläge für GeminUI

Stand: 26.09.2026 · untersuchter Commit: `387e1f7` · App-Version: `0.15.0`

## 1. Ergebnis und Untersuchungsumfang

Die größten Hebel sind die korrekte und begrenzte Verarbeitung langer Verläufe, das Freigeben nicht mehr benötigter WebContents/Gemini-Prozesse und weniger Arbeit pro Streaming-Update. Ein Wechsel von Electron ist dafür nicht erforderlich. Die vorhandene Trennung zwischen Main-Prozess, Preload, Renderer, ACP-Adapter und Repositories ist eine brauchbare Grundlage.

Diese Datei ist eine Analyse mit Umsetzungsplan. Die beschriebenen Änderungen am Anwendungscode sind noch nicht implementiert. Befunde sind entweder durch gezielte lokale Prüfungen bestätigt, direkt aus dem Code abgeleitet oder ausdrücklich als zu messende Optimierung gekennzeichnet. Es wurden keine Windows-Laufzeitmessungen und keine realen Gemini-0.60/0.61-Modellaufrufe durchgeführt. Deshalb sind weder eine konkrete Beschleunigung noch vollständige Versionskompatibilität bereits nachgewiesen.

Untersucht wurden insbesondere ACP-Transport und Normalisierung, Session-Lifecycle, IPC/Replay, SQLite, React-Timeline, Markdown, Git-Aktualisierungen, Dateisuche, Anhänge, Linkvorschau, Build und CI. Die Integrationen wurden stichprobenartig betrachtet; dies ist kein vollständiges Security-Audit aller GitLab-/Jira-/Updatepfade.

### Lokale Prüfungen

| Prüfung | Ergebnis |
| --- | --- |
| `npm run typecheck` | Erfolgreich |
| `npm test` | 26 Testdateien bestanden, eine übersprungen; 253 Tests bestanden, einer übersprungen |
| Zwei zusätzliche temporäre Audit-Tests | Bestätigen Replay-Limit, Suchfehler über Chunk-Grenzen und Listener-Leck; anschließend entfernt |
| `npx vite build --config vite.renderer.config.ts` | Erfolgreich; 414 Module; ein JS-Einstiegspaket mit 806,52 kB minifiziert / 219,67 kB gzip, CSS 209,84 kB / 32,82 kB gzip |
| Electron-Paket, E2E, echte Gemini-Versionen, Windows-Profiling | In dieser Untersuchung nicht ausgeführt |

Die gzip-Werte beschreiben die Build-Ausgabe, nicht den RAM-Verbrauch einer lokal geladenen Electron-App. Der Renderer-Build meldet ein Paket über 500 kB. Eine Änderung der Warnschwelle würde dessen Lade-/Parsekosten nicht reduzieren.

### Bereits gut gelöst

- Renderer-Sandbox, Context Isolation, typisierte und validierte IPC-Grenzen.
- Windows-npm-Shim-Auflösung ohne Shell, `windowsHide`, begrenzte stderr- und Protokollausgaben.
- Streaming-Deltas werden bereits innerhalb von 32 ms zusammengeführt und mit `appendBatch` gespeichert. Batching muss verbessert, nicht erstmals eingeführt werden.
- SQLite verwendet WAL und `synchronous=NORMAL`.
- PDF-Extraktion läuft bereits außerhalb des Main-Prozesses; Dateisuche hat Index-TTL, Ausschlussverzeichnisse und ein Dateilimit.
- Tokenverbrauch und Kontextbelegung sind getrennt modelliert; der Usage-Reducer berücksichtigt Snapshot-Revisionen.
- Modellwechsel unterstützt sowohl Config Options als auch das ältere `session/set_model`.

## 2. Prioritäten

P1 bezeichnet relevante Funktionsfehler oder wahrscheinlich große Ressourcenprobleme. P2 bezeichnet Optimierungen und Erweiterungen mit geringerem unmittelbarem Risiko. Aufwand: S = lokal begrenzt, M = mehrere Schichten, L = Architektur/Datenschema plus Migration und Tests.

| ID | Priorität | Maßnahme | Aufwand | Wirkung |
| --- | --- | --- | --- | --- |
| F01 | P1 | Replay vollständig und paginiert machen | L | Korrekte Historie; Grundlage für große Sessions |
| F02 | P1 | Link-WebContents wirklich schließen | S | Verhindert zurückbleibende Browserinhalte |
| F03 | P1 | Subscription-Listener und verspätete IPC-Batches aufräumen | S–M | Stabile Langzeitnutzung |
| F04 | P1 | Wiederverbindung und Kontextübernahme korrigieren | M | Verhindert unnötige neue Sessions und veralteten Kontext |
| F05 | P1 | ACP-Nachrichten und Tool-Daten verlustfrei abbilden | M | Richtige Reihenfolge, Diffs, Dateiverweise |
| F06 | P1 | Prozessbudget atomar verwalten; Sparmodus | M | Weniger RAM und Startspitzen |
| F07 | P1 | Timeline virtualisieren, Markdown-/Renderarbeit begrenzen | L | Flüssiges Streaming auch bei langen Chats |
| F08 | P1 | Event-Puffer begrenzen und Persistenzfehler behandeln | M | Kein stiller Eventverlust bei Last/Schreibfehlern |
| F09 | P2 | Nachrichtensuche statt Suche in einzelnen Deltas | M | Korrekte Suche und weniger Main-Blockaden |
| F10 | P2 | Git-Abfragen bündeln, drosseln und begrenzen | M | Weniger CPU, Dateisystem- und Prozesslast |
| F11 | P2 | Startpfad und optionale Oberflächen entkoppeln | M | Früher bedienbares Fenster |
| F12 | P2 | SQLite-Arbeit gezielt auslagern/optimieren | L | Reaktionsfähiger Main-Prozess bei großen Datenbeständen |
| F13 | P2 | Dateiindex, Viewer und Extraktion ressourcenabhängig betreiben | M | Weniger Speicher- und I/O-Spitzen |
| F14 | P2 | Debug-Daten und visuelle Effekte begrenzen | S–M | Weniger RAM/CPU/GPU im Dauerbetrieb |
| F15 | P2 | Veraltete Antworten und Auswahl-Races verhindern | S–M | Konsistente Oberfläche bei schnellen Wechseln |

## 3. Gemini CLI 0.6x und ACP

### 3.1 Was tatsächlich belegt ist

„0.6x“ wird hier als **0.60.x und 0.61.x** verstanden, nicht als die alte Version 0.6.0. Das README nennt derzeit 0.56.0 als Mindestversion. Der Code prüft keine feste obere Versionsgrenze, sondern Versionstext, Hilfe und anschließend ACP v1. Neue Versionen sind damit nicht grundsätzlich gesperrt; „0.56.0 oder neuer“ ist allerdings keine getestete Kompatibilitätsgarantie.

Die geprüften offiziellen Release-Seiten weisen **0.61.0 als Latest** aus. Daneben gibt es 0.62-Preview-/Nightly-Releases. In 0.60.0 werden unter anderem Windows-NTFS-/Pfadprüfungen, Konfigurationsrechte, Extension-/OAuth- und Sandbox-Härtungen genannt. 0.61.0 enthält unter anderem einen Fix für explizite versionierte Flash-Modell-IDs und weitere Core-/Sandbox-Korrekturen. Diese konkreten Release-Notizen belegen keine neue ACP-Methode, die pauschal ab 0.60 eingeschaltet werden sollte. Quellen: [Release 0.60.0](https://github.com/google-gemini/gemini-cli/releases/tag/v0.60.0), [Release 0.61.0](https://github.com/google-gemini/gemini-cli/releases/tag/v0.61.0), [Release-Übersicht](https://github.com/google-gemini/gemini-cli/releases).

Die Gemini-Dokumentation bestätigt ACP über stdio mit `--acp` sowie Session-Erstellung/-Laden, Prompts, Abbruch, Authentifizierung und Session-Steuerung. Die öffentliche Dokumentation ist jedoch keine versionsgebundene Feature-Matrix. Ein direkter Abruf des getaggten `acpClient.ts` für 0.61.0 war hier nicht erfolgreich; die genaue Implementation dieser Version wurde daher nicht verifiziert. Quelle: [Gemini ACP Mode](https://geminicli.com/docs/cli/acp-mode/).

Das Projekt verwendet `@agentclientprotocol/sdk` **1.3.0**. Die abgerufene offizielle SDK-Dokumentation beschreibt **1.5.0**, dessen Standard-Einstieg weiterhin ACP v1 ist. ACP v2 ist ein separater experimenteller Draft. Ein SDK-Update darf daher nicht mit einem Wechsel des Wire-Protokolls verwechselt werden. Quelle: [TypeScript SDK](https://agentclientprotocol.github.io/typescript-sdk/).

### 3.2 Kompatibilitätsstrategie

1. **Transportprofil statt Versionsheuristik:** CLI-Pfad, tatsächlich unterstütztes ACP-Flag, Version, Protokollversion, Agent-Capabilities und Session-Config-Snapshot getrennt speichern. Features anhand ausgehandelter Fähigkeiten aktivieren.
2. **Inkonsistente Flag-Erkennung beheben:** `binary-probe.ts:112` akzeptiert `--experimental-acp`, `gemini-process.ts:69` startet trotzdem immer `--acp`. Entweder den alten Alias ausdrücklich ablehnen oder das erkannte Flag bis zum Spawn weiterreichen. Auch das zwingend verwendete `--skip-trust` in die Prüfung aufnehmen. Das ist ein vorhandener Adapterfehler, kein nachgewiesener 0.61-Regressionsfehler.
3. **CLI-Hilfe nicht als ACP-Capability verwenden:** `capability-service.ts:124` leitet z. B. `sessionLoad` aus `--resume` und Bildfähigkeit aus ACP-Verfügbarkeit ab. Bis zum Handshake „noch nicht geprüft“ darstellen, danach Session-Capabilities verwenden.
4. **Versionierte Modell-IDs unverändert durchreichen:** Nicht selbst aus Anzeigenamen rekonstruieren. Legacy- und Config-Option-Pfade mit solchen IDs testen.
5. **SDK 1.5.x in einem eigenen Update prüfen:** Typecheck, Fake-Agent-Verträge, Replay und reale CLI-Matrix ausführen; auf ACP v1 bleiben. Unbekannte optionale Daten diagnostizieren und kontrolliert ignorieren, statt den gesamten Turn zu verwerfen.
6. **Timeouts für schwächere Systeme:** Die derzeitigen 5 s für Probe-Kommandos und 10 s für `initialize` separat von Modellantwortzeiten behandeln. Kalte Windows-/Antivirus-Starts messen; z. B. einen einstellbaren Startzeitraum bis 30 s mit Fortschrittsanzeige und Abbruch testen. Kein pauschales Zeitlimit für lange Modellantworten einführen.
7. `clientInfo.version` in `acp-session.ts:412` aus der App-Version beziehen; momentan wird `0.1.0` statt `0.15.0` gesendet.

### 3.3 Nützliche zusätzliche ACP-Funktionen

Die folgende Tabelle trennt **ACP-Verfügbarkeit** von **Gemini-Unterstützung**. „Bedingt“ heißt: erst nach passender Capability bzw. tatsächlich angekündigten Daten aktivieren. Für neue Gemini-Versionen ist dies mit realen Handshakes zu prüfen.

| Funktion | Aktueller Projektzustand | Empfehlung / Nutzen |
| --- | --- | --- |
| Generische `configOptions` | Nur Modell-Select wird ausgewertet; Modi kommen aus `modes` | P1 für Zukunftsfähigkeit: generisches Config-Modell und UI, Mode-/Reasoning-/Modellparameter erhalten; Legacy-Fallback behalten |
| Boolean Config Options | Client meldet keine Unterstützung | P2: nach SDK-Prüfung Checkboxen und typisierte Requests ergänzen; erst dann Capability anbieten |
| `session/resume` | Capability wird normalisiert, Methode nicht verwendet | P1 zusammen mit Prozess-Sparmodus: bei vorhandener lokaler Historie ohne Provider-Replay fortsetzen; bedingt |
| `session/close` | Capability erkannt, nur Prozess-Dispose implementiert | P2: Agent-Ressourcen geordnet freigeben; Prozess bei eigener Einzelsession anschließend ebenfalls beenden; bedingt |
| `session/list` / `session/delete` | Fähigkeiten erkannt; kein Import, Löschen per CLI-Kommando | P2: Terminal-Sessions paginiert importieren, Provider-Löschen über ACP bevorzugen; vorhandenen geprüften CLI-Fallback behalten |
| `additionalDirectories` | Fähigkeit erkannt; nur CLI-Flags verwendet | P2: Lifecycle-Requests mit vollständigem Root-Satz ergänzen, sobald angekündigt; für bisherige Gemini-Versionen CLI-Fallback |
| Pläne | Normalisiert, im Controller verworfen | P1/P2: Agentenplan mit Status rendern; nicht automatisch mit benutzereigenen Todos gleichsetzen |
| Slash Commands | Persistiert, im Reducer ignoriert | P2: dynamische Vorschläge im Composer inklusive Argumenthinweisen; nur tatsächlich angebotene Befehle anzeigen |
| `session_info_update` | Normalisiert, verworfen | P2: Agententitel und Aktualisierungszeit übernehmen, benutzervergebene Titel respektieren |
| Message IDs, strukturierte Tool-Inhalte | Im Adapter teilweise vorhanden, später verloren | P1: siehe F05; erleichtert Replay, Diffs und korrekte Nachrichtenreihenfolge |
| Elicitation | Kein Handler; `clientCapabilities: {}` | P2: echte Rückfragen/Formulare und externe Auth-Flows unterstützen, sobald Agent sie nutzt |
| Audio / eingebettete Ressourcen | Audio im Adapter angelegt; Shared-Timeline wandelt nur Text durch | P2: nur mit vollständigem UI-/Speicherpfad und passenden Capabilities anbieten; Größenlimits und bedarfsgeladene Medien |
| Client-Dateisystem / Terminal | Bewusst nicht angeboten | Optional: nur für konkrete Editor-/Terminalfunktionen; erhöht Implementierungs- und Ressourcenbedarf |
| MCP-Server pro Session | `mcpServers: []`; Settings werden separat dargestellt | Optional: gezielt ausgewählte, genehmigte Server weiterreichen; keine Duplikate zu CLI-Settings erzeugen |

**Config Options:** Sie sind in ACP der bevorzugte Konfigurationsweg. Reihenfolge, gruppierte Selects, unbekannte Kategorien und agentenseitige Änderungen müssen erhalten bleiben. Boolean-Unterstützung muss ausdrücklich angekündigt werden. Ein Mode, der nur über Config Options kommt, würde derzeit nicht im bestehenden Mode-Pfad auftauchen. Quelle: [Session Config Options](https://agentclientprotocol.com/protocol/v1/session-config-options).

**Lifecycle:** `resume` vermeidet das Replay früherer Nachrichten; `close` gibt Session-Ressourcen frei. Zusätzliche Roots müssen bei unterstützten Lifecycle-Requests vollständig erneut angegeben werden. Alle drei Funktionen benötigen die passende Capability. Quellen: [Session Setup](https://agentclientprotocol.com/protocol/v1/session-setup), [Session List](https://agentclientprotocol.com/protocol/v1/session-list), [Session Delete](https://agentclientprotocol.com/protocol/v1/session-delete).

**Rückfragen:** Elicitation ist ein eigener Dialogtyp, keine Tool-Freigabe. Formular-, Ablehnungs- und Abbruchpfade sowie die Session-Zuordnung implementieren; sensible Authentifizierung über den externen URL-Flow. URLs erst nach Nutzerzustimmung öffnen. Die Capability erst nach vollständiger Implementierung anbieten. Quelle: [Elicitation](https://agentclientprotocol.com/protocol/v1/elicitation).

**Keine vorschnellen Feature-Zusagen:** Subagents, Rewind, Memory, Hooks oder Compaction einer CLI-Version sind nicht automatisch standardisierte ACP-UI-Funktionen. Nur tatsächlich transportierte Events, Capabilities oder angekündigte Slash Commands integrieren. ACP-v2-Draft, Session-Fork und andere Vorschläge separat verfolgen; sie gehören nicht zur Voraussetzung für 0.60/0.61.

## 4. Konkrete Fehler und Verbesserungen

### F01 – Lange Sessions werden beim Replay abgeschnitten

**Belege:** `src/main/storage/repositories/event-repository.ts:47`, `src/main/index.ts:207`, `src/main/ipc/event-hub.ts:37`, `src/preload/index.ts:443`, `src/renderer/app/App.tsx:699`.

`listAfter` liefert standardmäßig höchstens 1.000 Events. Der Hub ruft es einmal auf. Der Renderer beginnt beim Session-Wechsel wieder bei `afterSeq: 0`; ein weiterer Abruf existiert nicht. Ein Audit-Test mit 1.002 gespeicherten Events erhielt genau 1.000 zurück. Spätere historische Events bleiben unsichtbar. Ein danach eintreffendes Live-Event kann `lastSeq` über die Lücke hinaussetzen.

**Verbesserung:** Replay-API mit Cursor, `hasMore` und festem `replayUntilSeq`. Zunächst einen materialisierten Timeline-Snapshot bis Sequenz S liefern, dann den Event-Rest bis zur Replay-Grenze; Live-Events darüber puffern. Für ältere Nachrichten separate Seiten laden. Lücken explizit erkennen und nachladen. Keine unbegrenzte `.all()`-Abfrage als Ersatz für das aktuelle Limit.

**Abnahme:** 50.000 Events, Renderer-Reload während des Streams, Wechsel zwischen Sessions und gleichzeitige Publikation: keine Lücken/Duplikate, korrekter Endzustand und begrenzte IPC-Paketgröße. Historische Events dürfen keine neuen Git-Refreshes oder vermeintlich aktuellen Tool-Aktivitäten auslösen.

### F02 – Linkvorschau entfernt die View, schließt aber nicht ihre WebContents

**Beleg:** `src/main/links/link-preview-view.ts:111`.

`close()` ruft nur `removeChildView` auf und verwirft die Referenz. Jede neue Vorschau erzeugt eine neue `WebContentsView`. Der Lebenszyklus beendet deren Browserinhalte nicht ausdrücklich. Electron verlangt die explizite Freigabe solcher WebContents. Das ist ein besonders relevanter Leak-Kandidat auf Rechnern mit wenig RAM. Quelle: [Electron Resource Management](https://www.electronjs.org/docs/latest/api/base-window#resource-management).

**Verbesserung:** Beim endgültigen Schließen die konkrete View abnehmen und ihre `webContents` über die unterstützte Close-API schließen, mehrfaches Schließen absichern. Das bloße Verstecken einer noch benötigten View bleibt ein eigener Vorgang. Zusätzlich `open()` mit einer Generation versehen: Ein verspäteter Fehler von Vorschau A darf nach dem Öffnen von B nicht `this.close()` auf B ausführen.

**Abnahme:** 100-mal öffnen/schließen; Anzahl lebender Vorschau-WebContents kehrt jedes Mal zum Ausgangswert zurück, Speicher wächst nach Beruhigung nicht monoton. A langsam laden lassen, B öffnen, A fehlschlagen lassen: B bleibt sichtbar. Bisherige Mocks müssten dafür `webContents.close` und den Lebenszyklus tatsächlich prüfen.

### F03 – Listener und verwaiste IPC-Warteschlangen

**Belege:** `src/main/ipc/event-hub.ts:49`, `src/main/ipc/event-hub.ts:66`, `src/preload/index.ts:33`.

Jedes Subscribe registriert einen `once("destroyed")`-Listener. Unsubscribe und `close()` entfernen nur Map-Einträge. Im Audit blieben nach 25 Subscribe-/Unsubscribe-Zyklen 25 Listener am selben WebContents bestehen. Der Git-Subscription-Hub enthält bereits ein besseres Muster mit gespeicherter Listener-Referenz.

Im Preload werden unbekannte Subscription-IDs als noch nicht registrierte Abonnements behandelt. Ein verspätetes Paket nach Unsubscribe kann dadurch wieder einen Pending-Eintrag erzeugen, den niemand abholt. Die 50-Batch-Grenze begrenzt außerdem weder Bytes noch die Anzahl solcher IDs; Überlauf verwirft Events ohne Resync.

**Verbesserung:** Listener explizit abmelden, auch nach fehlgeschlagenem Subscribe. Pending-, aktive und beendete Abonnements unterscheiden; Abschlussmarker zeitlich begrenzen. Bytebudget und Timeout für Pending-Pakete, Überlauf mit Replay-Nachholung behandeln.

**Abnahme:** 1.000 Session-Wechsel ohne Listeneranstieg; verspätete Events nach Unsubscribe bleiben ohne neue dauerhafte Queue. Überlauf führt zu nachweislich vollständigem Resync.

### F04 – Wiederverbindung verwendet zu breite Fallbacks und alten Kontext

**Belege:** `src/main/app-controller.ts:809`, `src/main/app-controller.ts:1223`, `src/main/app-controller.ts:1271`.

Jeder Fehler von `session/load` führt zum Versuch, eine neue Provider-Session zu erstellen. Das gilt auch für temporäre Transport-/Auth-/Timeoutfehler. Für eine spätere Kontextübernahme liest `#buildCompressedHistory` nur die ersten 1.000 Events und kürzt jede Nachricht separat. Gerade die neuesten Entscheidungen einer langen Session fehlen. `#hasPreviousHistory` untersucht nur die ersten zehn Events und kann vorhandene Nachrichten dahinter übersehen.

Zusätzlich werden bei `session/load` frühere Textnachrichten mangels aktivem Turn verworfen, Tool-Events aber weiterhin in Shared Events übersetzt. Falls der Agent beim Laden Tools wiedergibt, können somit alte Tools erneut gespeichert werden. Diese Variante muss mit einem replayenden Fake-Agent reproduziert werden.

**Verbesserung:** Fehlerklassen unterscheiden; nur bei sicher fehlender/nicht ladbarer Historie eine neue Session anbieten bzw. den vorgesehenen Recovery-Flow auslösen. `resume` bei passender Capability bevorzugen. Provider-Replay als eigenen Modus behandeln und anhand stabiler IDs abgleichen. Kontextübernahme aus vollständigen materialisierten Nachrichten aufbauen: ältere Zusammenfassung plus jüngste vollständige Turns innerhalb eines Gesamtbudgets. Vorhandene Historie per SQL-`EXISTS` prüfen.

**Abnahme:** Neueste Entscheidung nach mehr als 1.000 Events bleibt enthalten; Auth-/Timeoutfehler überschreiben keine Provider-ID; mehrfaches Laden vervielfacht keine Tools. Nicht automatisch eine neue Modell-Zusammenfassung erzeugen, ohne deren zusätzliche Laufzeit und Kosten im Produktfluss zu berücksichtigen.

### F05 – ACP-Daten gehen im Shared-Mapping verloren

**Belege:** `src/main/gemini/event-normalizer.ts:37`, `src/main/app-controller.ts:1385`, `src/renderer/features/chat/reducer.ts:403`, `src/shared/contracts/events.ts:83`.

Der Normalizer erhält Provider-Message-IDs und Tool-Felder. Der Controller ersetzt Text-IDs jedoch durch eine einzige Assistant-/Thought-ID pro Turn. Zwischenantworten vor einem Tool und die Schlussantwort können dadurch zu einem früheren Eintrag zusammenwachsen. Auch der Reducer besitzt einen Turn-Fallback, der explizit unterschiedliche Nachrichten wieder zusammenführen kann.

`tool.started` verliert u. a. `locations` und strukturierte Inhalte; `tool.updated` reduziert mehrere mögliche Felder auf ein generisches `update`; `tool.completed` bevorzugt `rawOutput` gegenüber `content`. Das erschwert die Darstellung präziser Diffs/Dateiverweise. Nichttextuelle Antworten werden durch `contentToText` vollständig verworfen.

**Verbesserung:** Eigene lokale UUID und opaque Provider-ID getrennt führen – Provider-IDs dürfen nicht ungeprüft in das UUID-validierte `messageId`-Feld gelangen. Stabile Zuordnung pro Provider-Session; Legacy-Segmentierung nur bei fehlender ID. Tool-Updates als partielle Patches nach `toolCallId` zusammenführen, abwesende Felder erhalten, strukturierte `content`-Blöcke und `rawOutput` getrennt speichern. Große Inhalte als referenzierte Blobs.

**Abnahme:** Assistant A → Tool → Assistant B ergibt drei korrekt geordnete Einträge, auch nach Replay. Ein ausschließlich über `content` gelieferter Diff ist sichtbar; partielle Updates löschen keine früheren Metadaten. Quelle für die Transportstruktur: [ACP Tool Calls](https://agentclientprotocol.com/protocol/v1/tool-calls).

### F06 – Das Prozesslimit ist nicht atomar und Idle-Prozesse bleiben warm

**Belege:** `src/main/app-controller.ts:923`, `src/main/sessions/gemini-session-manager.ts:54`, `src/main/sessions/gemini-session-manager.ts:143`, `src/main/processes/gemini-process.ts:194`.

`#makeRoomForSession` zählt bereits geöffnete Sessions. Während asynchroner Handshakes enthält die Manager-Map neue Prozesse noch nicht. Mehrere gleichzeitige Starts können deshalb dieselbe freie Kapazität sehen. Die `opening`-Menge verhindert nur den Doppelstart derselben Session. Idle-Sessions werden erst verdrängt, wenn Platz benötigt wird; eine Idle-Ablauffrist und eine echte LRU-Auswahl fehlen.

**Verbesserung:** Ein zentraler Scheduler reserviert Slots vor dem Spawn; gestartete und startende Prozesse zählen gemeinsam. Begrenzte Warteschlange, Slots in `finally` freigeben. Sparmodus mit einem aktiven Prozess und standardmäßig keinem dauerhaft warmen Idle-Prozess; ausgewogene Einstellung zunächst mit zwei Slots testen. Idle-Timeout z. B. 60–120 s, echte LRU-Reihenfolge, sichtbare Session bevorzugen. Laufende Turns und offene Freigaben nicht zur Speicheroptimierung abbrechen. Wiederaufnahme braucht zuvor F04.

**Windows-Lifecycle prüfen:** `terminate()` signalisiert nur den direkten Child-Prozess und wartet am Ende unbegrenzt auf `close`. Von Gemini gestartete Shell-/MCP-Kinder können zusätzliche Ressourcen halten. Mit realen Prozessbäumen testen; bei Bedarf Windows Job Objects oder einen eng auf eigene Prozesse begrenzten Tree-Cleanup und eine finale Deadline ergänzen. Das tatsächliche Auftreten verwaister Kinder wurde hier nicht gemessen.

**Abnahme:** Zehn gleichzeitige Startanforderungen überschreiten nie das konfigurierte Budget; Fehler geben Slots frei. Nach App-Ende und Abbruch bleiben keine app-eigenen Prozesse übrig.

### F07 – Jeder Stream-Schritt verarbeitet große Teile des Chatverlaufs erneut

**Belege:** `src/renderer/features/chat/Timeline.tsx:627`, `src/renderer/components/MarkdownContent.tsx:43`, `src/renderer/features/chat/reducer.ts:403`, `src/renderer/app/App.tsx:1639`.

Die Timeline rendert sämtliche Zeilen. Bei jedem geänderten `items`-Array werden Gruppen und eine vollständige `contentSignature` aufgebaut. Einzelzeilen sind nicht memoisiert; Markdown-Komponenten erhalten bei jedem Render neue Component-Funktionen. Geschlossene `<details>` verhindern das Rendern/Formatieren ihrer React-Kinder nicht. Der Reducer durchsucht und kopiert das gesamte Item-Array für einzelne Deltas. Ein Inline-Permission-Callback im Parent würde auch nachträglich hinzugefügte Memo-Grenzen durchbrechen.

**Verbesserung:**

- Variable Zeilenhöhen virtualisieren, mit Overscan und stabilem Scroll-Anker; Nachrichten, Toolgruppen und aufgeklappte Inhalte berücksichtigen.
- Abgeschlossene Zeilen mit stabilen Props memoisiert halten. Config für Markdown-Komponenten stabilisieren. Schwere Tool-Bodies erst beim Aufklappen erzeugen.
- Streaming-Text getrennt vom übrigen Layout aktualisieren; Markdown des aktiven Blocks höchstens z. B. alle 80–120 ms vollständig parsen. End-of-turn sofort korrekt finalisieren. Alternativ abgeschlossene Markdown-Blöcke cachen.
- Batchweise Reducer-Verarbeitung mit ID-Index und struktureller Wiederverwendung. Nicht bei jedem Delta alle bisherigen Texte erneut analysieren.
- Auto-Scroll nur bei aktivem „am Ende bleiben“; Layoutmessung und Scroll-Schreiben pro Frame bündeln. Permission-Karten bleiben sofort bedienbar.

**Abnahme:** 5.000 Nachrichten plus Tools, große Codeblöcke, 50–100 Deltas/s: Eingaben bleiben responsiv; abgeschlossene Markdown-Zeilen rendern nicht pro Delta neu. Virtualisierung muss Tastaturnavigation, Textauswahl und Suchen berücksichtigen; Export aus Datenmodell statt DOM erstellen.

### F08 – Pufferobergrenze und Persistenzfehler sind nicht sauber behandelt

**Belege:** `src/main/app-controller.ts:1294`, `src/main/storage/repositories/event-repository.ts:36`, `src/main/sessions/gemini-session-manager.ts:211`.

`appendBatch` verbietet mehr als 1.000 Events. Der 32-ms-Puffer besitzt keine entsprechende Anzahl-/Bytegrenze; nur das Zusammenführen benachbarter Deltas ist auf 100.000 Zeichen begrenzt. Ein schneller Replay-/Burst mit wechselnden IDs oder Eventtypen kann deshalb über die Repository-Grenze wachsen. Beim Flush wird der Puffer vor dem erfolgreichen Schreiben gelöscht. Ein Timerfehler bzw. abgefangener Subscriberfehler kann dann Daten verlieren. Fehler von `publishEvents` werden ebenfalls nicht gezielt behandelt.

**Verbesserung:** Begrenzung nach Zeit, Anzahl und UTF-8-Bytes; rechtzeitig flushen und höchstens 1.000 Events pro Transaktion schreiben. Puffer erst nach erfolgreichem Commit quittieren. Fehlerzustand sichtbar machen, begrenzt erneut versuchen, Reihenfolge und Sequenzen erhalten. IPC darf erst auf persistierte Events zeigen; bei Versandfehlern anhand der Sequenz erneut abonnieren. Für Disk-full/gesperrte Datenbank keinen endlosen RAM-Puffer anlegen.

**Abnahme:** 10.000 Burst-Events, alternierende Assistant-/Thought-Deltas, große UTF-8-Inhalte und simuliertes Schreibversagen: kein unbehandelter Fehler, kein stiller Verlust und begrenzter Speicher.

### F09 – Volltextsuche arbeitet auf Streaming-Fragmenten

**Beleg:** `src/main/storage/repositories/event-repository.ts:76`.

Die Suche führt `LIKE '%…%'` über JSON-Payloads aus und lädt alle Treffer synchron. Eine Phrase über zwei Deltas wird nicht gefunden. Bestätigt: separate Deltas `Hallo ` und `Welt` liefern für `Hallo Welt` keinen Treffer, für `Welt` dagegen schon. `%` und `_` in Nutzereingaben beeinflussen zusätzlich die SQL-Vorauswahl.

**Verbesserung:** Materialisierte Nachrichten als Suchbasis; SQLite FTS5 mit parametrisierter, sinnvoll normalisierter Anfrage und eigener Behandlung von Phrase-/Teilwortsuche. Index inkrementell aktualisieren, historische Daten in begrenzten Schritten migrieren. Treffer/Seiten begrenzen; Eingaben debouncen und veraltete Suchantworten verwerfen.

**Abnahme:** Phrasen über Delta-Grenzen, Unicode und Sonderzeichen; Suchlatenz bei 100.000 Nachrichten messen, ohne Streaming oder Freigaben zu blockieren.

### F10 – Git-Last entsteht unabhängig von sichtbaren Änderungen

**Belege:** `src/main/git/git-status-subscription-hub.ts:24`, `src/main/git/git-service.ts:78`, `src/main/git/git-service.ts:163`, `src/renderer/features/git/useGitProjectStatus.ts:41`, `src/renderer/app/App.tsx:750`.

Der Hub pollt alle vier Sekunden. Zusätzlich triggern Tool-Ende, Turn-Ende, Fokus und manuelle Aktionen weitere Abfragen. Das Hook-Abonnement hängt am aktiven Projekt, nicht an der Sichtbarkeit des Panels. Jeder Statuslauf entdeckt Repositories erneut und startet bis zu 10.000 Datei-Snapshot-Aufgaben über `Promise.all`. Der Polling-Schutz gilt nur pro Abonnement, nicht für alle Abfragewege.

**Verbesserung:** Gemeinsame laufende Abfrage pro Projekt/Root-Revision, Zusammenführung kurzer Refresh-Bursts, Repository-Discovery cachen und bei Root-/Worktree-Änderungen invalidieren. Dateimetadaten mit begrenzter Parallelität verarbeiten. Bei minimiertem Fenster pausieren; bei verborgenem Panel seltener prüfen, sofern ein Badge Aktualität benötigt. Nach Agenten-Dateiänderungen gezielt aktualisieren. Watcher nur begrenzt und mit Polling-Fallback einsetzen, insbesondere bei Netzlaufwerken.

**Abnahme:** Ein Burst von 50 Tool-Enden erzeugt höchstens einen laufenden Statusscan und einen zusammengefassten Folgescan. Auf 10.000 Änderungen keine unbeschränkte I/O-Konkurrenz; minimierter Idle-Betrieb erzeugt keine regelmäßigen Git-Prozessstarts.

### F11 – Fensterstart wartet auf CLI-Probes und historische Arbeit

**Belege:** `src/main/index.ts:112`, `src/main/index.ts:137`, `src/main/index.ts:280`, `src/main/storage/repositories/stats-repository.ts:97`, `src/renderer/app/App.tsx:1`.

Das Hauptfenster entsteht erst nach Capability-Probes und Service-Initialisierung. Gemini-Version und Hilfe werden nacheinander in separaten Prozessen abgefragt. Außerdem startet der Statistik-Konstruktor einen synchronen historischen Backfill, wenn die Metriktabelle leer ist. Im Renderer werden Statistik, GitLab/Jira, Debugdialog, Dateiviewer und andere optionale Oberflächen statisch importiert.

**Verbesserung:** Kleine App-Shell nach notwendiger DB-/IPC-Initialisierung zeigen, Capability-Prüfung danach mit Ladezustand durchführen. Probe-Ergebnisse anhand kanonischem Binary-/Paketpfad, Version/mtime und begrenzter Gültigkeit cachen; bei Auswahl oder Launchfehler invalidieren. Statistik-Backfill resumierbar mit Fortschrittsmarke in den Hintergrund verschieben. Optionale Panels über `React.lazy`/dynamische Imports aufteilen und erst bei Bedarf aktivieren.

**Abnahme:** Die Projektoberfläche wird auch bei langsamer oder fehlender CLI früh bedienbar. Build-Bericht enthält getrennte optionale Chunks; erster Chatstart lädt nicht bereits sämtliche Statistik-/Integrationsoberflächen. Keine Änderung der Sicherheitsoptionen erforderlich.

### F12 – SQLite und JSON-Arbeit können den Main-Prozess blockieren

**Belege:** `src/main/storage/database.ts:29`, `src/main/storage/repositories/event-repository.ts:128`, `src/main/storage/repositories/stats-repository.ts:680`.

`better-sqlite3` arbeitet synchron im Main-Prozess. Jeder Event-Insert bereitet Statements erneut vor, ermittelt `MAX(seq)`, validiert und serialisiert. Suche und historischer Statistik-Backfill können größere Datenmengen synchron verarbeiten. WAL verhindert diese JavaScript-/SQL-Blockaden nicht; der konfigurierte Busy-Timeout kann sie bei einer Sperre verlängern.

**Verbesserung in Stufen:** Erst Hot Statements wiederverwenden, Batch-Sequenzen innerhalb der Transaktion einmal reservieren und passende Indizes mit `EXPLAIN QUERY PLAN` prüfen. Dann materialisierte Timeline/Suchdaten und begrenzte Reads ergänzen. Bei gemessenen Blockaden einen dedizierten Storage-Worker/-Utility-Prozess als einzigen Writer einsetzen; ein `async`-Wrapper um synchrone SQL-Arbeit reicht nicht. Worker-Queue, Crashverhalten, Transaktionsgrenzen und Native-ABI mitdenken.

**Abnahme:** Große Suche/Statistik parallel zu Streaming: Main-Eventloop-Latenz bleibt innerhalb des vereinbarten Budgets; Daten bleiben nach erzwungenem Ende konsistent. SQL-Statements und Schema nur mit dokumentierter Migration ändern.

### F13 – Dateiindex, Viewer und PDF-Arbeit weiter begrenzen

**Belege:** `src/main/project-files/project-file-service.ts:34`, `src/main/project-files/project-file-service.ts:509`, `src/renderer/features/explorer/FileViewer.tsx:86`, `src/main/context-attachments/text-extractor.ts:88`, `src/main/context-attachments/extraction-worker.ts:104`.

Der Dateiindex kann nach 30 s bei der nächsten Anfrage neu aufgebaut werden. Sein Cache hat keine globale LRU-/Speichergrenze; 50.000 Dateien sind pro Index erlaubt, die Verzeichnisanzahl wird nicht separat begrenzt. Der FileViewer hebt den gesamten geladenen Text hervor und rendert alle Zeilen. Pro Extraktionsauftrag startet ein Utility-Prozess neu. PDFs werden bis 200 Seiten verarbeitet, auch wenn die gespeicherten 60.000 Zeichen bereits erreicht sind. `ContextTextExtractor.dispose()` stoppt die Queue, hält aber keinen Handle zum aktiven Worker vor.

**Verbesserung:** Speicherbudget und LRU für Indizes, getrenntes Verzeichnis-/Zeitbudget, schrittweises Nachladen und gezielte Invalidierung. Für reine Baumansicht nicht zwangsläufig einen kompletten Suchindex aufbauen. Große Dateien zeilenweise virtualisieren, Syntaxanalyse bei Bedarf in Worker verschieben. Extraktionsprozess kontrolliert wiederverwenden, nach Idle beenden, während Shutdown abbrechen. Im Sparmodus PDF-Extraktion nach Textbudget beenden und Anzahl/Trunkierung ausdrücklich als partiell markieren; wenn eine vollständige Zeichenstatistik benötigt wird, diese separat berechnen.

**Abnahme:** Mehrere große Projekte, viele leere Verzeichnisse, große Textdatei und 200-Seiten-PDF auf begrenztem RAM; Index-/Worker-Speicher fällt nach Idle wieder ab. Vorhandene Pfad-/Symlink-Prüfungen bleiben bestehen.

### F14 – Debug-Logging und aufwendige Effekte verursachen vermeidbare Dauerlast

**Belege:** `src/renderer/features/debug/debug-logger.ts:50`, `src/renderer/app/App.tsx:710`, `src/renderer/styles/app.css:1832` und `:4814`.

Der Logger speichert bis zu 1.000 vollständige Detailobjekte. Tool-Ausgaben können groß sein und werden so auch nach einem Session-Wechsel weiter referenziert. `notify()` kopiert das Logarray selbst dann, wenn kein Listener vorhanden ist. Zahlreiche Oberflächen verwenden Blur/Sättigung und Animationen; eine Reduced-Motion-Regel existiert bereits, ein allgemeines Ressourcenprofil fehlt.

**Verbesserung:** Ringpuffer mit Bytebudget, standardmäßig kurze redigierte Metadaten, ausführliche Payloads nur im aktivierten Diagnosemodus. Ohne Listener kein Snapshot-Copy; sichtbaren Logdialog gebündelt aktualisieren. Sparmodus mit opaken Flächen, weniger Blur/Schatten und pausierten dekorativen Animationen im Hintergrund. Hardwarebeschleunigung zunächst beibehalten; Abschalten nur für nachgewiesene Treiberprobleme als Diagnoseoption.

**Abnahme:** Große Tool-Ausgaben verbleiben nicht unbegrenzt im Debug-RAM. Idle-CPU und GPU-Last mit/ohne Effekte auf integrierter Windows-Grafik vergleichen.

### F15 – Veraltete Antworten können neuere Auswahl überschreiben

**Belege:** `src/renderer/features/git/useGitProjectStatus.ts:41`, `src/renderer/features/stats/useAppStats.ts:22`, `src/main/capability-service.ts:21`.

Ein manueller Git-Refresh schreibt sein Ergebnis ohne Generation-/Projektprüfung zurück. Beim schnellen Projektwechsel kann die alte Antwort später eintreffen. Statistikabfragen besitzen dasselbe Muster bei wechselnden Filtern. `GeminiCapabilityService.refresh()` teilt außerdem ein einziges laufendes Promise unabhängig von den übergebenen Binary-Kandidaten; eine neue Auswahl kann damit das Ergebnis eines älteren Probes erhalten.

**Verbesserung:** Ergebnisübernahme an Request-Generation und stabile Eingabe-ID binden, unterstützte Arbeiten abbrechen. Probe-Deduplizierung anhand der konkreten Kandidaten statt global durchführen; Auswahländerungen serialisieren bzw. die neueste Auswahl erneut prüfen.

**Abnahme:** A langsam, B schnell: B bleibt im UI und als gespeicherte Binary ausgewählt, auch wenn A zuletzt antwortet.

## 5. Zusätzliche ACP-Umsetzung im bestehenden Datenfluss

`event-normalizer.ts` erkennt bereits `plan`, Config- und Session-Info-Updates. `app-controller.ts:1550` verwirft diese im Shared-Pfad; Mode-Updates ändern zwar den DB-Eintrag, werden aber nicht als entsprechendes Live-UI-Event übertragen. `commands.updated` erreicht die Timeline-Daten, wird in `reducer.ts:630` jedoch ignoriert. Neue Normalizer-Cases allein reichen daher nicht.

Für jede Erweiterung den vollständigen Weg implementieren:

1. Capability/Request und Agent-Notification im ACP-Adapter.
2. Normalisiertes, versioniertes internes Datenmodell.
3. Shared-Schema, Persistenz und migrationsfähiges Replay.
4. Preload-/IPC-Vertrag und Session-State.
5. UI mit Capability-Fallback, Fehler-/Abbruchpfad und Replay-Test.

Für Pläne bestehende Plan-Normalisierung mit einer separaten Planansicht verbinden. Slash-Command-Vorschläge aus den aktuellen Agentdaten erzeugen; Eingabehinweise erhalten. Quellen: [Agent Plan](https://agentclientprotocol.com/protocol/v1/agent-plan), [Slash Commands](https://agentclientprotocol.com/protocol/v1/slash-commands).

Die vorhandene `session/cancel`-Implementierung einschließlich Abbruch offener Permissions beibehalten. Die finale Wartephase auf Prozessende zusätzlich begrenzen und Netzwerk-/Permission-/Tool-Wartefälle getrennt testen. Quelle: [ACP Cancellation](https://agentclientprotocol.com/protocol/v1/cancellation).

Den großen `AppController` anschließend entlang dieser Verantwortlichkeiten zerlegen: Session-Lifecycle, Eventpersistenz, Konfiguration, Recovery und Metriken. Im Renderer Chat-State und Streaming von Projekt-/Panel-/Dialogzustand trennen. Entscheidend sind klare Verantwortlichkeiten und kleinere Updatebereiche, nicht allein kleinere Dateien.

## 6. Messplan für schwächere Windows-Rechner

### Referenz und Messmethodik

Als Referenz zunächst Windows 11 x64 auf einem älteren 2-Kern-/4-Thread-Rechner mit 8 GB RAM, integrierter Grafik und SSD festlegen; zusätzlich 4-GB-/HDD- oder vergleichbar eingeschränkte Umgebung als Stresstest. Windows 10 separat als Best-Effort prüfen, wie im README vorgesehen. Gepackte Release-Builds verwenden, DevTools geschlossen halten; Antivirus, DPI-Skalierung, Energieprofil und CLI-Version protokollieren. CPU-Drosselung auf dem Entwicklungs-Mac ersetzt diese Messung nicht.

Vor und nach jeder Optimierungsgruppe dieselben Daten und mindestens zehn Wiederholungen verwenden. Kalt-/Warmstart getrennt messen, Median und p95 berichten. Lokale UI-/IPC-Zeit von CLI-Start und Modell-/Netzwerklatenz trennen.

| Messgröße | Vorgeschlagenes Ziel, noch nicht gemessen |
| --- | --- |
| Sichtbare und bedienbare App-Shell | Warmstart < 1,5 s, Kaltstart < 3 s auf Referenzhardware |
| Eingabelatenz während Stream/Replay | p95 < 50 ms, keine wiederkehrenden UI-Tasks > 50 ms |
| Main-Eventloop-Verzögerung | p95 < 20 ms unter repräsentativer Last |
| CPU ohne aktiven Turn | Im Mittel < 1 % der gesamten Maschinenkapazität über 60 s; Messkonvention dokumentieren |
| Minimierte App ohne aktive Arbeit | Keine periodischen Git-Scans oder laufenden dekorativen Animationen |
| Electron-Speicher ohne CLI/Preview | Zielwert ≤ 300 MB summierter Private Working Set; nach erster Baseline validieren |
| Speicher inklusive Gemini/MCP | Separat nach Prozessbaum erfassen; keine unbelegte fixe RAM-Zusage für fremde Prozesse |
| Lange Sessions | 50.000 Events vollständig; DOM durch Virtualisierung begrenzt |
| Lifecycle | Kein monotones Wachstum nach 100 Preview-Zyklen / 1.000 Session-Wechseln |
| Vergleich zur Baseline | Mindestens 30 % weniger p95-Interaktionslatenz in belasteten Szenarien anstreben; tatsächlichen Gewinn messen |

Die absoluten Ziele sind zunächst Abnahmekandidaten, keine zugesicherte Leistung. Electron und Gemini getrennt optimieren: Eine UI-Änderung kann den eigenen Renderer entlasten, aber nicht die Modellantwortzeit garantieren.

### Szenarien und Instrumentierung

- Leeres Profil, bestehendes Profil mit vielen Sessions und erster Start mit Statistik-Backfill.
- 50.000 Events, 5.000 Nachrichten, große Markdown-/Tool-Blöcke; parallel tippen, scrollen, Session wechseln und Permissions beantworten.
- 1/2/3 Gemini-Prozesse, langsamer Handshake, Sleep/Resume, Netzwerkfehler, Abbruch, Fenster minimieren und App beenden.
- 10.000 Git-Änderungen, sechs Roots, langsames Netzlaufwerk und Root-Änderung während laufender Hintergrundabfragen.
- Datei- und Linkanhänge, wiederholte Vorschauen, PDF-Batches und aktiver/geschlossener Debugdialog.

Instrumentierung: Electron `app.getAppMetrics`, Windows-Prozessbaum/Private Working Set, Node `monitorEventLoopDelay`, React Profiler in gesonderten Diagnose-Builds, Chromium Performance/Tracing sowie Zähler für IPC-Batches/-Bytes, DB-Flushzeiten und Git-Spawns. Diagnostik ohne vollständige Prompts, Tool-Ausgaben oder Tokens speichern. Elektrons eigene Empfehlungen stützen insbesondere Profiling, verzögertes Laden und das Vermeiden blockierender Main-/Renderer-Arbeit. Quelle: [Electron Performance](https://www.electronjs.org/docs/latest/tutorial/performance).

## 7. Tests und Lieferreihenfolge

### Stufe 1 – Korrektheit und Ressourcenlecks

F01–F05 und F08 beheben. Permanente Regressionstests für 1.001+ Events, Replay/Live-Überlappung, Chunk-übergreifende Suche, Subscription-Cleanup, View-Cleanup, unterschiedliche Message-IDs und partielle Tool-Updates ergänzen. Datenverlust-/Wiederverbindungsfälle haben Vorrang vor kosmetischen Optimierungen.

### Stufe 2 – Windows-Sparmodus und flüssige UI

F06, F07 und F10 implementieren. Prozessbudget und Idle-Lifecycle mit Timeline-Virtualisierung und weniger Git-Abfragen kombinieren. Diese Maßnahmen versprechen nach der Codeanalyse den größten Nutzen für schwache Rechner; der Messplan entscheidet über die tatsächliche Reihenfolge innerhalb dieser Stufe.

### Stufe 3 – Start, Speicher und Persistenz

F09 sowie F11–F15 umsetzen. Zunächst kleine messbare Verbesserungen, danach gegebenenfalls Storage-Worker. Index-/Blob-/Logbudgets explizit machen und Debug-/Preview-Lebenszyklen in E2E prüfen.

### Stufe 4 – Gemini 0.60/0.61 freigeben und ACP ausbauen

| Testziel | Pflichtumfang |
| --- | --- |
| Bisherige Mindestversion 0.56.0 | Baseline für Legacy-Modellwechsel, Load, Prompt, Cancel, Permissions |
| Gemini 0.60.0 | Gleiche Kernfälle, Windows-Pfade/Trust, Bilder und Multi-Root |
| Gemini 0.61.0 | Zusätzlich versionierte Modell-IDs; reale Capabilities als Fixture festhalten |
| 0.62 Preview/Nightly | Separater optionaler Kompatibilitätsjob, keine Stable-Zusage |
| Fake-Agent | Config-only-Modi, gruppierte/Boolean-Optionen, fehlende Capabilities, unbekannte optionale Felder, Pläne, Rückfragen, hohe Eventrate, Prozessabsturz |

Versionsgebundene CLI-Installationen in isolierten Testverzeichnissen verwenden; die globale Nutzerinstallation nicht für jeden Matrixlauf umstellen. Reale Modelltests benötigen bewusst eingerichtete Testauthentifizierung und ein begrenztes Testbudget. Authentifizierte Tests getrennt von gewöhnlichen Pull-Request-Jobs betreiben.

Der vorhandene reale Smoke-Test in `tests/smoke/real-gemini.test.ts` prüft nur Session-Erstellung und Multi-Root-Handshake. Er beweist weder Prompt-/Toolverhalten noch Wiederaufnahme oder 0.6x-Kompatibilität. Die Windows-CI in `.github/workflows/windows.yml` führt Typecheck, Unit-Tests und Packaging aus, aber keinen Electron-E2E-Test. Der vorhandene E2E-Test prüft im Wesentlichen Start und Renderer-Isolation; erweitern um lange Verläufe, IPC-Replay, Ressourcen-Cleanup und Windows-Prozessende.

Zum Abschluss README und Diagnoseseite mit **konkret getesteten CLI-Versionen**, Funktionsmatrix und getrennten Aussagen für Stable/Preview aktualisieren. Erst dann die Unterstützung von 0.60/0.61 als verifiziert ausweisen.
