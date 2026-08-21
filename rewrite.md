# GeminUI — Migrationsplan: Electron/React → Tauri 2 + Rust + SolidJS

**Status:** Beschlossen. Dieses Dokument ist der Umsetzungsplan, keine Entscheidungsvorlage mehr.

**Zielbild:** GeminUI läuft als Tauri-2-Anwendung mit Rust-Backend und SolidJS-Frontend. **Look and Feel sowie Funktionsumfang bleiben 1:1 identisch.**

**Rahmenbedingungen, die den Plan vereinfachen:**

* **Keine Datenmigration.** Die App hat keine Nutzerbasis. Die SQLite-Datenbank wird neu aufgebaut, die neun bestehenden Migrationsschritte werden zu **einem konsolidierten Schema v1** zusammengefasst. Kein Kompatibilitätsballast.
* **Keine Token-Übernahme.** GitLab-Verbindungen werden neu eingerichtet. Der in Electron über `safeStorage` verschlüsselte Bestand muss nicht übersetzt werden.
* **Kein Parallelbetrieb.** Es gibt keine Übergangsphase, in der beide Versionen gepflegt werden müssen.

Damit entfallen die drei aufwendigsten Posten eines typischen Rewrites. Was bleibt, ist ehrliche Portierungsarbeit.

---

## 1. Bestandsaufnahme: was portiert werden muss

Gemessener Stand der Codebase (Stand 21.08.2026):

| Bereich | Umfang | Anmerkung |
| :--- | ---: | :--- |
| `src/main` (Backend) | **16.327 LOC** | vollständig nach Rust |
| `src/shared/contracts` (Zod) | **2.879 LOC** | nach Rust-Typen + Serde |
| `src/preload` | ~380 LOC | entfällt ersatzlos (Tauri braucht keine Bridge) |
| `src/renderer` (Frontend) | **9.293 LOC**, 29 `.tsx` | nach SolidJS |
| davon `app.css` | ~1.180 Zeilen | **wird 1:1 übernommen, keine Änderung** |
| IPC-Oberfläche | **78 Kanäle** | → Tauri Commands, Events und Channels |
| Datenbanktabellen | **17** | → konsolidiertes Schema v1 |

### Backend-Module nach Größe

```
2.893  storage/              SQLite, 9 Migrationen, 10 Repositories
2.272  integrations/         GitLab: REST-Client, Vault, Discussion-Mapper, MR-Resolver
2.129  gemini/               ACP: Subprozess, JSON-RPC, Event-Normalizer, Capabilities
1.646  git/                  porcelain-v2-Parser, Unified-Diff-Generator
1.298  app-controller.ts     Orchestrierung, Event-Puffer, Idempotenz
1.166  context-attachments/  Blob-Store, Mime-Sniffing, Extraktion, Worker
  953  ipc/                  Handler-Registrierung, Validierung, Event-Hub
  555  projects/             Roots, Freigabe-Policies, Reautorisierung
  525  agent-extensions/     Skills- und MCP-Scanner
  475  processes/            Prozessverwaltung, Binary-Auflösung
  456  project-files/        @-Mention-Suche
  414  links/                Link-Live-Vorschau (BrowserView)
  286  security/             IPC-Guard (Sender-Verifikation)
  277  index.ts              Bootstrap
  262  attachments/          Bild-Staging für Prompts
  223  sessions/             Session-Manager
  198  updates/              GitHub-Releases-Prüfung
  154  usage/                Token-Aggregation
  145  capability-service.ts Gemini-Fähigkeitserkennung
```

### Frontend-Komponenten nach Größe

```
1.205  app/App.tsx                          Zustandszentrale, Panel-Routing
  580  features/chat/reducer.ts             Timeline-Reducer (reine Funktion)
  550  features/attachments/Composer.tsx    Prompt-Eingabe, @-Mentions, Drag&Drop
  532  features/projects/ProjectSettingsDialog.tsx
  521  features/chat/Timeline.tsx           Verlauf, Tool-Gruppen, Freigaben
  446  features/attachments/AttachmentsPanel.tsx
  441  features/chat/ChatHeader.tsx
  328  components/Icon.tsx                  reine SVG-Sammlung
  312  features/gitlab/GitLabSetupDialog.tsx
  301  features/sessions/Sidebar.tsx
  284  features/gitlab/GitLabPanel.tsx
  250  features/gitlab/GitLabDiscussionCard.tsx
  231  features/git/ChangesPanel.tsx
  230  features/mcp/McpPanel.tsx
  ...  16 weitere Komponenten
```

