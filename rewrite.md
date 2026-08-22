# GeminUI — Migrationsplan: Electron/React → Tauri 2 + Rust + SolidJS

**Status:** Beschlossen. Dieses Dokument ist der Umsetzungsplan, keine Entscheidungsvorlage mehr.

**Zielbild:** GeminUI läuft als Tauri-2-Anwendung mit Rust-Backend und SolidJS-Frontend. **Look and Feel sowie Funktionsumfang bleiben 1:1 identisch.**

**Rahmenbedingungen, die den Plan vereinfachen:**

* **Keine Datenmigration.** Die App hat keine Nutzerbasis. Die SQLite-Datenbank wird neu aufgebaut, die elf bestehenden Migrationsschritte werden zu **einem konsolidierten Schema v1** zusammengefasst. Kein Kompatibilitätsballast.
* **Keine Token-Übernahme.** GitLab-Verbindungen werden neu eingerichtet. Der in Electron über `safeStorage` verschlüsselte Bestand muss nicht übersetzt werden.
* **Kein Parallelbetrieb.** Es gibt keine Übergangsphase, in der beide Versionen gepflegt werden müssen.

Damit entfallen die drei aufwendigsten Posten eines typischen Rewrites. Was bleibt, ist ehrliche Portierungsarbeit.

---

## 1. Funktionsumfang: was portiert werden muss

Diese Liste ist der Vertrag. Sie ist gleichzeitig die Grundlage der Abnahme in Abschnitt 12 — was hier steht, muss in der Tauri-Fassung nachweisbar genauso funktionieren. Die Spalte **Portierungsaufwand** schätzt, wie viel echte Denkarbeit hinter der Übersetzung steckt: *mechanisch* heißt Zeile für Zeile, *Logik* heißt eigenständige Rust-/Solid-Umsetzung, *Risiko* heißt: dafür gibt es keine direkte Entsprechung.

### 1.1 Projekte und Ordner

| Funktion | Heute | Portierungsaufwand |
| :--- | :--- | :--- |
| Projekt mit genau einem unveränderlichen Primary Root | `projects/project-service.ts`, `root-resolver.ts` | Logik |
| Bis zu fünf Additional Roots, jederzeit änderbar | `root_revision` + SHA-256-Fingerprint über den Root-Satz | Logik |
| Root-Änderung blockiert, solange ein Turn läuft | `assertProjectIdle` | Logik |
| Reautorisierung einzelner Roots nach macOS-Neustart | `projects:reauthorize-root` | Logik + plattformspezifisch |
| Freigabe-Policy pro Projekt (Gemini-Approval-Mode) | inkl. Bestätigungspflicht bei „Alles erlauben" | Logik |
| Anlegen, Umbenennen, Archivieren, Löschen | | mechanisch |
| Nativer Ordner-Picker (Mehrfachauswahl, max. 6) | `dialog.showOpenDialog` | → `tauri-plugin-dialog` |

### 1.2 Sessions

| Funktion | Heute | Portierungsaufwand |
| :--- | :--- | :--- |
| Mehrere persistente Sessions pro Projekt | SQLite, überleben Neustart | mechanisch |
| Genau ein `gemini --acp`-Kindprozess pro aktiver Session, **maximal drei gleichzeitig** | `#makeRoomForSession` verdrängt eine inaktive; ist keine inaktiv, wird die vierte abgelehnt statt eine laufende Anfrage zu stoppen | Logik |
| Session-Recovery über `session/load` mit dem aktuellen Root-Satz | `getSessionReconnectState` | Logik |
| Reconnect-Dialog: komprimierte Historie oder frischer Start | `#buildCompressedHistory` | Logik |
| Modell- und Modus-Wechsel zur Laufzeit | mit gecachten Listen und Fallback-Listen im Header | Logik |
| Pinnen, Archivieren, Umbenennen, Löschen | | mechanisch |
| Suche über Titel **und** optional Volltext im Verlauf | `events.searchByContent` | Logik |
| Automatischer Titel aus dem ersten Prompt | `generateSessionTitleFromPrompt` (shared) | mechanisch |

### 1.3 Chat, Timeline und Streaming

| Funktion | Heute | Portierungsaufwand |
| :--- | :--- | :--- |
| Streaming von Assistant-Text und Gedanken | `message.assistant.delta`, `message.thought.delta` | Logik |
| Werkzeugkarten mit Lebenszyklus | `tool.started/updated/completed/failed` | mechanisch (Reducer bleibt) |
| ACP-Freigaben mit exakten Optionen, Antwort zurück in den Prozess | `permission-broker.ts` | Logik (oneshot-Kanäle) |
| Semantischer Abbruch, danach kontrollierter Prozess-Fallback | `session/cancel` | Logik |
| **Ereignis-Pufferung: 32-ms-Fenster, Verschmelzen aufeinanderfolgender Deltas bis 100.000 Zeichen** | `#queueEvent` / `#flushBufferedEvents` | Logik — **darf nicht verlorengehen** |
| Persistente Timeline mit sequenziertem Replay nach Reload | `events`-Tabelle, `afterSeq` | Logik |
| Markdown ohne Raw HTML, Links nur als validiertes `https:` extern | `react-markdown` + `skipHtml` | → `markdown-it`, siehe 8.5 |
| Plan-Modus: erkennen, dass ein Plan auf Antwort wartet | `hasPendingPlan` in `App.tsx` | mechanisch |
| Inline-Diff-Vorschauen direkt an der Werkzeugkarte | `useGitChangePreviews` mit Status-Baseline pro `toolCallId` | Logik |
| Token- und Kontextanzeige mit Detail-Popover | fünf Quellen (`acp_prompt_usage`, `gemini_meta_quota`, …), Teilabdeckung wird als „≥" gekennzeichnet | Logik |

### 1.4 Composer

| Funktion | Heute | Portierungsaufwand |
| :--- | :--- | :--- |
| `@`-Mentions auf Projektdateien mit Live-Suche | `project-files/`, max. 10 Treffer | Logik |
| Bilder per Picker, Drag & Drop und Einfügen | PNG/JPEG/WebP/GIF, max. 4 pro Prompt, 10 MB je Bild | **Risiko** — siehe 8.6 |
| Externe Kontexte als Chips (GitLab-Review-Snapshots) | `external-prompt-context-registry.ts` | Logik |
| Entwurfsübernahme aus Todos und GitLab | `handToComposer` | mechanisch |

### 1.5 Kontext-Anhänge

| Funktion | Heute | Portierungsaufwand |
| :--- | :--- | :--- |
| Projekt- und Session-Ebene, Ein-/Ausschluss pro Session | drei Tabellen + Auswahltabelle | Logik |
| Dateien bis 50 MB, dedupliziert über SHA-256 | `blob-store.ts` | Logik |
| Mime-Sniffing über 25 Typen (Code, Text, CSV, JSON, YAML, …) | `mime-sniffer.ts` | mechanisch |
| **Textextraktion aus PDF** | `pdfjs-dist` in einem separaten `utilityProcess` | **Risiko** — siehe 4.1 |
| Textextraktion aus Klartext- und Codedateien | `text-extractor.ts` | mechanisch |
| Tokenschätzung und Budget | 60.000 Zeichen je Anhang, 240.000 gesamt, max. 20 pro Prompt | mechanisch |
| Links mit OpenGraph-Metadaten und Vorschaubild | `link-metadata-fetcher.ts`, `html-metadata-parser.ts` | Logik |
| **Live-Vorschau der Linkziele mit eigener, persistenter Sitzung** | Electron-`BrowserView` | **Risiko** — siehe 9 |
| „Angemeldete Sitzungen löschen" | `link-preview:clear-storage` | Logik |
| Herkunftsunterscheidung `manual` / `chat` | | mechanisch |

### 1.6 Todos

| Funktion | Heute | Portierungsaufwand |
| :--- | :--- | :--- |
| Projekt-Todos mit Titel, Beschreibung, Reihenfolge, Erledigt-Status | `todos/todo-service.ts` | mechanisch |
| Anhänge am Todo — Verweise auf Projekt-Kontextanhänge, nicht Kopien | `todo_attachment_links` | Logik |
| Dateien und Links direkt am Todo hinzufügen | | mechanisch |
| „An aktive Session senden" / „An neue Session senden" | erzeugt Prompt-Entwurf **und** wählt die Anhänge für die Session vor | Logik |
| Push bei Änderungen | `todos:changed` | Logik |

### 1.7 Git