---

## 2. Zielarchitektur

```
gem-ui/
├── src-tauri/
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── capabilities/
│   │   ├── main.json               # Rechte des Hauptfensters
│   │   └── preview.json            # eng begrenzte Rechte der Live-Vorschau
│   ├── migrations/
│   │   └── 001_initial.sql         # konsolidiertes Schema (ersetzt Migration 1–9)
│   └── src/
│       ├── main.rs                 # Tauri-Builder, State-Registrierung, Setup
│       ├── error.rs                # AppError (thiserror) + Serde-Serialisierung
│       ├── state.rs                # AppState: Pools, Manager, Broker
│       ├── acp/
│       │   ├── process.rs          # Subprozess-Spawn, stdio, NDJSON-Guard
│       │   ├── rpc.rs              # JSON-RPC-Rahmen, Request/Response-Korrelation
│       │   ├── normalize.rs        # Rohereignisse → NormalizedAgentEvent
│       │   ├── permission.rs       # Permission-Broker (oneshot-Kanäle)
│       │   ├── session.rs          # Lebenszyklus, Resume, komprimierte Historie
│       │   └── capabilities.rs     # Fähigkeitserkennung
│       ├── db/
│       │   ├── mod.rs              # Pool, WAL-Setup, Migrationslauf
│       │   └── repo/               # projects, sessions, events, attachments,
│       │                           # context_attachments, gitlab, settings, usage,
│       │                           # client_requests (Idempotenz)
│       ├── git/
│       │   ├── runner.rs           # CLI-Aufrufe (konfigurierbares Binary!)
│       │   ├── status.rs           # porcelain-v2-Parser
│       │   └── diff.rs             # Unified-Diff → strukturierte Zeilen
│       ├── gitlab/
│       │   ├── client.rs           # REST (reqwest)
│       │   ├── schema.rs           # tolerante Deserialisierung
│       │   ├── vault.rs            # keyring + aes-gcm
│       │   ├── discussions.rs      # Mapper
│       │   └── review.rs           # Review-State, Kontextaufbau
│       ├── attachments/
│       │   ├── blobs.rs            # Blob-Store auf Platte
│       │   ├── mime.rs             # Mime-Sniffing
│       │   ├── extract/            # PDF, DOCX, HTML, Klartext
│       │   └── opengraph.rs        # Link-Metadaten
│       ├── extensions/             # Skills- und MCP-Scanner
│       ├── links/
│       │   └── preview.rs          # Multi-Webview-Steuerung
│       ├── projects/               # Roots, Freigabe-Policies
│       ├── updates/                # Update-Prüfung
│       └── commands/               # #[tauri::command]-Endpunkte, nach Domäne
├── src/                            # SolidJS-Frontend
│   ├── app/
│   ├── features/                   # gleiche Ordnerstruktur wie heute
│   ├── components/
│   ├── ipc/                        # typisierte invoke-/Channel-Wrapper
│   ├── types/                      # aus Rust generierte Typen
│   └── styles/app.css              # UNVERÄNDERT übernommen
└── package.json
```

**Leitprinzip:** Die Ordnerstruktur des Frontends bleibt identisch zu heute. Wer die Electron-Version kennt, findet sich sofort zurecht, und jede Portierung ist ein Eins-zu-eins-Vergleich zweier Dateien.

---

## 3. Technologie-Entscheidungen