| Funktion | Heute | Portierungsaufwand |
| :--- | :--- | :--- |
| Repository-Erkennung in allen Roots, max. 6 | `repository-discovery.ts` | Logik |
| Statusabfrage über `git status --porcelain=v2` | eigener Parser, 10.000 Änderungen | mechanisch (Parser 1:1) |
| Status-Push bei Änderungen | `git:project-status-changed` | Logik |
| Diff-Ansicht, staged und unstaged, bis 50.000 Zeilen | eigener Unified-Diff-Parser | mechanisch (Parser 1:1) |
| **Git-Binary in den Einstellungen wählbar** | `settings:choose-git-binary` | Logik — bestimmt die Technologiewahl, siehe 4 |

### 1.8 GitLab

| Funktion | Heute | Portierungsaufwand |
| :--- | :--- | :--- |
| Verbindungen anlegen und testen (Instanz-URL + Personal Access Token) | `gitlab-api-client.ts` | Logik |
| Token verschlüsselt ablegen, ersetzen, Verbindung entfernen | `safeStorage` → DB-Blob | → `keyring` + `aes-gcm` |
| Selbstsignierte TLS-Zertifikate optional zulassen | `allow_self_signed_tls` | Logik |
| Repository-Bindings pro Projekt: lokales Remote → GitLab-Projekt | `remote-url-parser.ts`, `repository-binding-resolver.ts` | Logik |
| Merge Requests auflisten, auswählen, per URL verbinden | `merge-request-resolver.ts` | Logik |
| Review-State mit Diskussionen, Push bei Änderungen | `gitlab-subscription-hub.ts` | Logik |
| Thread beantworten und auflösen | | mechanisch |
| Review-Kontext an Gemini übergeben — betroffene Zeilen, ganze Datei oder nur Kommentar | `review-context-builder.ts`, Snapshot-Store mit Ablauf | Logik |

### 1.9 Jira

| Funktion | Heute | Portierungsaufwand |
| :--- | :--- | :--- |
| Global gespeicherte Konfigurationen (Name, Base URL, Issue-Prefixe) | `jira_configs`, projektübergreifend vorgeschlagen | mechanisch |
| Pro Projekt genau eine aktive Konfiguration | `jira_project_integrations`, `project_id` als Primärschlüssel | mechanisch |
| Issue-Key im Session-Titel erkennen, erster Treffer gewinnt | `matchJiraIssueKey` (reine Funktion, shared) | mechanisch — 1:1 nach Rust **und** TS |
| Symbol in der rechten Leiste, nur bei Treffer | `App.tsx` | mechanisch |
| Vollflächige Webview auf das Issue | teilt sich die Vorschau-Webview mit 1.5 | **Risiko** — siehe 9 |
| Issue automatisch als Session-Link-Anhang | dedupliziert über die normalisierte URL | mechanisch |

### 1.10 Skills, MCP, Updates, Einstellungen

| Funktion | Heute | Portierungsaufwand |
| :--- | :--- | :--- |
| Skills-Scanner über die Gemini-Konfigurationspfade | max. 500 Skills, 48 Suchpfade | Logik |
| MCP-Server-Scanner | max. 200 Server | Logik |
| Update-Prüfung gegen GitHub Releases | `updates/app-update-service.ts` | → `tauri-plugin-updater`, siehe 11 |
| Update herunterladen mit Fortschritt und installieren | eigener Downloader | → Plugin |
| Gemini-Binary wählen und prüfen | Version, `--acp`, Bilder, Modi, Modelle, max. Roots | Logik + plattformspezifisch |
| Git-Binary wählen und prüfen | | Logik |

### 1.11 Querschnitt

| Funktion | Heute | Portierungsaufwand |
| :--- | :--- | :--- |
| **Idempotenz jeder schreibenden Aktion** über `clientRequestId` | `client_requests`-Tabelle, reserve/save/removePending | Logik — **darf nicht verlorengehen** |
| Validierung von **Ein- und Ausgabe** jedes IPC-Aufrufs | Zod, `registerValidatedIpcHandler` | siehe 10 |
| Sender-Verifikation jedes IPC-Aufrufs | `security/ipc-guard.ts` | → Tauri-Capabilities |
| Sieben rechte Panels über eine Icon-Leiste, zwei davon bedingt | `PanelRail`, Breite persistiert | mechanisch |
| Panelbreite ziehbar, Zustand über Neustarts | `localStorage` | mechanisch |

---

## 2. Bestandsaufnahme in Zahlen

Gemessener Stand der Codebase, **22.08.2026** (nach Aufnahme von Todos und Jira):

| Bereich | Umfang | Anmerkung |
| :--- | ---: | :--- |
| `src/main` (Backend) | **18.101 LOC**, 92 Dateien | vollständig nach Rust |
| `src/shared/contracts` (Zod) | **3.538 LOC**, 15 Dateien | nach Rust-Typen + Serde |
| `src/preload` | 486 LOC | entfällt ersatzlos (Tauri braucht keine Bridge) |
| `src/renderer` (Frontend) | **11.656 LOC**, 34 `.tsx` + 12 `.ts` | nach SolidJS |
| davon `styles/app.css` | **2.262 Zeilen** | **wird 1:1 übernommen, keine Änderung** |
| `tests` | 6.216 LOC, 22 Dateien | teils portieren, teils als Golden-Files weiternutzen |
| IPC-Oberfläche | **102 Kanäle** | 96 Request/Response-Paare + 6 Push-Kanäle |
| Datenbanktabellen | **20** (+ `schema_migrations`) | 13 Indizes, 11 Migrationsschritte → konsolidiertes Schema v1 |
| Repositories | 11 | |

Zum Vergleich: die vorige Fassung dieses Dokuments zählte 16.327 LOC Backend, 78 Kanäle und 17 Tabellen. Der Zuwachs kommt fast vollständig aus Todos, Jira und dem Update-Downloader — der Plan bleibt derselbe, die Schätzungen in Abschnitt 11 sind entsprechend angehoben.

### Backend-Module nach Größe

```
3.453  storage/              SQLite, 11 Migrationen, 11 Repositories
2.611  integrations/         GitLab (≈2.290), Jira (≈200), Registry + externer Prompt-Kontext (≈120)
2.131  gemini/               ACP: Subprozess, JSON-RPC, Event-Normalizer, Capabilities, Usage
1.646  git/                  porcelain-v2-Parser, Unified-Diff-Parser, Discovery, Status-Hub
1.351  app-controller.ts     Orchestrierung, Ereignispuffer, Idempotenz, Historie
1.194  context-attachments/  Blob-Store, Mime-Sniffing, Extraktion, Worker, Prompt-Aufbau
1.148  ipc/                  Handler-Registrierung, Validierung, Event-Hub
  555  projects/             Roots, Freigabe-Policies, Reautorisierung
  525  agent-extensions/     Skills- und MCP-Scanner
  475  processes/            Prozessverwaltung, NDJSON-Guard, Binary-Auflösung
  456  project-files/        @-Mention-Suche
  435  links/                Link-Metadaten, Live-Vorschau (BrowserView), URL-Policy
  424  updates/              GitHub-Releases: Prüfung, Download, Installation
  315  security/             IPC-Guard, Fensterhärtung
  309  index.ts              Bootstrap und Verdrahtung
  289  todos/                Todos, Anhangsverknüpfung, Prompt-Entwurf
  262  attachments/          Bild-Staging für Prompts
  223  sessions/             Session-Manager
  154  usage/                Token-Aggregation
  145  capability-service.ts Gemini- und Git-Fähigkeitserkennung
```

### Frontend-Dateien nach Größe

```
1.467  app/App.tsx                             Zustandszentrale, Panel-Routing
  692  features/attachments/Composer.tsx       Prompt-Eingabe, @-Mentions, Drag&Drop
  617  features/chat/Timeline.tsx              Verlauf, Werkzeuggruppen, Freigaben
  580  features/chat/reducer.ts                Timeline-Reducer (reine Funktion)
  532  features/projects/ProjectSettingsDialog.tsx
  519  features/todos/TodosPanel.tsx
  500  features/chat/ChatHeader.tsx            Kopfzeile, Token-Popover
  446  features/attachments/AttachmentsPanel.tsx
  418  features/sessions/Sidebar.tsx
  416  features/jira/JiraSettings.tsx
  353  components/Icon.tsx                     reine SVG-Sammlung
  339  features/gitlab/GitLabPanel.tsx
  318  features/updates/AppInfoUpdatePopover.tsx
  312  features/gitlab/GitLabSetupDialog.tsx
  272  features/gitlab/useGitLabReview.ts
  261  features/gitlab/GitLabDiscussionCard.tsx
  231  features/git/ChangesPanel.tsx
  230  features/mcp/McpPanel.tsx
  223  features/git/DiffViewer.tsx
  ...  27 weitere Dateien
```

---

## 3. Zielarchitektur

```
gem-ui/
├── src/
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── capabilities/
│   │   ├── main.json               # Rechte des Hauptfensters
│   │   └── preview.json            # eng begrenzte Rechte der Live-Vorschau
│   ├── migrations/
│   │   └── 001_initial.sql         # konsolidiertes Schema (ersetzt Migration 1–11)
│   └── src/
│       ├── main.rs                 # Tauri-Builder, State-Registrierung, Setup
│       ├── error.rs                # AppError (thiserror) + Serde-Serialisierung
│       ├── state.rs                # AppState: Pools, Manager, Broker, Hubs
│       ├── acp/
│       │   ├── process.rs          # Subprozess-Spawn, stdio, NDJSON-Guard
│       │   ├── rpc.rs              # JSON-RPC-Rahmen, Request/Response-Korrelation
│       │   ├── normalize.rs        # Rohereignisse → NormalizedAgentEvent
│       │   ├── permission.rs       # Permission-Broker (oneshot-Kanäle)
│       │   ├── session.rs          # Lebenszyklus, Resume, komprimierte Historie
│       │   ├── usage.rs            # Tokenzählung aus fünf Quellen
│       │   └── capabilities.rs     # Fähigkeitserkennung, Binary-Auflösung
│       ├── controller.rs           # Gegenstück zu app-controller.ts: Puffer, Idempotenz
│       ├── db/
│       │   ├── mod.rs              # Pool, WAL-Setup, Migrationslauf
│       │   └── repo/               # projects, sessions, events, attachments,
│       │                           # context_attachments, todos, gitlab, jira,
│       │                           # settings, usage, client_requests
│       ├── git/
│       │   ├── runner.rs           # CLI-Aufrufe (konfigurierbares Binary!)
│       │   ├── discovery.rs        # Repository-Erkennung in den Roots
│       │   ├── status.rs           # porcelain-v2-Parser
│       │   └── diff.rs             # Unified-Diff → strukturierte Zeilen
│       ├── gitlab/
│       │   ├── client.rs           # REST (reqwest)
│       │   ├── schema.rs           # tolerante Deserialisierung
│       │   ├── vault.rs            # keyring + aes-gcm
│       │   ├── discussions.rs      # Mapper
│       │   └── review.rs           # Review-State, Kontextaufbau, Snapshot-Store
│       ├── jira/
│       │   └── mod.rs              # Konfigurationen, Aktivierung, Issue-Key, Anhang
│       ├── attachments/
│       │   ├── blobs.rs            # Blob-Store auf Platte
│       │   ├── mime.rs             # Mime-Sniffing
│       │   ├── extract/            # PDF, Klartext, Code
│       │   └── opengraph.rs        # Link-Metadaten
│       ├── todos/                  # Todos, Anhangsverknüpfung, Prompt-Entwurf
│       ├── project_files/          # @-Mention-Suche
│       ├── extensions/             # Skills- und MCP-Scanner
│       ├── links/
│       │   └── preview.rs          # Multi-Webview-Steuerung
│       ├── projects/               # Roots, Fingerprint, Freigabe-Policies
│       └── commands/               # #[tauri::command]-Endpunkte, nach Domäne
├── src/                            # SolidJS-Frontend
│   ├── app/
│   ├── features/                   # gleiche Ordnerstruktur wie heute
│   ├── components/
│   ├── ipc/                        # typisierte invoke-/Channel-Wrapper
│   ├── types/bindings.ts           # aus Rust generiert, eingecheckt
│   └── styles/app.css              # UNVERÄNDERT übernommen
└── package.json
```

**Leitprinzip:** Die Ordnerstruktur des Frontends bleibt identisch zu heute. Wer die Electron-Version kennt, findet sich sofort zurecht, und jede Portierung ist ein Eins-zu-eins-Vergleich zweier Dateien.

Zwei Abweichungen zur heutigen Backend-Struktur sind bewusst:

* `app-controller.ts` wird zu `controller.rs` **plus** den Modulen, in die seine Zuständigkeiten eigentlich gehören. Die 1.351 Zeilen enthalten heute vier Themen (Sessionorchestrierung, Ereignispuffer, Tokenerfassung, komprimierte Historie); in Rust werden Ereignispuffer und Tokenerfassung eigene Dateien.
* `security/ipc-guard.ts` und `src/preload/` haben kein Gegenstück — sie werden durch das Capability-System ersetzt (Abschnitt 10).

---

## 4. Technologie-Entscheidungen

| Aufgabe | Heute | Neu | Begründung |
| :--- | :--- | :--- | :--- |
| Shell | Electron 43 | **Tauri 2** | gesetzt |
| Async-Laufzeit | libuv | **Tokio** (über `tauri::async_runtime`) | Tauri bringt es mit |
| Subprozess | `child_process` | **`tokio::process::Command`** | zeilenweises Lesen über `BufReader::lines()` |
| JSON-RPC | `@agentclientprotocol/sdk` | **`agent-client-protocol` (Crate) prüfen**, sonst eigener Client | *Erste Aufgabe in Meilenstein 2: Eignung des Crates verifizieren.* Fällt es aus, ist der Client mit `serde_json` in ~600 Zeilen selbst gebaut |
| Datenbank | `better-sqlite3` | **`rusqlite`** mit `bundled` | SQLite ist synchron; `rusqlite` hinter `spawn_blocking` ist schlanker und schneller als `sqlx` für lokale Desktop-Zugriffe. `bundled` vermeidet Systemabhängigkeiten. WAL aktivieren, ein Schreiber, Lese-Pool |
| Migrationen | eigenes Framework | **`rusqlite_migration`** oder 30 Zeilen selbst | Bei einem einzigen Startschema kaum relevant — aber von Beginn an vorsehen |
| Git | Git-CLI + Parser | **Git-CLI + portierter Parser** | **Nicht `git2`.** Die App bietet „Git-Binary wählen" als Einstellung an (`settings:choose-git-binary`); libgit2 würde diese Funktion bedeutungslos machen und bei Worktrees, Sparse-Checkout und `.gitignore`-Feinheiten abweichen. Der Parser wird 1:1 portiert |
| Gemini-Binary | konfigurierbar | **unverändert konfigurierbar** | gleiches Argument; die Windows-Auflösung von `gemini.cmd` auf den JS-Einstiegspunkt wird mitportiert |
| HTTP | `fetch` | **`reqwest`** (`json`, `rustls-tls`) | `rustls` statt OpenSSL spart Systemabhängigkeiten. Für selbstsignierte GitLab-Instanzen: `danger_accept_invalid_certs` **nur** wenn die Verbindung es explizit gesetzt hat |
| Verschlüsselung | `safeStorage` | **`keyring` + `aes-gcm`** | Schlüssel im OS-Depot, Nutzdaten in der DB |
| HTML/OpenGraph | Regex | **`scraper`** | |
| PDF-Text | `pdfjs-dist` im `utilityProcess` | **`pdfium-render`** (Bibliothek mitliefern) | ⚠️ Siehe 4.1 — einziger Punkt mit Qualitätsrisiko |
| Validierung | Zod | **Serde + `garde`** | Siehe Abschnitt 10 |
| Fehler | Error-Klassen | **`thiserror`** im Backend, `anyhow` nur an den Rändern | |
| Frontend | React 19 | **SolidJS 1.9+** | gesetzt |
| Markdown | `react-markdown` + `remark-gfm` | **`markdown-it`** mit `html: false` | Siehe 8.5 |
| Build | Electron Forge + Vite | **`cargo tauri build`** + Vite (`vite-plugin-solid`) | |
| Tests | vitest, Testing Library, Playwright | **`cargo test`** + vitest + `@solidjs/testing-library` + Playwright | |

### 4.1 Der eine Punkt mit Qualitätsrisiko: PDF-Extraktion

`pdfjs-dist` ist die Referenzimplementierung für PDF-Textextraktion; die Rust-Alternativen sind schwächer. `pdf-extract` scheitert an vielen realen Dokumenten. **`pdfium-render`** bindet Googles PDFium und kommt qualitativ am nächsten, verlangt aber, dass die PDFium-Bibliothek pro Plattform mitgeliefert wird (~4 MB je Ziel).

**Entscheidung:** `pdfium-render` mit gebundelter Bibliothek. **Rückfallebene**, falls die Qualität in Meilenstein 6 nicht überzeugt: ein Node-Sidecar ausschließlich für die Extraktion (Tauri unterstützt Sidecar-Binaries nativ). Das wäre kein Rückschritt — heute läuft die Extraktion ohnehin in einem separaten `utilityProcess`.

Diese Entscheidung wird an einem Korpus echter PDFs gemessen, nicht am Gefühl.

---

## 5. IPC-Oberfläche: 102 Kanäle abbilden

Die Kanäle zerfallen in drei Klassen, die in Tauri drei verschiedene Werkzeuge bekommen:

### 5.1 Anfrage/Antwort → `#[tauri::command]`

96 der 102 Kanäle sind klassisches Request/Response — je ein Request- und ein Response-Schema. Direkte Abbildung:

```rust
#[tauri::command]
async fn sessions_send_prompt(
    state: tauri::State<'_, AppState>,
    input: SendPromptInput,
) -> Result<SendPromptResult, AppError> { … }
```

Namenskonvention: `domain:verb-objekt` → `domain_verb_objekt` (`gitlab:select-merge-request` → `gitlab_select_merge_request`). **Eine Umbenennungstabelle wird beim Portieren gepflegt** — sie ist gleichzeitig die Fortschrittsanzeige: 102 Zeilen, jede bekommt einen Haken, keine verschwindet stillschweigend.

### 5.2 Hochfrequentes Streaming → `tauri::ipc::Channel`

Sechs Push-Kanäle liefern heute über `webContents.send`:

```
events:session-batch              Gemini-Deltas — der kritische
git:project-status-changed
context-attachments:changed
todos:changed
gitlab:review-state-changed
app:update-download-progress
```

Für diese **keine** globalen Tauri-Events verwenden. `Channel<T>` ist der richtige Primitive: geordnet, pro Abonnent, deutlich weniger Overhead als `emit`, und der Lebenszyklus hängt am Aufrufer.

```rust
#[tauri::command]
async fn events_subscribe_session(
    state: tauri::State<'_, AppState>,
    session_id: String,
    after_seq: i64,
    on_batch: tauri::ipc::Channel<EventBatch>,
) -> Result<SubscriptionResult, AppError> { … }
```

**Die Ereignis-Pufferung des heutigen `#queueEvent` wird mitportiert:** 32-ms-Fenster, Verschmelzen aufeinanderfolgender Deltas derselben Nachricht bis 100.000 Zeichen. Das ist bereits eine gute Optimierung und darf nicht verlorengehen. In Rust sitzt sie hinter einem `tokio::sync::mpsc` mit `tokio::time::interval`.

Die vier Subscription-Hubs (Git, Kontext-Anhänge, Todos, GitLab) folgen alle demselben Muster — sie werden **einmal** als generische `SubscriptionHub<K, V>` gebaut und viermal instanziiert, statt viermal abgeschrieben.

### 5.3 Binärdaten → `tauri::ipc::Response`

`attachments:get-preview` und `context-attachments:get-bytes` liefern Rohbytes. In Tauri über `tauri::ipc::Response::new(Vec<u8>)` zurückgeben — das umgeht die JSON-Serialisierung und die Base64-Aufblähung vollständig. Im Frontend als `ArrayBuffer` entgegennehmen und wie heute in ein `Blob` verpacken.

### 5.4 Typgenerierung statt Handarbeit

Damit die 3.538 Zeilen Zod-Contracts nicht doppelt gepflegt werden: **`tauri-specta`** auf den Rust-Typen. Es generiert zusätzlich typisierte `invoke`-Wrapper für das Frontend — das ersetzt die heutige `window.gemUi`-Fassade vollständig und typsicher.

Die generierte Datei landet unter `src/types/bindings.ts` und wird eingecheckt. **Sie ist das einzige Frontend-Artefakt, das nicht von Hand entsteht** — und die Regel dafür lautet: wer sie von Hand ändert, hat einen Fehler gemacht.

### 5.5 Was ersatzlos entfällt

* `src/preload/` (486 LOC) — Tauri braucht keine Bridge.
* `src/main/security/ipc-guard.ts` — die Sender-Verifikation übernimmt Tauris Capability-System (Abschnitt 10).
* Die handgeschriebene `GemUiDesktopApi`-Schnittstelle (~170 Zeilen in `ipc.ts`) — ersetzt durch generierte Bindings.

---

## 6. Vorgehen im Ganzen: vertikale Schnitte statt Schichten

Bevor die beiden Detailabschnitte kommen, die Regel, die für beide gilt:

**Portiert wird pro Domäne von unten nach oben, nicht die ganze Schicht auf einmal.** Also nicht „erst alle Repositories, dann alle Services, dann alle Commands, dann das ganze Frontend", sondern: Todos komplett (Tabelle → Repository → Service → Commands → Panel), dann Git komplett, dann GitLab komplett.

Der Grund ist nicht Ästhetik. Ein vertikaler Schnitt ist **testbar, sobald er fertig ist**. Eine horizontale Schicht ist erst testbar, wenn die letzte darüber fertig ist — und dann kommen alle Fehler auf einmal.

Die Ausnahmen, die zwingend zuerst kommen und quer liegen:

1. **Schema v1** — alle 20 Tabellen auf einmal, weil Fremdschlüssel sonst nicht auflösbar sind.
2. **`AppState`, `AppError`, Idempotenz-Wrapper, `SubscriptionHub`** — die vier Bausteine, die jede Domäne braucht.
3. **ACP-Engine** — sie ist die Existenzberechtigung der App und trägt das größte Risiko. Sie kommt früh, nicht weil andere Module sie brauchen, sondern weil ein Scheitern hier den ganzen Plan ändert.
4. **`app.css` und `Icon.tsx`** — sie kosten fast nichts und machen jeden folgenden Frontend-Schnitt sofort visuell prüfbar.

---

## 7. Backend-Migration: wie du vorgehst

### 7.1 Die vier Bausteine zuerst

Diese vier Dateien entstehen vor der ersten Domäne und werden danach nicht mehr angefasst.

**`error.rs` — ein Fehlertyp für alles.** Heute wirft der Main-Prozess `Error`-Objekte, die `toPublicError` bereinigt. In Rust:

```rust
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")] Validation(String),
    #[error("{0}")] NotFound(String),
    #[error("{0}")] Conflict(String),      // Root-Revision, laufender Turn
    #[error("{0}")] Upstream(String),      // GitLab, Gemini
    #[error("{0}")] Io(#[from] std::io::Error),
}
```

Serialisiert wird bewusst nur `{ code, message }` — dieselbe Bereinigung wie heute, nur an einer Stelle statt in jedem Handler. Interne Pfade und Stacktraces gehen ins Log, nicht ans Frontend.

**`state.rs` — was der Prozess besitzt.** Heute liegt das in `src/main/index.ts` als lokale Variablen und wird in `runtimeServices` gebündelt. In Rust wird daraus ein Struct hinter `tauri::State`:

```rust
pub struct AppState {
    pub db: DbPool,                       // rusqlite hinter Mutex/Pool
    pub sessions: Arc<SessionManager>,    // ACP-Prozesse, max. 3
    pub capabilities: Arc<CapabilityService>,
    pub hubs: Hubs,                       // die vier Subscription-Hubs
    pub client_requests: ClientRequestRepo,
}
```

Regel: **`AppState` enthält keine Logik.** Es hält Handles. Wer eine Methode darauf schreiben will, hat sie im falschen Modul.

**Idempotenz-Wrapper.** Das heutige `idempotent(repository, input, operation, action)` ist ein Muster, das 20-mal vorkommt. In Rust ein Generic:

```rust
pub async fn idempotent<T, F, Fut>(
    repo: &ClientRequestRepo,
    client_request_id: &str,
    operation: &str,
    action: F,
) -> Result<T, AppError>
where T: Serialize + DeserializeOwned, F: FnOnce() -> Fut, Fut: Future<Output = Result<T, AppError>>
```

Es wird **beim ersten schreibenden Command gebraucht** — also sofort. Wer es später nachrüstet, muss 20 Commands anfassen.

**`SubscriptionHub<K, V>`.** Vier Hubs, ein Muster: Abonnenten-ID → `Channel<V>`, ein Schlüssel (Projekt, Session, Binding), `notify(key)` rechnet den Wert neu und schickt ihn an alle passenden Abonnenten. Einmal bauen, viermal instanziieren.

### 7.2 Das Rezept pro Modul

Jedes Backend-Modul durchläuft dieselben sieben Schritte. Wer sie einhält, kann den Fortschritt an einer Liste ablesen statt an einem Gefühl.