| Aufgabe | Heute | Neu | Begründung |
| :--- | :--- | :--- | :--- |
| Shell | Electron 3x | **Tauri 2** | gesetzt |
| Async-Laufzeit | libuv | **Tokio** (über `tauri::async_runtime`) | Tauri bringt es mit |
| Subprozess | `child_process` | **`tokio::process::Command`** | zeilenweises Lesen über `BufReader::lines()` |
| JSON-RPC | `@agentclientprotocol/sdk` | **`agent-client-protocol` (Crate) prüfen**, sonst eigener Client | *Erste Aufgabe in Meilenstein 2: Eignung des Crates verifizieren.* Fällt es aus, ist der Client mit `serde_json` in ~600 Zeilen selbst gebaut |
| Datenbank | `better-sqlite3` | **`rusqlite`** mit `bundled` | SQLite ist synchron; `rusqlite` hinter `spawn_blocking` ist schlanker und schneller als `sqlx` für lokale Desktop-Zugriffe. `bundled` vermeidet Systemabhängigkeiten. WAL aktivieren, ein Schreiber, Lese-Pool |
| Migrationen | eigenes Framework | **`rusqlite_migration`** oder 30 Zeilen selbst | Bei einem einzigen Startschema kaum relevant — aber von Beginn an vorsehen |
| Git | Git-CLI + Parser | **Git-CLI + portierter Parser** | **Nicht `git2`.** Die App bietet „Git-Binary wählen" als Einstellung an (`settings:choose-git-binary`); libgit2 würde diese Funktion bedeutungslos machen und bei Worktrees, Sparse-Checkout und `.gitignore`-Feinheiten abweichen. Der Parser wird 1:1 portiert |
| Gemini-Binary | konfigurierbar | **unverändert konfigurierbar** | gleiches Argument |
| HTTP | `fetch` | **`reqwest`** (`json`, `rustls-tls`) | `rustls` statt OpenSSL spart Systemabhängigkeiten |
| Verschlüsselung | `safeStorage` | **`keyring` + `aes-gcm`** | Schlüssel im OS-Depot, Nutzdaten in der DB |
| HTML/OpenGraph | Regex | **`scraper`** | |
| PDF-Text | `pdfjs-dist` | **`pdfium-render`** (Bibliothek mitliefern) | ⚠️ Siehe 3.1 — einziger Punkt mit Qualitätsrisiko |
| DOCX-Text | — | **`zip` + `quick-xml`** über `word/document.xml` | `docx-rs` ist auf Schreiben ausgelegt; direktes Parsen ist hier einfacher und robuster |
| Validierung | Zod | **Serde + `garde`/`validator`** | Siehe Abschnitt 7 |
| Fehler | Error-Klassen | **`thiserror`** im Backend, `anyhow` nur an den Rändern | |
| Frontend | React 19 | **SolidJS 1.9+** | gesetzt |
| Markdown | `react-markdown` + `remark-gfm` | **`markdown-it`** mit `html: false` | Siehe 5.3 |
| Build | Electron Forge + Vite | **`cargo tauri build`** + Vite (`vite-plugin-solid`) | |
| Tests | vitest, Testing Library, Playwright | **`cargo test`** + vitest + `@solidjs/testing-library` + Playwright | |

### 3.1 Der eine Punkt mit Qualitätsrisiko: PDF-Extraktion

`pdfjs-dist` ist die Referenzimplementierung für PDF-Textextraktion; die Rust-Alternativen sind schwächer. `pdf-extract` scheitert an vielen realen Dokumenten. **`pdfium-render`** bindet Googles PDFium und kommt qualitativ am nächsten, verlangt aber, dass die PDFium-Bibliothek pro Plattform mitgeliefert wird (~4 MB je Ziel).

**Entscheidung:** `pdfium-render` mit gebundelter Bibliothek. **Rückfallebene**, falls die Qualität in Meilenstein 5 nicht überzeugt: ein Node-Sidecar ausschließlich für die Extraktion (Tauri unterstützt Sidecar-Binaries nativ). Das wäre kein Rückschritt — heute läuft die Extraktion ohnehin in einem separaten `utilityProcess`.

Diese Entscheidung wird an einem Korpus echter PDFs gemessen, nicht am Gefühl.

---

## 4. IPC-Oberfläche: 78 Kanäle abbilden

Die heutigen Kanäle zerfallen in drei Klassen, die in Tauri drei verschiedene Werkzeuge bekommen:

### 4.1 Anfrage/Antwort → `#[tauri::command]`

Rund 60 der 78 Kanäle sind klassisches Request/Response (`projects:*`, `sessions:*`, `git:get-*`, `gitlab:*`, `context-attachments:*`, `settings:*`). Direkte Abbildung:

```rust
#[tauri::command]
async fn send_prompt(
    state: tauri::State<'_, AppState>,
    input: SendPromptInput,
) -> Result<SendPromptResult, AppError> { … }
```