1. **Contracts zuerst.** Die Zod-Schemas der Domäne (`src/shared/contracts/<domain>.ts`) in Rust-Structs mit `#[derive(Serialize, Deserialize, Type)]` übersetzen. Eingabetypen bekommen `#[serde(deny_unknown_fields)]` und `garde`-Attribute; Ausgabetypen nur `Serialize`. Erst wenn `tauri-specta` daraus Bindings erzeugt, die den heutigen TS-Typen entsprechen, geht es weiter.
2. **Repository.** Die Tabellenzugriffe portieren. Row-Structs und `row_to_x`-Funktionen bilden das heutige Muster exakt ab. Alles läuft in `spawn_blocking`.
3. **Golden-Test aus dem Bestand.** Bevor die Logik kommt: die Testfälle der bestehenden vitest-Suite als Rust-Test übernehmen. Für die Parser (`porcelain-v2`, Unified-Diff, `event-normalizer`, GitLab-Discussion-Mapper) heißt das: Ein- und Ausgabe als Datei ablegen und beide Implementierungen dagegen laufen lassen. Das ist der einzige belastbare Paritätsnachweis, den es gibt.
4. **Service.** Die Geschäftslogik portieren. Hier gilt: **Zeilenweise übersetzen, nicht verbessern.** Jede „Gelegenheit zur Verbesserung" ist eine Gelegenheit für eine Abweichung, die in der Abnahme auffällt und dann teuer ist. Verbesserungen kommen nach der Parität, in einem eigenen Commit.
5. **Commands.** Dünne Hüllen: Input entgegennehmen, validieren, Service rufen, Fehler mappen. **Keine Logik in `commands/`.** Der heutige `register-app-ipc.ts` ist mit 1.148 Zeilen genau deshalb an ein paar Stellen zu dick geworden — das nicht wiederholen.
6. **Capability eintragen.** Neue Commands in `capabilities/main.json` freischalten. Wer das vergisst, merkt es sofort — der Aufruf schlägt fehl, statt still zu funktionieren. Das ist gewollt.
7. **Umbenennungstabelle abhaken.** Alle Kanäle der Domäne aus der 102er-Liste streichen.

### 7.3 Reihenfolge der Module und was jeweils die Falle ist

| # | Modul | Warum hier | Die Falle |
| :--- | :--- | :--- | :--- |
| 1 | **Schema v1 + `db/`** | alles hängt daran | Fremdschlüssel und `DEFERRABLE INITIALLY DEFERRED` bei `projects` ↔ `project_roots` genau übernehmen; WAL und `foreign_keys = ON` beim Öffnen setzen |
| 2 | **`processes/` + `capabilities`** | ohne Binary-Auflösung startet nichts | Die Windows-Auflösung von `gemini.cmd` auf den JS-Einstiegspunkt und die macOS-Homebrew-Pfade sind kein Beiwerk, sondern der Grund, warum die App bei Nutzern startet |
| 3 | **`acp/`** | größtes Risiko, früh beweisen | NDJSON-Guard: eine überlange Zeile darf den Stream nicht kippen. Der Permission-Broker braucht `oneshot`-Kanäle, die beim Prozessende sauber aufgelöst werden, sonst hängt ein Turn für immer |
| 4 | **`controller.rs` + Ereignispuffer** | macht ACP im UI sichtbar | Die 32-ms-Verschmelzung: `tokio::time::interval` feuert auch, wenn nichts anliegt — Leerlauf-Ticks dürfen keine leeren Batches schicken (sonst reißt die CPU-Idle-Abnahme aus Abschnitt 12) |
| 5 | **`projects/`** | Voraussetzung für alle Domänen | Der Root-Fingerprint muss bitgleich gerechnet werden wie heute, sonst gelten alle bestehenden Sessions als „roots_changed" |
| 6 | **`sessions/` + `usage/`** | vervollständigt den Kern | Die Verdrängung bei mehr als drei Sessions (LRU über inaktive) und die Tokenquellen-Priorität — beides ist implizites Verhalten, das nur die Tests festhalten |
| 7 | **`context-attachments/` + `attachments/`** | breite Fläche, wenig Risiko | Blob-Deduplizierung über SHA-256 und die Aufräumroutine beim Start; Extraktion asynchron, mit denselben Zustandsübergängen (`pending → running → ready/empty/unsupported/too_large/failed`) |
| 8 | **`git/`** | Parser sind mechanisch | Der porcelain-v2-Parser hat Sonderfälle für Umbenennungen, Konflikte und Pfade mit Leerzeichen. Golden-Files aus `tests/unit/git-diff.test.ts` sind hier bares Geld |
| 9 | **`todos/` + `project_files/`** | kleine, abgeschlossene Domänen | Todo-Anhänge sind **Verweise**: das Entfernen aus einem Todo darf den Projektanhang nie löschen |
| 10 | **`gitlab/` + `jira/`** | externe API, tolerant deserialisieren | Abschnitt 10.2 — die bekannten Sonderfälle sind teuer bezahlt und gehören als Regressionstests in die Rust-Suite |
| 11 | **`extensions/` + `updates/`** | Randfunktionen | Der Updater wird durch das Plugin ersetzt, nicht portiert — siehe 11 |
| 12 | **`links/preview.rs`** | zuletzt, weil am wackeligsten | Abschnitt 9 |

### 7.4 Was in Rust anders aussehen darf — und was nicht

**Darf anders aussehen:** Nebenläufigkeit. Was heute Promise-Ketten und `AbortController` sind, wird `tokio::select!` und `CancellationToken`. Die Abbruchlogik in `git:get-project-status` (jeweils nur die letzte Anfrage pro Sender gilt) ist in Rust sauberer ausdrückbar als heute — das ist eine erlaubte Verbesserung, weil sie das Verhalten nicht ändert.

**Darf nicht anders aussehen:** Zahlen und Grenzen. 32 ms, 100.000 Zeichen, 3 Sessions, 6 Repositories, 50 MB, 60.000/240.000 Zeichen, 20 Anhänge pro Prompt, 10 Suchtreffer, 500 Skills. Diese Werte stehen heute als benannte Konstanten in `src/shared/contracts/*.ts` und gehören in Rust genauso in **eine** Datei, nicht verstreut in die Module.

---

## 8. Frontend-Migration: wie du vorgehst

### 8.1 Die Reihenfolge

Anders als im Backend ist die Reihenfolge hier nicht von Abhängigkeiten getrieben, sondern davon, **wie schnell man sieht, ob es richtig ist.**

1. **`styles/app.css` kopieren.** Byteweise, ohne eine einzige Änderung. Das ist keine Aufgabe, das ist ein `cp`.
2. **`components/Icon.tsx`.** 353 Zeilen reines SVG, ein `switch`. Mechanisch: JSX-Attribute sind in Solid dieselben, `className` wird `class`. Danach ist jede weitere Komponente visuell prüfbar.
3. **`src/ipc/`.** Dünne Wrapper um die generierten Bindings, gruppiert wie die heutige `window.gemUi`-Fassade (`ipc.projects.list()`, `ipc.jira.attachIssue()`). Der Grund: die 34 Komponenten rufen heute `window.gemUi.x.y()` — wenn der Wrapper dieselbe Form hat, ist die Portierung jeder Aufrufstelle ein Suchen-und-Ersetzen statt einer Umstrukturierung.
4. **`features/chat/reducer.ts` + Store.** Siehe 8.4 — der Reducer wird nicht umgeschrieben.
5. **`Timeline.tsx`.** Die anspruchsvollste Komponente, und die, an der man die Streaming-Performance sofort sieht.
6. **`Composer.tsx`.** Enthält den einzigen echten Fallstrick (Drag & Drop, 8.6).
7. **`Sidebar`, `ChatHeader`, `PanelRail`.** Rahmen.
8. **Die sieben Panels.** Attachments, Todos, Changes, GitLab, Jira, Skills, MCP — unabhängig voneinander, gut parallelisierbar.
9. **Die Dialoge.** ProjectDialog, ProjectSettingsDialog, GitLabSetupDialog, ReconnectHistoryModal, LiveViewModal, AddLinkDialog, AppInfoUpdatePopover.
10. **`app/App.tsx` zuletzt.** Siehe 8.3 — sie ist heute die Zustandszentrale und lässt sich erst sinnvoll schneiden, wenn man weiß, was die Kinder tatsächlich brauchen.

### 8.2 Das Rezept pro Komponente

1. Datei danebenlegen, nicht ersetzen. Die React-Fassung bleibt bis zur Abnahme lesbar.
2. **JSX bleibt.** `className` → `class`, `htmlFor` → `for`, Rest unverändert.
3. Hooks nach der Tabelle in 8.7 übersetzen.
4. **Props nicht destrukturieren.** Das ist die Regel, die man dreimal vergisst und die jedes Mal eine tote Oberfläche erzeugt: `function X({ a, b })` bricht die Reaktivität. `props.a` verwenden oder `splitProps`.
5. **Jedes `useEffect` einzeln prüfen.** Das Dependency-Array entfällt — aber es hat heute an manchen Stellen *absichtlich* zu wenig Einträge, um ein erneutes Laufen zu verhindern. Solid trackt automatisch alles, was im Effekt gelesen wird. Wo heute eine Abhängigkeit fehlt, muss in Solid der Lesezugriff aus dem Effekt heraus (`untrack`) oder der Effekt anders geschnitten werden. **Das ist die häufigste Fehlerquelle der ganzen Portierung.**
6. Aufräumen in `onCleanup` statt in der Effekt-Rückgabe.
7. Nebeneinander im Fenster vergleichen, dann die React-Datei löschen.

### 8.3 `App.tsx`: 1.467 Zeilen Zustandszentrale

Heute hält `App.tsx` rund 25 `useState`, sieben Datenquellen-Effekte und das gesamte Panel-Routing. In React ist das eine Notwendigkeit — der Zustand muss über den Kindern liegen. In Solid ist es keine mehr, weil Signale ohne Provider weitergereicht werden können.

**Trotzdem: nicht umbauen.** Die Portierung bleibt strukturgleich, und zwar aus einem Grund: eine Umstrukturierung während einer Portierung macht jeden Fehler doppelt schwer zu finden, weil man nie weiß, ob er aus der Übersetzung oder aus der neuen Struktur kommt.

Was sich **doch** ändert, weil es sonst schlechter würde als heute:

* Die sieben „laden und in State schreiben"-Effekte (`projects.list`, `sessions.list`, `gitlab.listRepositoryCandidates`, `jira.getProjectIntegration`, …) werden **`createResource`**. Das ist kein Umbau, sondern das direkte Solid-Gegenstück: es bringt Lade- und Fehlerzustand mit, den `App.tsx` heute von Hand führt, und es hat einen `refetch`, der das heutige `reloadToken`-Muster ersetzt.
* Der Panel-Zustand (`rightPanel`, `rightPanelWidth`) wird ein kleiner `createStore` mit `localStorage`-Anbindung — dieselben Schlüssel, dasselbe Verhalten.

Nach der Portierung, in einem **eigenen Commit nach der Abnahme**, darf `App.tsx` in Kontexte zerlegt werden. Nicht vorher.

### 8.4 Der Timeline-Reducer — der eleganteste Teil der Migration

`features/chat/reducer.ts` (580 Zeilen) ist eine **reine Funktion** `(state, action) => state`. Sie muss **nicht umgeschrieben werden.** Solid bietet dafür genau das passende Werkzeug:

```ts
import { createStore, reconcile } from "solid-js/store";

const [state, setState] = createStore<ChatState>(createChatState());

function dispatch(action: ChatAction) {
  setState(reconcile(chatReducer(state, action), { key: "id", merge: false }));
}
```

`reconcile` vergleicht das Ergebnis mit dem bestehenden Store und schreibt **nur die tatsächlich veränderten Pfade** zurück. Beim Streaming heißt das konkret: es ändert sich der Textknoten *einer* Nachricht — und nichts sonst wird angefasst. Kein `memo`, keine manuellen Vergleichsfunktionen, kein Virtualisierungszwang.

Der Reducer wird zeilenweise übernommen. Nur die Typimporte wechseln von `src/shared/contracts` auf `src/types/bindings`.

**Prüfung:** `tests/unit/renderer-reducer.test.ts` läuft nach dem Importtausch unverändert weiter. Wenn dieser Test grün ist, ist der Kern der Timeline bewiesen — noch bevor eine einzige Solid-Komponente existiert.

### 8.5 Markdown

`react-markdown` hat kein Solid-Gegenstück. Ersatz: **`markdown-it`** mit `{ html: false, linkify: true }` und dem GFM-Plugin für Tabellen und Durchstreichen.

`html: false` entspricht exakt dem heutigen `skipHtml` — eingebettetes HTML wird als Text ausgegeben, nicht gerendert. **Damit ist kein zusätzlicher Sanitizer nötig**, und das Sicherheitsverhalten bleibt identisch. Links werden wie heute über einen Klick-Handler abgefangen und an `open_external_https_url` weitergereicht.

Gerendert wird über `innerHTML` in einem memoisierten Container — bei Solid bedeutet das: die Umwandlung läuft nur, wenn sich der Text tatsächlich ändert, und nur für die betroffene Nachricht.

### 8.6 Drag & Drop — der eine echte Fallstrick

Heute liefert `webUtils.getPathForFile(file)` im Preload den absoluten Pfad einer hineingezogenen Datei. Tauri löst das anders, und die Falle ist wichtig:

* Tauri fängt Datei-Drops **nativ** ab (`tauri://drag-drop`) und liefert absolute Pfade — genau das, was der Kontext-Anhang-Pfad braucht.
* **Solange das aktiv ist, erreichen HTML5-`ondrop`-Ereignisse den Webview nicht.** Die heutigen Drop-Zonen in `AttachmentsPanel`, `Composer` und `TodosPanel` funktionieren so nicht mehr.

**Lösung:** Native Verarbeitung beibehalten (die Pfade werden gebraucht) und die visuelle Rückmeldung umbauen: Die Ereignisse `tauri://drag-enter`, `tauri://drag-over` und `tauri://drag-leave` liefern Cursor-Koordinaten. Ein kleiner Dienst im Frontend ermittelt daraus per `document.elementFromPoint()` die getroffene Drop-Zone und setzt denselben Zustand, den heute `setDragScope` setzt. Das Verhalten für den Nutzer bleibt identisch — Hervorhebung der Zone, Ablegen, Zuordnung zu Projekt, Session oder Todo.

Der Einfüge-Pfad (`onPaste` mit `clipboardData.files`) bleibt unverändert; dort gibt es keine Pfade und der Inhalt kommt als Bytes.

**Wichtig für die Reihenfolge:** Dieser Dienst wird **einmal** gebaut, bevor die erste Drop-Zone portiert wird. Drei Komponenten hängen daran.

### 8.7 Übersetzungsmuster

| React | SolidJS | Anmerkung |
| :--- | :--- | :--- |
| `useState` | `createSignal` | Aufrufstelle wird zur Funktion: `count` → `count()` |
| `useMemo` | `createMemo` | |
| `useEffect(fn, [deps])` | `createEffect(fn)` | **Kein Dependency-Array** — Solid trackt automatisch. Siehe 8.2 Punkt 5 |
| `useEffect` mit Datenabruf | `createResource` | bringt Lade- und Fehlerzustand mit |
| `useLayoutEffect` | `createRenderEffect` | für die Bounds-Nachführung der Live-Vorschau |
| Effekt-Rückgabe (Cleanup) | `onCleanup(fn)` | |
| `useRef` (DOM) | `let el; <div ref={el}>` | |
| `useRef` (Wert) | einfache `let`-Variable | Komponenten laufen nur einmal |
| `useCallback` | entfällt | Funktionen werden nicht neu erzeugt |
| `useReducer` | `createStore` + `reconcile` | siehe 8.4 |
| `{cond && <X/>}` | `<Show when={cond()}>` | |
| `{a ? <X/> : <Y/>}` | `<Show when={} fallback={}>` | |
| verschachtelte Ternaries (Panel-Routing) | `<Switch>` / `<Match>` | `App.tsx` hat davon zwei mit je sieben Zweigen |
| `list.map(...)` | `<For each={list()}>` | `<For>` bei Objektlisten, `<Index>` bei Primitiven |
| `React.Fragment` | `<>…</>` | unverändert |
| Props destrukturieren | **nicht destrukturieren** | zerstört die Reaktivität |
| `className` | `class` | |

### 8.8 Plattformabhängige Stellen

| Stelle | Heute | Neu |
| :--- | :--- | :--- |
| Ordnerauswahl | `dialog.showOpenDialog` | `tauri-plugin-dialog` |
| Datei im Standardprogramm öffnen | `shell.openPath` | `tauri-plugin-opener` |
| Externe URL öffnen | `shell.openExternal` | `tauri-plugin-opener` (nur `https:` zulassen, wie heute) |
| Zwischenablage-Bilder | `clipboard.readImage` | Web-API `navigator.clipboard` reicht |
| Fensterzustand merken | eigener Code | `tauri-plugin-window-state` |
| Einfachinstanz | Squirrel | `tauri-plugin-single-instance` |
| `-webkit-app-region: drag` | funktioniert | funktioniert; unter WebKitGTK zusätzlich `data-tauri-drag-region` setzen |

---

## 9. Link- und Jira-Live-Vorschau über Multi-Webview

Das aufwendigste Einzelfeature — und seit der Jira-Integration wird es von **zwei** Stellen benutzt: der Anhangs-Vorschau und der vollflächigen Jira-Issue-Ansicht. Beide teilen sich heute denselben `BrowserView` mit eigener persistenter Partition, damit Nutzer sich darin anmelden können.

**Umsetzung in Tauri 2** — als eigenständiges Modul `links/preview.rs`, bewusst gekapselt:

* Ein **zweiter Webview im selben Fenster** über `WindowBuilder::add_child` mit `WebviewBuilder`. Das erfordert das **`unstable`-Feature** von Tauri 2 — bewusst in Kauf genommen und in `Cargo.toml` dokumentiert.
* Die Bounds werden wie heute vom Frontend nachgeführt: `LinkPreviewSurface` misst per `getBoundingClientRect()` und ruft `link_preview_set_bounds`. Dieselbe Komponente, derselbe `ResizeObserver`, dieselbe rAF-Drosselung. **`JiraIssueView` benutzt exakt dieselbe Komponente** — wenn die Vorschau steht, steht Jira mit.
* Persistente Sitzung: eigenes Datenverzeichnis für diesen Webview. „Angemeldete Sitzungen löschen" leert es und lädt neu.
* Eigene Capability-Datei `capabilities/preview.json` **ohne** jeden `invoke`-Zugriff — der Vorschau-Webview darf keine App-Befehle aufrufen. Das ist strenger als heute und kostet nichts.
* Genau ein Vorschau-Webview zur Zeit, wie heute. Das Frontend garantiert das bereits: der Effekt in `App.tsx`, der die Vorschau schließt, sobald weder das Anhangs-Panel noch die Jira-Ansicht offen ist, wird 1:1 übernommen.

**Bekanntes Risiko:** Unter Linux/WebKitGTK ist Multi-Webview der wackeligste Teil. Deshalb liegt die gesamte Steuerung hinter einem Trait `PreviewSurface`, sodass eine Rückfallebene (eigenes Fenster statt eingebettetem Child-Webview) ohne Änderung am Frontend nachgerüstet werden kann.

**Definition of Done:** Vorschau öffnet sich, folgt beim Scrollen und Größenändern verzögerungsfrei, Login bleibt über App-Neustarts erhalten, „Sitzungen löschen" wirkt, und die Jira-Ansicht nimmt die volle Fläche zwischen Seitenleiste und Panel-Leiste ein — auf allen drei Plattformen.

---

## 10. Sicherheit: die Zod-Schicht darf nicht verlorengehen

Heute validiert `registerValidatedIpcHandler` **Ein- und Ausgabe** jedes IPC-Aufrufs gegen Zod-Schemas. Das ist in diesem Projekt nachweislich wertvoll: mehrfach hat ein einzelner unerwarteter Wert aus der GitLab-API (`line_range.type = "expanded"`, leere SHAs, relative Avatar-URLs) Fehler früh und an der richtigen Stelle sichtbar gemacht.

Beim Übergang zu Serde ändert sich das Verhalten in beide Richtungen und muss bewusst nachgebaut werden:

1. **Eingaben:** Serde erzwingt Typen, aber keine Wertebereiche. Längen-, Bereichs- und Formatgrenzen (`max(200)`, `z.url()`, `Sha256Schema`, die Jira-Prefix-Regex) über **`garde`** als Ableitungsmakros nachziehen. Unbekannte Felder mit `#[serde(deny_unknown_fields)]` ablehnen — das ist das Gegenstück zu `.strict()`.
2. **Externe Antworten (GitLab, OpenGraph, Gemini):** Hier gilt das Umgekehrte. **Bewusst tolerant deserialisieren** — `#[serde(other)]` für unbekannte Enum-Varianten, `Option<T>` statt Pflichtfeldern, `#[serde(default)]`. Ein einzelner unerwarteter Wert darf niemals eine ganze Liste unbrauchbar machen. Diese Lektion ist teuer bezahlt und muss in die Rust-Typen einfließen.
3. **Ausgaben:** Die heutige Ausgabevalidierung fällt weg — der Rückgabetyp *ist* das Schema. Das ist ein echter Gewinn: was heute zur Laufzeit geprüft wird, prüft der Compiler.
4. **Capabilities statt IPC-Guard:** Der heutige `ipc-guard.ts` prüft, dass IPC-Aufrufe vom Hauptfenster stammen. In Tauri übernimmt das `capabilities/main.json` deklarativ — Fenster für Fenster, Befehl für Befehl. Der Vorschau-Webview bekommt eine eigene, leere Capability.
5. **CSP** in `tauri.conf.json` streng setzen; die App lädt keine externen Ressourcen.
6. **Token bleiben außerhalb der DB-Klartextspalten.** Der GitLab-Token liegt heute als verschlüsselter Blob in `gitlab_connections.token_cipher`; künftig liegt der Schlüssel im OS-Depot (`keyring`) und der Chiffretext weiter in der Spalte. Jira braucht keinen Token — das bleibt so.

---

## 11. Build, Signierung, Auslieferung

* **CI:** GitHub Actions, Matrix über `macos-latest` (arm64 + x64), `windows-latest`, `ubuntu-22.04`. Rust-Cache über `Swatinem/rust-cache`, sonst dauert jeder Lauf voll durch.
* **Buildzeit:** realistisch 8–15 Minuten pro Release-Matrix. Mit Cache bei Folgebuilds deutlich weniger.
* **Signierung:** macOS-Notarisierung bleibt Pflicht. Windows-Signierung wie bisher. Nebenwirkung, die dokumentiert bleiben muss: eine stabile signierte Identität ist der Grund, warum macOS die Ordnerfreigaben über Versionen hinweg behält — ohne sie bleibt der „Zugriff"-Knopf in den Projekteinstellungen dauerhaft nötig.
* **Updater:** `tauri-plugin-updater` löst die 424 Zeilen Eigenbau in `src/main/updates/` ab — Prüfung, Download mit Fortschritt und Installation kommen aus dem Plugin. Braucht ein Signaturschlüsselpaar (privater Schlüssel als CI-Secret) und ein `latest.json`. **GitHub Releases bleibt die Bezugsquelle**; der bestehende Release-Workflow wird nur um die Manifest-Erzeugung erweitert. Die Popover-Oberfläche (`AppInfoUpdatePopover.tsx`, 318 Zeilen) bleibt und wird auf die Plugin-Events umgehängt.
* **WebView2 unter Windows:** Der Installer bleibt klein, setzt aber die WebView2-Runtime voraus. In `tauri.conf.json` den Bootstrapper-Modus wählen (`downloadBootstrapper`), damit auf Systemen ohne Runtime automatisch nachinstalliert wird.
* **Linux-Pakete:** heute deb und rpm. Für Tauri kommt AppImage praktisch geschenkt dazu — Entscheidung siehe 15.

---

## 12. Reihenfolge: acht Meilensteine

Die Reihenfolge ist so gewählt, dass das **Risikoreichste zuerst bewiesen** wird und ab Meilenstein 2 durchgehend eine startbare App existiert.

### M1 — Gerüst und Durchstich *(≈ 1 Woche)*
Tauri-2-Projekt, SolidJS + Vite, `app.css` übernommen, `Icon.tsx` portiert, `tauri-specta` eingerichtet, `rusqlite` mit konsolidiertem Schema v1, die vier Bausteine aus 7.1, Fensterrahmen mit Sidebar-Layout.
**Fertig, wenn:** die App startet, das Fenster aussieht wie heute (leerer Zustand), ein Dummy-Command über generierte Typen erfolgreich aufgerufen wird — und das auf allen drei Plattformen.

### M2 — ACP-Engine *(≈ 2,5–3 Wochen — der harte Kern)*
Zuerst: Eignung des Crates `agent-client-protocol` prüfen, sonst eigener JSON-RPC-Client. Dann Binary-Auflösung, Subprozess, NDJSON-Zeilenguard, Event-Normalisierung, Permission-Broker über `oneshot`, Session-Lebenszyklus inklusive Resume und komprimierter Historie, Ereignis-Pufferung (32 ms + Delta-Verschmelzung), Auslieferung über `tauri::ipc::Channel`.
**Fertig, wenn:** ein Prompt gesendet wird, Text streamt, eine Werkzeug-Freigabe im UI erscheint und beantwortet werden kann, ein Abbruch greift, und ein Reconnect die Historie korrekt wiederherstellt.

### M3 — Persistenz, Projekte, Sessions *(≈ 2 Wochen)*
Alle 11 Repositories, Idempotenz über `client_requests`, Projekte mit Roots, Fingerprint und Reautorisierung, Freigabe-Policies, Einstellungen inklusive beider Binary-Auswahlen, Session-Verwaltung mit Suche, Token-Nutzungsaggregation.
**Fertig, wenn:** Projekte und Sessions überleben einen Neustart, die Sidebar verhält sich identisch zu heute, und die Volltextsuche findet dieselben Sessions.

### M4 — Frontend-Kern *(≈ 2,5 Wochen, parallel ab M2 möglich)*
`src/ipc/`-Wrapper, Reducer + Store, Timeline, Composer inklusive Drag-&-Drop-Dienst (8.6), Sidebar, ChatHeader, PanelRail, Markdown über `markdown-it`.
**Fertig, wenn:** eine Session mit Streaming, Werkzeugkarten, Freigaben und `@`-Mentions vollständig bedienbar ist und `renderer-reducer.test.ts` grün läuft.

### M5 — Git und Änderungen *(≈ 1,5 Wochen)*
Repository-Erkennung, porcelain-v2-Parser, Diff-Parser, Status-Hub, ChangesPanel, DiffViewer, Inline-Diff-Vorschauen.
**Fertig, wenn:** Statusanzeige, Inline-Vorschauen und der Diff-Viewer an echten Repositories dieselben Ergebnisse liefern wie heute — Golden-Files aus `tests/unit/git-diff.test.ts` als Nachweis.