Namenskonvention: `domain:verb-objekt` → `domain_verb_objekt` (`gitlab:select-merge-request` → `gitlab_select_merge_request`). Eine Umbenennungstabelle wird beim Portieren gepflegt, damit nichts stillschweigend verlorengeht.

### 4.2 Hochfrequentes Streaming → **`tauri::ipc::Channel`**

Für `events:session-batch` (die Gemini-Deltas) **keine** globalen Events verwenden. `Channel<T>` ist der richtige Primitive: geordnet, pro Abonnent, deutlich weniger Overhead als `emit`, und der Lebenszyklus hängt am Aufrufer.

```rust
#[tauri::command]
async fn subscribe_session_events(
    state: tauri::State<'_, AppState>,
    session_id: String,
    after_seq: i64,
    on_batch: tauri::ipc::Channel<EventBatch>,
) -> Result<(), AppError> { … }
```

**Die Ereignis-Pufferung des heutigen `AppController.#queueEvent` wird mitportiert:** 32-ms-Fenster, Verschmelzen aufeinanderfolgender Deltas derselben Nachricht bis 100.000 Zeichen. Das ist bereits eine gute Optimierung und darf nicht verlorengehen. In Rust sitzt sie hinter einem `tokio::sync::mpsc` mit `tokio::time::interval`.

Gleiches Muster für `git:project-status-changed`, `context-attachments:changed`, `gitlab:review-state-changed`.

### 4.3 Binärdaten → `tauri::ipc::Response`

`attachments:get-preview` und `context-attachments:get-bytes` liefern Rohbytes. In Tauri über `tauri::ipc::Response::new(Vec<u8>)` zurückgeben — das umgeht die JSON-Serialisierung und die Base64-Aufblähung vollständig. Im Frontend als `ArrayBuffer` entgegennehmen und wie heute in ein `Blob` verpacken.

### 4.4 Typgenerierung statt Handarbeit

Damit die 2.879 Zeilen Zod-Contracts nicht doppelt gepflegt werden: **`ts-rs`** oder **`specta` + `tauri-specta`** auf den Rust-Typen. `tauri-specta` generiert zusätzlich typisierte `invoke`-Wrapper für das Frontend — das ersetzt die heutige `window.gemUi`-Fassade vollständig und typsicher.

**Entscheidung: `tauri-specta`.** Die generierte Datei landet unter `src/types/bindings.ts` und wird eingecheckt.

### 4.5 Was ersatzlos entfällt

* `src/preload/` — Tauri braucht keine Bridge.
* `src/main/security/ipc-guard.ts` — die Sender-Verifikation übernimmt Tauris Capability-System (Abschnitt 7).

---

## 5. Frontend: React 19 → SolidJS bei identischem Erscheinungsbild

### 5.1 Was unverändert bleibt

* **`src/renderer/styles/app.css` wird byteweise übernommen.** Alle Klassennamen, Design-Tokens, Panel-Layouts, Dialoge und Animationen bleiben. Das ist die Garantie für „1:1 gleiches Look and Feel".
* **`components/Icon.tsx`** (328 Zeilen reines SVG) — mechanische Umwandlung, keine Logik.
* Die gesamte Ordner- und Komponentenstruktur.

### 5.2 Übersetzungsmuster

| React | SolidJS | Anmerkung |
| :--- | :--- | :--- |
| `useState` | `createSignal` | Aufrufstelle wird zur Funktion: `count` → `count()` |
| `useMemo` | `createMemo` | |
| `useEffect(fn, [deps])` | `createEffect(fn)` | **Kein Dependency-Array** — Solid trackt automatisch. Häufigste Fehlerquelle beim Portieren |
| `useRef` (DOM) | `let el; <div ref={el}>` | |
| `useRef` (Wert) | einfache `let`-Variable | Komponenten laufen nur einmal |
| `useCallback` | entfällt | Funktionen werden nicht neu erzeugt |
| `{cond && <X/>}` | `<Show when={cond()}>` | |
| `{a ? <X/> : <Y/>}` | `<Show when={} fallback={}>` | |
| `list.map(...)` | `<For each={list()}>` | `<For>` bei Objektlisten, `<Index>` bei Primitiven |
| `useReducer` | siehe 5.4 | |
| Props destrukturieren | **nicht destrukturieren** | zerstört die Reaktivität; `props.x` verwenden oder `splitProps` |