### M6 — Kontext-Anhänge und Todos *(≈ 2 Wochen)*
Blob-Store, Mime-Sniffing, Extraktion inklusive der PDFium-Entscheidung aus 4.1, OpenGraph-Metadaten, AttachmentsPanel, AttachmentDetail, Todos mit Panel und Prompt-Entwurf, `project-files`-Suche.
**Fertig, wenn:** Anhänge aus PDF, Text und Code dieselben Extraktionsergebnisse liefern (an einem PDF-Korpus geprüft), Drag & Drop in Chat, Panel **und** Todo funktioniert, und ein Todo samt Anhängen an eine Session übergeben werden kann.

### M7 — GitLab, Jira, Skills, MCP, Updates *(≈ 2,5 Wochen)*
REST-Client mit **tolerant** deserialisierenden Typen (10.2), Vault über keyring, Discussion-Mapper, Review-Kontext, GitLabPanel und Setup-Dialog; Jira-Konfigurationen, Aktivierung, Issue-Key-Erkennung, Rail-Eintrag, Auto-Anhang; Skills-/MCP-Scanner; Updater-Plugin mit bestehendem Popover.
**Fertig, wenn:** ein realer Merge Request mit Threads geladen, beantwortet und aufgelöst werden kann, und eine Session mit passendem Titel das Jira-Symbol samt Anhang erzeugt.

### M8 — Live-Vorschau, Feinschliff, Auslieferung *(≈ 2 Wochen)*
Multi-Webview nach Abschnitt 9 für Link-Vorschau **und** Jira-Ansicht, Capabilities scharf stellen, CI-Matrix, Signierung, Updater-Manifest, plattformübergreifender Abnahmetest.
**Fertig, wenn:** signierte Artefakte für macOS, Windows und Linux aus der CI fallen und die Abnahmeliste aus Abschnitt 13 vollständig grün ist.

**Gesamtaufwand: 15–17 Wochen Vollzeit**, bei paralleler Frontend-Arbeit ab M2 eher am unteren Ende. Die vorige Fassung schätzte 12–14 Wochen für einen um Todos, Jira, Update-Download und rund 25 IPC-Kanäle kleineren Stand — die Erhöhung ist Buchführung, keine Neubewertung.

---

## 13. Abnahme: 1:1-Parität nachweisen

Ohne Prüfliste wird „1:1" zur Behauptung. Vor der ersten Auslieferung ist jeder Punkt auf allen drei Plattformen abzuhaken.

**Optisch**
- [ ] Screenshot-Vergleich Electron ↔ Tauri für: leerer Zustand, aktive Session mit Streaming, alle sieben Panels, alle sieben Dialoge, Hell- und Dunkelmodus
- [ ] Fenster-Ziehbereiche, Scrollleisten, Fokusringe, Hover-Zustände
- [ ] Alle Animationen und Übergänge (Panel-Einblendung, Dialog-Einflug, Spinner)
- [ ] Panelbreite ziehen, Doppelklick setzt zurück, Zustand überlebt Neustart

**Funktional — Kern**
- [ ] Prompt senden, Streaming, Abbrechen, Werkzeug-Freigabe erlauben/ablehnen/dauerhaft
- [ ] Session anlegen, umbenennen, anpinnen, archivieren, löschen, Suche über Titel und Volltext
- [ ] Reconnect mit komprimierter Historie **und** mit frischem Start
- [ ] Vierte Session öffnen verdrängt eine inaktive; sind alle drei beschäftigt, kommt dieselbe Fehlermeldung wie heute statt eines Abbruchs
- [ ] Modell- und Moduswechsel im Header, inklusive Fallback-Listen bei stummer ACP-Anbindung
- [ ] Token-Popover zeigt dieselben Zahlen und dieselbe Quellenangabe
- [ ] Projekt anlegen, zusätzliche Ordner, Reautorisierung nach Neustart, Freigabe-Policy inklusive Bestätigung bei „Alles erlauben"
- [ ] Root-Änderung wird während eines laufenden Turns verweigert

**Funktional — Panels und Integrationen**
- [ ] Git-Status, Inline-Diff-Vorschauen an Werkzeugkarten, Diff-Viewer bei großen Dateien
- [ ] Anhänge: Datei wählen, Drag & Drop in Chat, Panel **und** Todo, Einfügen, Link hinzufügen, Herkunftsfilter, Extraktion von PDF, Text und Code
- [ ] Link-Live-Vorschau inklusive Login und „Sitzungen löschen"
- [ ] Todos: anlegen, sortieren, abhaken, Anhänge verknüpfen und lösen, an aktive und an neue Session senden
- [ ] GitLab: Verbindung anlegen und testen, selbstsigniertes Zertifikat, Repository aktivieren, MR wählen und per URL verbinden, Thread beantworten und auflösen, Review-Kontext in allen drei Modi an Gemini senden
- [ ] Jira: Konfiguration anlegen, in zweitem Projekt vorgeschlagen bekommen, aktivieren und deaktivieren; Session-Titel mit Key erzeugt Symbol, Vollansicht und Anhang; Titel mit zwei Keys nimmt den ersten
- [ ] Skills- und MCP-Panel, Update-Prüfung mit Download und Installation

**Leistung** (Referenz: 4 Kerne, keine dedizierte GPU, 8 GB RAM)
- [ ] Kaltstart bis interaktiv **< 1 s**
- [ ] Erstes Token nach Prompt **< 400 ms**
- [ ] Streaming ≥ **55 fps** in einem Verlauf mit 30+ Nachrichten
- [ ] RAM nach einstündiger Session **< 250 MB**
- [ ] CPU im Leerlauf **< 1 %**

---

## 14. Risiken und wie damit umgegangen wird

| Risiko | Wirkung | Umgang |
| :--- | :--- | :--- |
| **Multi-Webview unter WebKitGTK instabil** | Live-Vorschau **und** Jira-Ansicht unbrauchbar unter Linux | Hinter Trait `PreviewSurface` kapseln; Rückfall auf separates Fenster ohne Frontend-Änderung. Wiegt seit Jira schwerer als in der vorigen Fassung |
| **PDF-Extraktion schlechter als pdf.js** | Anhänge liefern schlechteren Kontext | Am PDF-Korpus messen (M6); Rückfall auf Node-Sidecar |
| **Kein brauchbares ACP-Crate** | +1 Woche in M2 | Früh prüfen — erste Aufgabe in M2, nicht später |
| **Serde strenger als Zod bei API-Antworten** | Laufzeitfehler bei GitLab-Sonderfällen | Externe Typen konsequent tolerant (10.2); die bekannten Fälle als Regressionstests übernehmen |
| **Solid-Effekte laufen öfter als die React-Vorlage** | Endlosschleifen, doppelte Netzwerkaufrufe | 8.2 Punkt 5; jeder portierte Effekt wird einzeln geprüft, nicht die Datei als Ganzes |
| **`App.tsx` wird „bei der Gelegenheit" umgebaut** | Fehler nicht mehr zuordenbar | 8.3: strukturgleich portieren, Umbau erst nach der Abnahme |
| **WebKit-CSS-Abweichungen (macOS/Linux)** | Optische Unterschiede | Früh testen: bereits ab M1 auf allen drei Plattformen bauen, nicht erst in M8 |
| **`unstable`-Feature von Tauri** | Bruch bei Tauri-Update | Tauri-Version in `Cargo.toml` pinnen; Updates bewusst durchführen |
| **Drag & Drop übersehen** | Kernfunktion fehlt lautlos | Dienst vor der ersten Drop-Zone bauen (8.6); in der Abnahme für Chat, Panel **und** Todo geführt |
| **Idempotenz erst spät eingezogen** | 20 Commands nachträglich anfassen | Baustein aus 7.1, vor dem ersten schreibenden Command |

---

## 15. Offene Entscheidungen

Diese Punkte sind vor dem jeweiligen Meilenstein zu klären:

1. **Vor M2:** Eignet sich das Crate `agent-client-protocol`, oder wird der JSON-RPC-Client selbst gebaut?
2. **Vor M6:** Erreicht `pdfium-render` am Prüfkorpus die Qualität von pdf.js — oder kommt der Node-Sidecar?
3. **Vor M8:** Bleibt es beim eingebetteten Child-Webview für Link-Vorschau und Jira-Ansicht, oder wird unter Linux auf ein eigenes Fenster ausgewichen?
4. **Vor M8:** Welche Linux-Pakete werden ausgeliefert (deb, rpm, AppImage — heute deb und rpm)?
5. **Nach der Abnahme:** Wird `App.tsx` in Kontexte zerlegt, oder bleibt die heutige Zustandszentrale bestehen?