### 5.3 Markdown

`react-markdown` hat kein Solid-Gegenstück. Ersatz: **`markdown-it`** mit `{ html: false, linkify: true }` und dem GFM-Plugin für Tabellen/Durchstreichen.

`html: false` entspricht exakt dem heutigen `skipHtml` — eingebettetes HTML wird als Text ausgegeben, nicht gerendert. **Damit ist kein zusätzlicher Sanitizer nötig**, und das Sicherheitsverhalten bleibt identisch. Links werden wie heute über einen Klick-Handler abgefangen und an `openExternalHttpsUrl` weitergereicht.

Gerendert wird über `innerHTML` in einem memoisierten Container — bei Solid bedeutet das: die Markdown-Umwandlung läuft nur, wenn sich der Text tatsächlich ändert, und nur für die betroffene Nachricht.

### 5.4 Der Timeline-Reducer — der eleganteste Teil der Migration

`features/chat/reducer.ts` (580 Zeilen) ist eine **reine Funktion** `(state, action) => state`. Sie muss **nicht umgeschrieben werden.** Solid bietet dafür genau das passende Werkzeug:

```ts
import { createStore, reconcile } from "solid-js/store";

const [state, setState] = createStore<ChatState>(initialChatState);

function dispatch(action: ChatAction) {
  setState(reconcile(chatReducer(state, action), { key: "id", merge: false }));
}
```

`reconcile` vergleicht das Ergebnis mit dem bestehenden Store und schreibt **nur die tatsächlich veränderten Pfade** zurück. Beim Streaming heißt das konkret: es ändert sich der Textknoten *einer* Nachricht — und nichts sonst wird angefasst. Kein `memo`, keine manuellen Vergleichsfunktionen, kein Virtualisierungszwang.

Der Reducer wird damit zeilenweise übernommen. Nur die Typimporte wechseln von `src/shared/contracts` auf die generierten Bindings.

### 5.5 Drag & Drop — der eine echte Fallstrick

Heute liefert `webUtils.getPathForFile(file)` im Preload den absoluten Pfad einer hineingezogenen Datei. Tauri löst das anders, und die Falle ist wichtig:

* Tauri fängt Datei-Drops **nativ** ab (`tauri://drag-drop`) und liefert absolute Pfade — genau das, was der Kontext-Anhang-Pfad braucht.
* **Solange das aktiv ist, erreichen HTML5-`ondrop`-Ereignisse den Webview nicht.** Die heutigen Drop-Zonen in `AttachmentsPanel` und `Composer` funktionieren so nicht mehr.

**Lösung:** Native Drag-&-Drop-Verarbeitung beibehalten (die Pfade werden gebraucht) und die visuelle Rückmeldung umbauen: Die Ereignisse `tauri://drag-enter`, `tauri://drag-over` und `tauri://drag-leave` liefern Cursor-Koordinaten. Ein kleiner Dienst im Frontend ermittelt daraus per `document.elementFromPoint()` die getroffene Drop-Zone und setzt denselben Zustand, den heute `setDragScope` setzt. Das Verhalten für den Nutzer bleibt identisch — Hervorhebung der Zone, Ablegen, Zuordnung zu Projekt oder Session.

Der Einfüge-Pfad (`onPaste` mit `clipboardData.files`) bleibt unverändert; dort gibt es keine Pfade und der Inhalt kommt als Bytes.

### 5.6 Weitere plattformabhängige Stellen

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

## 6. Link-Live-Vorschau über Multi-Webview

Das aufwendigste Einzelfeature. Heute: Electron-`BrowserView` mit eigener persistenter Partition, damit Nutzer sich in der Vorschau anmelden können (das UI bietet dazu „Angemeldete Sitzungen löschen").

**Umsetzung in Tauri 2** — als eigenständiges Modul `links/preview.rs`, bewusst gekapselt:

* Ein **zweiter Webview im selben Fenster** über `WindowBuilder::add_child` mit `WebviewBuilder`. Das erfordert das **`unstable`-Feature** von Tauri 2 — bewusst in Kauf genommen und in `Cargo.toml` dokumentiert.
* Die Bounds werden wie heute vom Frontend nachgeführt: `LinkPreviewSurface` misst per `getBoundingClientRect()` und ruft `link_preview_set_bounds`. Dieselbe Komponente, derselbe `ResizeObserver`, dieselbe rAF-Drosselung.
* Persistente Sitzung: eigenes Datenverzeichnis für diesen Webview. „Angemeldete Sitzungen löschen" leert es und lädt neu.
* Eigene Capability-Datei `capabilities/preview.json` **ohne** jeden `invoke`-Zugriff — der Vorschau-Webview darf keine App-Befehle aufrufen. Das ist strenger als heute und kostet nichts.

**Bekanntes Risiko:** Unter Linux/WebKitGTK ist Multi-Webview der wackeligste Teil. Deshalb liegt die gesamte Steuerung hinter einem Trait `PreviewSurface`, sodass eine Rückfallebene (eigenes Fenster statt eingebettetem Child-Webview) ohne Änderung am Frontend nachgerüstet werden kann.

**Definition of Done:** Vorschau öffnet sich, folgt beim Scrollen und Größenändern verzögerungsfrei, Login bleibt über App-Neustarts erhalten, „Sitzungen löschen" wirkt — auf allen drei Plattformen.

---

## 7. Sicherheit: die Zod-Schicht darf nicht verlorengehen

Heute validiert `registerValidatedIpcHandler` **Ein- und Ausgabe** jedes IPC-Aufrufs gegen Zod-Schemas. Das ist in diesem Projekt nachweislich wertvoll: mehrfach hat ein einzelner unerwarteter Wert aus der GitLab-API (`line_range.type = "expanded"`, leere SHAs, relative Avatar-URLs) Fehler früh und an der richtigen Stelle sichtbar gemacht.

Beim Übergang zu Serde ändert sich das Verhalten in beide Richtungen und muss bewusst nachgebaut werden:

1. **Eingaben:** Serde erzwingt Typen, aber keine Wertebereiche. Längen-, Bereichs- und Formatgrenzen (`max(200)`, `z.url()`, `Sha256Schema`) über **`garde`** oder **`validator`** als Ableitungsmakros nachziehen. Unbekannte Felder mit `#[serde(deny_unknown_fields)]` ablehnen — das ist das Gegenstück zu `.strict()`.
2. **Externe Antworten (GitLab, OpenGraph, Gemini):** Hier gilt das Umgekehrte. **Bewusst tolerant deserialisieren** — `#[serde(other)]` für unbekannte Enum-Varianten, `Option<T>` statt Pflichtfeldern, `#[serde(default)]`. Ein einzelner unerwarteter Wert darf niemals eine ganze Liste unbrauchbar machen. Diese Lektion ist teuer bezahlt und muss in die Rust-Typen einfließen.
3. **Capabilities statt IPC-Guard:** Der heutige `ipc-guard.ts` prüft, dass IPC-Aufrufe vom Hauptfenster stammen. In Tauri übernimmt das `capabilities/main.json` deklarativ — Fenster für Fenster, Befehl für Befehl. Der Vorschau-Webview bekommt eine eigene, leere Capability.
4. **CSP** in `tauri.conf.json` streng setzen; die App lädt keine externen Ressourcen.

---

## 8. Build, Signierung, Auslieferung

* **CI:** GitHub Actions, Matrix über `macos-latest` (arm64 + x64), `windows-latest`, `ubuntu-22.04`. Rust-Cache über `Swatinem/rust-cache`, sonst dauert jeder Lauf voll durch.
* **Buildzeit:** realistisch 8–15 Minuten pro Release-Matrix. Mit Cache bei Folgebuilds deutlich weniger.
* **Signierung:** macOS-Notarisierung bleibt wie gehabt Pflicht. Windows-Signierung wie bisher.
* **Updater:** `tauri-plugin-updater` löst die heutige Eigenbau-Prüfung in `src/main/updates/` ab. Braucht ein Signaturschlüsselpaar (privater Schlüssel als CI-Secret) und ein `latest.json`. **GitHub Releases bleibt die Bezugsquelle** — der bestehende Release-Workflow wird nur um die Manifest-Erzeugung erweitert.
* **WebView2 unter Windows:** Der Installer bleibt klein, setzt aber die WebView2-Runtime voraus. In `tauri.conf.json` den Bootstrapper-Modus wählen (`downloadBootstrapper`), damit auf Systemen ohne Runtime automatisch nachinstalliert wird.

---

## 9. Reihenfolge: sieben Meilensteine

Die Reihenfolge ist so gewählt, dass das **Risikoreichste zuerst bewiesen** wird und ab Meilenstein 2 durchgehend eine startbare App existiert.

### M1 — Gerüst und Durchstich *(≈ 1 Woche)*
Tauri-2-Projekt, SolidJS + Vite, `app.css` übernommen, `Icon.tsx` portiert, `tauri-specta` eingerichtet, `rusqlite` mit konsolidiertem Schema v1, Fensterrahmen mit Sidebar-Layout.
**Fertig, wenn:** die App startet, das Fenster aussieht wie heute (leerer Zustand), ein Dummy-Command über generierte Typen erfolgreich aufgerufen wird.

### M2 — ACP-Engine *(≈ 2–3 Wochen — der harte Kern)*
Zuerst: Eignung des Crates `agent-client-protocol` prüfen, sonst eigener JSON-RPC-Client. Dann Subprozess, NDJSON-Zeilenguard, Event-Normalisierung, Permission-Broker über `oneshot`, Session-Lebenszyklus inklusive Resume und komprimierter Historie, Ereignis-Pufferung (32 ms + Delta-Verschmelzung), Auslieferung über `tauri::ipc::Channel`.
**Fertig, wenn:** ein Prompt gesendet wird, Text streamt, eine Werkzeug-Freigabe im UI erscheint und beantwortet werden kann, und ein Reconnect die Historie korrekt wiederherstellt.

### M3 — Persistenz und Projekte *(≈ 1,5 Wochen)*
Alle 10 Repositories, Idempotenz über `client_requests`, Projekte mit Roots und Reautorisierung, Freigabe-Policies, Einstellungen inklusive Binary-Auswahl, Token-Nutzungsaggregation.
**Fertig, wenn:** Projekte und Sessions überleben einen Neustart und die Sidebar verhält sich identisch zu heute.

### M4 — Frontend-Portierung *(≈ 2–3 Wochen, parallel ab M2 möglich)*
Alle 29 Komponenten nach SolidJS. Reihenfolge: `Timeline` + Reducer über `reconcile` → `Composer` → `Sidebar`/`ChatHeader` → Panels → Dialoge. Drag & Drop nach dem Muster aus 5.5. Markdown über `markdown-it`.
**Fertig, wenn:** ein Screenshot-Vergleich gegen die Electron-Version keine sichtbaren Abweichungen zeigt.

### M5 — Git und Kontext-Anhänge *(≈ 2 Wochen)*
porcelain-v2-Parser und Diff-Generator portieren (der virtualisierte Diff-Viewer im Frontend bleibt in seiner Logik unverändert). Blob-Store, Mime-Sniffing, Extraktion inklusive der PDFium-Entscheidung aus 3.1, OpenGraph.
**Fertig, wenn:** Statusanzeige, Inline-Diff-Vorschauen und Anhangs-Extraktion dieselben Ergebnisse liefern wie heute — an echten Repositories und einem PDF-Korpus geprüft.

### M6 — GitLab, Skills, MCP, Updates *(≈ 2 Wochen)*
REST-Client mit **tolerant** deserialisierenden Typen (Abschnitt 7.2), Vault über keyring, Discussion-Mapper, Review-Kontext, Skills-/MCP-Scanner, Update-Prüfung.
**Fertig, wenn:** ein realer Merge Request mit Threads geladen, beantwortet und aufgelöst werden kann.

### M7 — Live-Vorschau, Feinschliff, Auslieferung *(≈ 1,5 Wochen)*
Multi-Webview nach Abschnitt 6, Capabilities scharf stellen, CI-Matrix, Signierung, Updater, plattformübergreifender Abnahmetest.
**Fertig, wenn:** signierte Artefakte für macOS, Windows und Linux aus der CI fallen und die Abnahmeliste aus Abschnitt 10 vollständig grün ist.

**Gesamtaufwand: 12–14 Wochen Vollzeit**, bei paralleler Frontend-Arbeit ab M2 eher am unteren Ende.

---

## 10. Abnahme: 1:1-Parität nachweisen

Ohne Prüfliste wird „1:1" zur Behauptung. Vor der ersten Auslieferung ist jeder Punkt auf allen drei Plattformen abzuhaken:

**Optisch**
- [ ] Screenshot-Vergleich Electron ↔ Tauri für: leerer Zustand, aktive Session mit Streaming, alle fünf Seitenpanels, alle vier Dialoge, Hell- und Dunkelmodus
- [ ] Fenster-Ziehbereiche, Scrollleisten, Fokusringe, Hover-Zustände
- [ ] Alle Animationen und Übergänge (Panel-Einblendung, Dialog-Einflug, Spinner)

**Funktional**
- [ ] Prompt senden, Streaming, Abbrechen, Werkzeug-Freigabe erlauben/ablehnen/dauerhaft
- [ ] Session anlegen, umbenennen, anpinnen, archivieren, löschen, Reconnect mit Historie
- [ ] Projekt anlegen, zusätzliche Ordner, Reautorisierung nach Neustart, Freigabe-Policy
- [ ] Git-Status, Inline-Diff-Vorschauen, Diff-Viewer bei großen Dateien
- [ ] Anhänge: Datei wählen, Drag & Drop in Chat **und** Panel, Einfügen, Link hinzufügen, Herkunftsfilter, Extraktion von PDF/DOCX/Text
- [ ] Link-Live-Vorschau inklusive Login und „Sitzungen löschen"
- [ ] GitLab: Verbindung anlegen und testen, Repository aktivieren, MR wählen, Thread beantworten und auflösen, Kontext an Gemini senden
- [ ] Skills- und MCP-Panel, Update-Prüfung

**Leistung** (Referenz: 4 Kerne, keine dedizierte GPU, 8 GB RAM)
- [ ] Kaltstart bis interaktiv **< 1 s**
- [ ] Erstes Token nach Prompt **< 400 ms**
- [ ] Streaming ≥ **55 fps** in einem Verlauf mit 30+ Nachrichten
- [ ] RAM nach einstündiger Session **< 250 MB**
- [ ] CPU im Leerlauf **< 1 %**

---

## 11. Risiken und wie damit umgegangen wird

| Risiko | Wirkung | Umgang |
| :--- | :--- | :--- |
| **Multi-Webview unter WebKitGTK instabil** | Live-Vorschau unbrauchbar unter Linux | Hinter Trait `PreviewSurface` kapseln; Rückfall auf separates Fenster ohne Frontend-Änderung |
| **PDF-Extraktion schlechter als pdf.js** | Anhänge liefern schlechteren Kontext | Am PDF-Korpus messen (M5); Rückfall auf Node-Sidecar |
| **Kein brauchbares ACP-Crate** | +1 Woche in M2 | Früh prüfen — erste Aufgabe in M2, nicht später |
| **Serde strenger als Zod bei API-Antworten** | Laufzeitfehler bei GitLab-Sonderfällen | Externe Typen konsequent tolerant (7.2); Regressionstests aus den bekannten Fällen übernehmen |
| **WebKit-CSS-Abweichungen (macOS/Linux)** | Optische Unterschiede | Früh testen: bereits ab M1 auf allen drei Plattformen bauen, nicht erst in M7 |
| **`unstable`-Feature von Tauri** | Bruch bei Tauri-Update | Tauri-Version in `Cargo.toml` pinnen; Updates bewusst durchführen |
| **Drag & Drop übersehen** | Kernfunktion fehlt lautlos | In der Abnahmeliste explizit für Chat **und** Panel geführt |

---

## 12. Offene Entscheidungen

Diese Punkte sind vor dem jeweiligen Meilenstein zu klären:

1. **Vor M2:** Eignet sich das Crate `agent-client-protocol`, oder wird der JSON-RPC-Client selbst gebaut?
2. **Vor M5:** Erreicht `pdfium-render` am Prüfkorpus die Qualität von pdf.js — oder kommt der Node-Sidecar?
3. **Vor M7:** Bleibt es beim eingebetteten Child-Webview für die Live-Vorschau, oder wird unter Linux auf ein eigenes Fenster ausgewichen?
4. **Vor M7:** Welche Linux-Pakete werden ausgeliefert (deb, rpm, AppImage — heute deb und rpm)?
