# Git-Diff-Viewer für GeminUI

## Ziel und Interpretation

GeminUI soll bei Projekten, deren Ordner in Git-Worktrees liegen, geänderte Dateien erkennen und deren Diffs anzeigen. Die Formulierung „den Diff einer Datei ändern“ wird hier als folgende Bedienung interpretiert:

1. Änderungen einer Datei als Diff ansehen.
2. Ganze Dateien oder einzelne Hunks stagen und wieder aus dem Staging-Bereich entfernen.
3. Optional in einer späteren Stufe einzelne unstaged Hunks sicher verwerfen.

Ein frei editierbares Patch-Textfeld ist für die erste Version ausdrücklich nicht vorgesehen. Es wäre fehleranfällig und würde dem kompromittierbaren Renderer ermöglichen, Dateipfade und Patchinhalt vorzugeben. Zeilenweise Auswahl kann später ergänzt werden, sollte aber ebenfalls in Main in einen Patch übersetzt werden.

## Ergebnis der Analyse

Die Funktion lässt sich sauber in die vorhandene Architektur einfügen. Es ist keine Änderung am Gemini-ACP-Protokoll nötig: Der Diff-Viewer arbeitet lokal und unabhängig von einer Gemini-Session. Der richtige Ort ist ein neuer Git-Dienst im Electron-Main-Prozess mit einer kleinen, streng typisierten API im Preload und einem ausklappbaren Changes-Panel im Renderer.

Die wichtigsten Rahmenbedingungen des bestehenden Codes sind:

- `ProjectService.getCurrentAccess()` liefert bereits kanonisierte und vor jedem Zugriff erneut geprüfte Haupt- und Zusatzroots.
- Ein GeminUI-Projekt kann einen Hauptroot und bis zu fünf zusätzliche, voneinander getrennte Roots besitzen.
- Der Renderer ist isoliert und erreicht Main nur über `window.gemUi`; Eingaben und Ausgaben werden in `registerValidatedIpcHandler()` mit Zod validiert.
- IPC-Aufrufe werden bereits auf das Hauptfenster, dessen Main Frame und die vertrauenswürdige App-URL beschränkt.
- Mutierende Aufrufe verwenden bereits `clientRequestId` und `ClientRequestRepository` für Idempotenz.
- Es gibt bisher weder eine Git-Abhängigkeit noch Git-Erkennung, Git-Status, Dateiwatching oder einen Diff-Parser.
- `runCapturedCommand()` startet Prozesse korrekt ohne Shell und mit begrenzter Ausgabe, eignet sich aber nicht unverändert für Diffs: `BoundedTextBuffer` behält beim Überschreiten des Limits nur das Ende. Ein abgeschnittener Patch darf niemals angezeigt oder angewendet werden.

## Empfohlene Architektur

### Neue Main-Komponenten

Unter `src/main/git/` sollten klar getrennte Bausteine entstehen:

- `git-binary-probe.ts`: findet ein natives Git und prüft `git --version`.
- `git-command-runner.ts`: startet ausschließlich das aufgelöste Git-Executable mit fester Argumentliste, ohne Shell, mit Timeout, Abbruchsignal, Byte-Limit und optionalem kontrollierten `stdin` für `git apply`.
- `repository-discovery.ts`: ordnet jeden autorisierten Projektroot höchstens einem Git-Worktree zu.
- `porcelain-v2-parser.ts`: parst den NUL-separierten Git-Status vollständig.
- `unified-diff-parser.ts`: zerlegt einen Patch in Dateien, Metadaten, Hunks und darstellbare Zeilen.
- `git-status-service.ts`: erzeugt den Projektstatus und gruppiert ihn nach Repository und Root.
- `git-diff-service.ts`: erzeugt Diffs für staged, unstaged und untracked Dateien.
- `git-snapshot-store.ts`: hält kurzlebige, opake Diff-Snapshots und deren unveränderte Rohpatches nur in Main.
- `git-mutation-service.ts`: führt später Stage-, Unstage- und Discard-Aktionen unter Repository-Lock aus.
- `git-watch-service.ts`: bündelt Refresh-Signale, Polling und optionale Dateisystem-Events.

`GitService` kann diese Komponenten für `registerAppIpc()` zusammenfassen. Er wird in `src/main/index.ts` neben `ProjectService` erzeugt und beim Beenden zuverlässig disposed.

### Warum die native Git-CLI empfohlen wird

Die Git-CLI ist die Referenzimplementierung für Index, Worktrees, Renames, Submodule, `.gitattributes`, Dateimodi, Konflikte und Linked Worktrees. Eine reine JavaScript-Implementierung würde für einen scheinbar einfachen Viewer wesentliche Git-Semantik nachbauen und bei realen Repositories schneller abweichen.

Git ist trotzdem als optionale Capability zu behandeln. Fehlt Git, bleibt Chat/Gemini voll funktionsfähig und das Changes-Panel zeigt eine verständliche Installations- oder Auswahlmöglichkeit. Es darf weder ein Paketmanager gestartet noch Git automatisch installiert werden.

## Git-Binary erkennen

Die Erkennung kann sich konzeptionell an `src/main/gemini/binary-probe.ts` orientieren, muss aber separat bleiben:

- Zuerst `PATH`/`Path` aus der Desktop-App-Umgebung prüfen.
- macOS zusätzlich mindestens `/usr/bin/git`, `/opt/homebrew/bin/git` und `/usr/local/bin/git` prüfen.
- Windows zusätzlich typische native Git-for-Windows-Pfade wie `%ProgramFiles%\Git\cmd\git.exe`, `%ProgramFiles%\Git\bin\git.exe` und passende `%LOCALAPPDATA%`-Installationen prüfen.
- Einen manuell gewählten absoluten Pfad zulassen und kanonisieren.
- Nur eine echte ausführbare Datei akzeptieren, dann `git --version` mit kurzem Timeout ausführen.
- Auf Windows ausschließlich `git.exe` direkt starten; niemals `cmd.exe`, PowerShell oder `shell: true` benutzen.
- WSL-Git gehört nicht in die erste Version, da seine Pfade nicht ohne Weiteres den nativen Windows-Projektpfaden entsprechen.

Die Capability sollte Version und Verfügbarkeit enthalten, zum Beispiel `git.available`, `git.binaryPath` und `git.version`. Sie ist unabhängig von `capabilities.gemini`.

## Repository-Erkennung und Multi-Root-Verhalten

### Ein Git-Kontext pro Projektroot

Jeder Root aus `ProjectService.getCurrentAccess(projectId)` wird unabhängig untersucht. Ein GeminUI-Projekt kann damit gleichzeitig enthalten:

- zwei Roots in zwei unabhängigen Repositories,
- einen Git-Root und einen normalen Ordner,
- mehrere normale Ordner ohne Git,
- mehrere Roots, die versehentlich zum selben Worktree gehören.

Der Main-Prozess führt pro Root sinngemäß diese read-only Abfragen aus:

```text
git -C <root.realPath> rev-parse --is-inside-work-tree
git -C <root.realPath> rev-parse --show-toplevel
git -C <root.realPath> rev-parse --absolute-git-dir
git -C <root.realPath> rev-parse --git-common-dir
```

Bare Repositories werden für den Arbeitskopie-Diff nicht unterstützt. Linked Worktrees und eine `.git`-Datei statt eines `.git`-Ordners werden unterstützt, weil die Pfade von Git selbst ermittelt werden und nicht durch direktes Parsen von `.git`.

### Autoritätsgrenze

Der von Git gemeldete Worktree-Toplevel muss innerhalb des ausgewählten und erneut validierten Projektroots liegen oder genau diesem entsprechen. Meldet Git einen Toplevel oberhalb des gewählten Roots, darf GeminUI nicht einfach Zugriff auf das Elternverzeichnis ableiten. Die UI zeigt dann:

> Der ausgewählte Ordner liegt in einem größeren Git-Repository. Füge den Repository-Hauptordner als Projektroot hinzu, um alle Änderungen sicher anzuzeigen.

Da GeminUI verschachtelte Roots absichtlich verbietet, ist in diesem Fall normalerweise der Repository-Toplevel statt mehrerer Unterordner auszuwählen. Das verhindert, dass ein Renderer oder ein manipuliertes Repository Git zum Lesen oder Ändern von Dateien außerhalb der erteilten Projektfreigabe verwendet.

Repositories werden anhand der kanonischen Kombination aus Worktree-Toplevel und absolutem Git-Dir dedupliziert. Zwei Projektroots dürfen nicht zu doppelten Panels oder doppelten Watchern für denselben Worktree führen. Die Zuordnung zu allen beteiligten `rootId`s bleibt für die Anzeige erhalten.

### Keine rekursive Repository-Suche in Version 1

Version 1 sollte nur das Repository erkennen, in dem der jeweilige Projektroot selbst liegt. Eine rekursive Suche nach beliebigen `.git`-Ordnern unterhalb eines Roots ist teuer, erzeugt unklare Sicherheitsgrenzen und findet unter Umständen `node_modules`, Fixtures oder eingebettete Fremdrepositories. Submodule erscheinen zunächst als Git-Status-Einträge. Soll ein Submodule einen eigenen vollständigen Viewer erhalten, kann sein Ordner ausdrücklich als separater GeminUI-Root verwendet werden, sofern die Root-Regeln das zulassen.

## Statusmodell

### Kanonische Quelle

Der Status sollte maschinenlesbar und unabhängig von Sprache oder Benutzerformatierung abgefragt werden:

```text
git -c color.ui=false -c core.quotepath=false \
  -C <worktree> status --porcelain=v2 -z --branch \
  --untracked-files=all --ignore-submodules=none
```

`--porcelain=v2 -z` ist entscheidend. Dateinamen können Leerzeichen, Tabs oder sogar Zeilenumbrüche enthalten und dürfen nicht zeilenweise oder mit regulären Ausdrücken aus der menschenlesbaren Ausgabe geparst werden.

Der Parser muss mindestens verstehen:

| Record | Bedeutung | Darstellung |
| --- | --- | --- |
| `1` | normale tracked Änderung | Index- und Worktree-Code getrennt aus `XY` |
| `2` | Rename oder Copy | alter und neuer Pfad sowie Score |
| `u` | unmerged/conflict | eigener Konfliktbereich, keine Hunk-Mutation |
| `?` | untracked | eigener Bereich, vollständig unstaged |
| `#` | Branch-/HEAD-Metadaten | Branch, detached HEAD, upstream, ahead/behind |

Ein Eintrag kann gleichzeitig staged und unstaged sein, zum Beispiel `MM`. Er muss dann in beiden logischen Ansichten auftauchen; ein einzelnes vereinfachtes `modified`-Flag reicht nicht.

### Empfohlene Contracts

Die Shared Contracts sollten unter `src/shared/contracts/git.ts` liegen. Sinnvolle Kernobjekte sind:

```ts
type GitRepositorySummary = {
  repositoryId: string;      // opak, von Main erzeugt
  rootIds: string[];
  displayName: string;
  worktreeLabel: string;     // kein frei nutzbarer absoluter Pfad
  branch: string | null;
  headOid: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  state: "ready" | "not_git" | "outside_authority" | "unavailable" | "error";
};

type GitFileChange = {
  fileId: string;            // opak und an einen Snapshot gebunden
  repositoryId: string;
  path: string;              // Repo-relativ, nur zur Anzeige
  previousPath: string | null;
  indexStatus: string;
  worktreeStatus: string;
  conflict: boolean;
  untracked: boolean;
  submodule: boolean;
};
```

Absolute Pfade müssen nicht an den Renderer gehen. Wenn sie für eine optionale Anzeige gewünscht sind, bleiben sie reine Ausgabe; kein späterer Schreibaufruf darf sie als Autorität zurücknehmen.

## Diff-Erzeugung

### Getrennte Diff-Basen

Die UI braucht mindestens zwei explizite Ansichten:

| Ansicht | Bedeutung | Git-Basis |
| --- | --- | --- |
| Arbeitskopie | noch nicht gestagte Änderungen | Index → Worktree |
| Vorgemerkt | gestagte Änderungen | `HEAD` → Index |

Die entsprechenden Befehle sind sinngemäß:

```text
git -C <worktree> diff --patch --no-color --no-ext-diff --no-textconv \
  --unified=3 --find-renames -- <von Main bestimmte Pfade>

git -C <worktree> diff --cached --patch --no-color --no-ext-diff \
  --no-textconv --unified=3 --find-renames -- <von Main bestimmte Pfade>
```

Für einen Rename müssen alter und neuer Pfad aus dem zuvor geparsten Status berücksichtigt werden. Für untracked Textdateien kann Main nach einer Größenprüfung einen synthetischen New-File-Patch erzeugen oder `git diff --no-index` gegen eine kontrollierte leere temporäre Datei verwenden. Bei `--no-index` bedeutet Exit-Code `1` „Unterschied gefunden“ und ist kein Fehler. Die Ausgabeheader müssen anschließend normalisiert werden; temporäre App-Pfade dürfen nicht im Renderer erscheinen.

Bei einem Repository ohne ersten Commit muss staged Inhalt gegen einen leeren Baum funktionieren. Dieser Unborn-HEAD-Fall benötigt einen eigenen Integrationstest und darf nicht davon ausgehen, dass `HEAD` existiert.

### Diff-Sicherheit und Limits

Für Git-Diffs ist ein neuer Runner nötig:

- Ausgabe als rohe Bytes vollständig erfassen.
- Bei Überschreiten des Limits abbrechen und `too_large` melden, nicht den Anfang oder das Ende abschneiden.
- `stdout` und `stderr` getrennt begrenzen.
- Standardlimit beispielsweise 5 MiB pro Datei und 10 MiB pro Antwort; Werte als Konstanten und in Zod spiegeln.
- Prozess-Timeout und AbortController beim Projekt-/Dateiwechsel.
- Kein Pager, keine Prompts und keine interaktiven Credentials: `GIT_PAGER=cat`, `PAGER=cat`, `GIT_TERMINAL_PROMPT=0`.
- Für reine Statusabfragen `GIT_OPTIONAL_LOCKS=0`, damit keine unnötigen Index-Locks oder Refresh-Schreibvorgänge entstehen.
- Niemals Shell, Git-Aliase oder einen vom Renderer bestimmten Subcommand verwenden.
- `--no-ext-diff` und `--no-textconv` setzen, damit Repository-Konfiguration keine externen Diffprogramme oder Textkonverter startet.

Der vorhandene `runCapturedCommand()` kann für `git --version` und kleine Discovery-Abfragen wiederverwendet werden. Für Patchdaten ist er wegen der Tail-Trunkierung und des ignorierten `stdin` ungeeignet.

### Unified-Diff-Parser

Der Parser erhält die vollständigen Rohbytes und erzeugt reine Daten:

- Dateiheader und Modusänderung,
- alter und neuer Pfad,
- Rename/Copy-Metadaten,
- Binärmarker,
- Hunks mit stabilem Hunk-ID,
- Zeilenart `context`, `addition`, `deletion` und `no_newline`,
- alte und neue Zeilennummern.

Die Renderer-Darstellung nutzt React-Textknoten, niemals `dangerouslySetInnerHTML`. Der für eine Mutation verwendete Rohpatch bleibt ausschließlich im Main-Snapshot; der Renderer erhält nur darstellbare Zeilen und opake IDs.

### Sonderfälle

- **Binary:** Status und Dateigröße anzeigen, aber keinen Textdiff vortäuschen. Whole-file Stage/Unstage kann später separat unterstützt werden.
- **Rename/Copy:** `alter/pfad → neuer/pfad`, Score und Änderungen zeigen. Partielles Staging eines Renames zunächst deaktivieren; ganzes Stage/Unstage ist eindeutig.
- **Delete/Add:** korrekte `/dev/null`-Semantik und Dateimodus anzeigen.
- **Konflikt:** als unmerged kennzeichnen. Keine normalen Stage-/Discard-Hunk-Aktionen anbieten, bis der Konflikt im Worktree aufgelöst ist.
- **Submodule:** alten/neuen Commit und Dirty-State darstellen; kein Textdiff des enthaltenen Repositories in Version 1.
- **Symlink:** tracked Symlinkdiff als Linkinhalt behandeln. Bei untracked Symlinks niemals das Ziel außerhalb des Roots lesen; `lstat` verwenden und nur Metadaten beziehungsweise das Linkziel als Linktext zeigen.
- **Große Datei:** Metadaten und „Diff zu groß“ anzeigen; kein partieller, potenziell irreführender Patch.
- **Dateiname mit Sonderzeichen:** Status über NUL-Records, Mutation nur über opake IDs und Originalbytes aus Main.
- **CRLF:** Patchbytes niemals im Renderer oder durch JavaScript-Zeilenumbruch-Normalisierung für die Mutation rekonstruieren.

## Sichere IPC-Oberfläche

Sinnvolle neue Channels sind:

- `git:list-project-repositories`
- `git:get-project-status`
- `git:get-file-diff`
- `git:subscribe-project-status`
- `git:unsubscribe-project-status`
- später `git:apply-selection`

Beispiel für eine Leseanfrage:

```ts
{
  projectId: EntityId;
  expectedRootRevision: number;
  repositoryId: OpaqueId;
  fileId: OpaqueId;
  area: "unstaged" | "staged";
}
```

Beispiel für eine Mutation:

```ts
{
  clientRequestId: ClientRequestId;
  projectId: EntityId;
  expectedRootRevision: number;
  snapshotId: OpaqueId;
  fileId: OpaqueId;
  hunkIds: OpaqueId[];
  operation: "stage" | "unstage" | "discard_worktree";
}
```

Nicht erlaubt sind vom Renderer gelieferte absolute Pfade, Git-Argumente, Revisionsausdrücke, Pathspec-Magie oder freier Patchtext. Main löst IDs aus einem Snapshot auf, der an Projekt, Rootrevision, Repository und BrowserWindow gebunden ist. Arrays, Stringlängen, Anzahl Hunks und Antwortgrößen erhalten enge Zod-Limits.

Die neue API wird wie die bestehenden APIs in `GemUiDesktopApi`, `IPC_CHANNELS`, `IpcRequestSchemas`, `IpcResponseSchemas`, `src/preload/index.ts` und `src/renderer/global.d.ts` ergänzt und eingefroren. Alle Handler laufen weiter durch `registerValidatedIpcHandler()` und `assertTrustedIpcSender()`.

## Sichere Stage-/Unstage-/Apply-Strategie

### Snapshot und Compare-and-Swap

Beim Öffnen eines Diffs erzeugt Main einen kurzlebigen Snapshot mit:

- Projekt-ID und `rootRevision`,
- Repository-Identität,
- HEAD-OID beziehungsweise Unborn-HEAD-Marker,
- vollständigem Statusrecord der Datei,
- Hash der exakten Rohdiffbytes,
- Hauptdaten der Datei beziehungsweise des Indexzustands,
- Rohpatch und Zuordnung von Hunk-IDs.

Vor jeder Mutation muss Main:

1. `ProjectService.getCurrentAccess()` erneut ausführen.
2. Gleiche Rootrevision und Repository-Identität prüfen.
3. Unter einem Mutex pro Worktree den Status und den betroffenen Diff neu erzeugen.
4. Den neuen Hash mit dem Snapshot vergleichen.
5. Bei Abweichung ohne Änderung abbrechen und „Datei wurde inzwischen geändert – Diff neu laden“ zurückgeben.
6. Aus den in Main gespeicherten Daten einen Patch nur für die ausgewählten vollständigen Hunks erzeugen.
7. Zuerst `git apply --check` mit exakt denselben Zieloptionen ausführen.
8. Erst danach den Patch über kontrolliertes `stdin` anwenden und sofort einen neuen Status liefern.

Für ausgewählte Hunks müssen die Dateiheader erhalten bleiben; Hunk-Zähler können mit `--recount` neu berechnet werden. Es sollten volle Hunks mit mindestens dem von Git gelieferten Kontext genutzt werden. `--unsafe-paths`, `--reject`, automatische 3-Way-Merges und lockeres Whitespace-Matching sind zu vermeiden.

### Stage und Unstage

- **Stage Hunk:** Patch aus Index → Worktree mit `git apply --cached --check`, danach `git apply --cached`.
- **Unstage Hunk:** Patch aus HEAD → Index umgekehrt mit `git apply --cached --reverse --check`, danach die entsprechende Reverse-Anwendung.
- **Stage untracked Textdatei:** von Main erzeugter vollständiger New-File-Patch kann mit `--cached` in den Index übernommen werden.
- **Whole-file Rename/Binary/Submodule:** zunächst nur als explizite Sonderaktion. `git add -- <path>` ist semantisch korrekt, kann aber konfigurierte Clean-/LFS-Filter starten. Das muss als bewusste, vom Benutzer ausgelöste Aktion im Threat Model dokumentiert werden. Alternativen über `hash-object --no-filters` und `update-index` vermeiden Fremdprozesse, würden jedoch Filter-/LFS-Semantik umgehen.

`git apply` führt keine Git-Hooks aus und ist deshalb für Text-Hunks besser kontrollierbar als eine Folge frei konfigurierbarer Git-Kommandos. Indexänderungen profitieren zusätzlich vom Git-eigenen Index-Lock.

### Unstaged Änderungen verwerfen

Das Verwerfen verändert Benutzerdateien und gehört nicht in das erste read-only Release. Für eine spätere Stufe gelten zusätzliche Regeln:

- eigene, deutlich rote Aktion mit Bestätigung und genauer Hunk-/Dateiangabe,
- vorab ein App-internes Backup unter `userData` mit Ablaufzeit und „Rückgängig“-Möglichkeit,
- Reverse-Patch nur für genau eine vom Main-Snapshot bekannte Datei,
- erneute Hashprüfung unmittelbar vor Anwendung,
- keine `git reset --hard`, kein rekursives Restore und kein `rm`,
- untracked Dateien über eine wiederherstellbare App-Ablage oder `shell.trashItem()` entfernen, niemals direkt endgültig löschen,
- Konflikte, Binary, Rename und Modusänderungen im ersten Discard-Release nicht partiell verwerfen.

Ein externer Gemini-Prozess oder Editor kann weiterhin zwischen Prüfung und Schreibzugriff ändern. Git-Kontextprüfung, der Worktree-Mutex und ein Ein-Datei-Patch minimieren das Rennen, können externe Prozesse aber nicht sperren. Darum sind Backup, unmittelbare Nachprüfung und eine verständliche Stale-Snapshot-Fehlermeldung zwingend.

## Renderer-UX

### Einbau in das vorhandene Layout

Das jetzige Layout besteht aus Sidebar und `.main-pane`; der Chat selbst hält Header, Banner, Timeline und den dauerhaft sichtbaren Composer in einem Grid. Der Diff-Viewer sollte den Composer nicht verdrängen.

Empfohlen ist ein ein-/ausklappbares rechtes Changes-Panel innerhalb der Main-Pane:

- Desktop: Chat und Panel als zwei Spalten, Panelbreite etwa 360–520 px und veränderbar.
- Kleine Fenster: Panel als Overlay/Drawer.
- Mobilbreite: eigene Vollbildansicht mit Zurück-Schaltfläche.
- Toggle im ChatHeader und optional ein Changes-Zähler in der Projekt-Sidebar.
- Panelzustand pro Benutzer speichern; Git-Status selbst nicht in SQLite persistieren.

### Inhalt

1. Kopfzeile mit „Änderungen“, Gesamtanzahl, Refresh und Lade-/Fehlerzustand.
2. Gruppierung zuerst nach Repository/Root, dann nach „Konflikte“, „Vorgemerkt“, „Änderungen“ und „Unversioniert“.
3. Branch, detached HEAD, Upstream sowie Ahead/Behind je Repository.
4. Statusbadges `M`, `A`, `D`, `R`, `C`, `U`, `?`; Index- und Worktree-Zustand visuell getrennt.
5. Klick auf eine Datei öffnet Unified Diff; Split View kann später folgen.
6. Hunkkopf zeigt alte/neue Zeilenbereiche und die erlaubten Aktionen.
7. Binary-, Submodule-, Konflikt- und Too-large-Zustände erhalten eigene erklärende Karten.
8. Während Gemini arbeitet bleibt das Panel sichtbar und markiert eingehende Statusänderungen, ohne die aktuelle Scrollposition sofort zu zerstören.

Für große Diffs ist Zeilenvirtualisierung nötig. Keyboard-Navigation, sichtbarer Fokus, Screenreader-Labels und ausreichender Kontrast gehören in die Akzeptanzkriterien. Difftext wird als Plain Text gerendert, nicht als Markdown oder HTML.

## Refresh und Watching

Ein ausschließlich rekursiver Dateisystem-Watcher ist plattformübergreifend nicht zuverlässig und kann in großen Repositories sehr teuer werden. Empfohlen ist eine hybride Strategie:

- sofortiger Status beim Öffnen des Panels und beim Projektwechsel,
- sofortiger Refresh nach eigener Git-Mutation,
- Refresh nach `turn.completed`, `turn.failed`, `turn.cancelled` und relevanten Tool-Abschlüssen,
- Refresh bei Fensterfokus,
- adaptives Polling nur für sichtbare/abonnierte Repositories, zum Beispiel alle 1–2 Sekunden während eines laufenden Turns und alle 3–5 Sekunden im Idle,
- optional `fs.watch`/Chokidar nur als Debounce-Auslöser; Git-Status bleibt immer die Wahrheitsquelle,
- Ereignisse innerhalb von etwa 250–500 ms zusammenfassen,
- bei transientem `.git/index.lock` kurz verzögert erneut lesen,
- keine Watcher für inaktive Projekte; Deduplizierung pro kanonischem Worktree und Cleanup beim Fenster-/App-Schließen.

Status-Pushes benötigen einen eigenen, nicht persistenten Subscription-Kanal. Der bestehende `SessionEventHub` ist auf Sessionevents und Replay aus SQLite zugeschnitten und sollte nicht mit flüchtigen Dateisystemevents vermischt werden. Der Preload verwaltet Callbacks analog zur Session-Subscription, validiert aber jede Statusnachricht gegen ein enges Schema.

## Windows- und macOS-Aspekte

- Git immer mit `spawn(executable, args, { shell: false })` starten.
- Pfade ausschließlich als einzelne argv-Werte übergeben; keine selbst gebauten Commandstrings.
- Git-intern sind Repositorypfade `/`-separiert, lokale absolute Pfade folgen Node-/OS-Konventionen. Diese Ebenen nicht vermischen.
- Windows-Pfade case-insensitiv kanonisieren wie bereits in `canonicalPathsEqual()`; Repository-relative Git-Pfade trotzdem unverändert behandeln.
- Unicode und ungewöhnliche Dateinamen über NUL-separierte Statusausgabe verarbeiten.
- Windows Long Paths nicht künstlich auf `MAX_PATH` kürzen.
- Prozessabbruch und Timeout auf Windows testen; ein einfacher POSIX-Signalpfad darf nicht vorausgesetzt werden.
- CRLF-, executable-bit- und Symlink-Unterschiede als Git-Semantik darstellen und Rohpatches nicht normalisieren.
- macOS-Projektzugriff vor jedem Git-Aufruf über `ProjectService.getCurrentAccess()` revalidieren; die gerade ergänzte Root-Reauthorization gilt auch für Git.
- Keine Git-Operation soll Netzwerkzugriff benötigen: kein Fetch, Pull, Push, Credential Helper oder LFS-Download im Diff-Viewer.

## Konkrete Änderungen nach Dateien

### Shared und Preload

- Neu: `src/shared/contracts/git.ts` mit allen strikt limitierten Zod-Schemas.
- Ändern: `src/shared/contracts/index.ts` für Exporte.
- Ändern: `src/shared/contracts/ipc.ts` für Channels, Request-/Response-Schemas, Capabilities und `GemUiDesktopApi.git`.
- Ändern: `src/preload/index.ts` für die schmale Git-Bridge und Status-Subscription.
- Ändern: `src/renderer/types.ts` beziehungsweise `global.d.ts` nur über die Shared-Typen.

### Main

- Neu: die Komponenten unter `src/main/git/`.
- Ändern: `src/main/index.ts` zum Erzeugen und Disposen der Git-Dienste.
- Ändern: `src/main/ipc/register-app-ipc.ts` für validierte Git-Handler.
- Optional ändern: `src/main/capability-service.ts`, oder eine separate Git-Capability verwenden und im App-Snapshot zusammenführen.
- Wiederverwenden: `ProjectService.getCurrentAccess()` und die vorhandene Senderprüfung.
- Nicht verwenden für Patches: die Tail-trunkierende Ausgabe von `BoundedTextBuffer`.

### Renderer

- Neu: `src/renderer/features/git/ChangesPanel.tsx`.
- Neu: `RepositoryGroup.tsx`, `ChangeList.tsx`, `DiffViewer.tsx`, `DiffHunk.tsx` und ein kleiner Git-State-Reducer/Hook.
- Ändern: `src/renderer/app/App.tsx` für Panelzustand, Subscription und Projektwechsel.
- Ändern: `ChatHeader.tsx` für Toggle und Zähler.
- Ändern: `app.css` für Desktopspalte, Drawer, Diffzeilen, große Diffs und responsive Zustände.
- Optional ändern: `Icon.tsx` für Git-/Changes-/Branch-Icons.

Es ist keine Datenbankmigration nötig, solange Git-Status, Diffs und Snapshots flüchtig bleiben. Nur eine optionale UI-Präferenz wie Panelbreite oder „Panel geöffnet“ gehört in Settings, nicht der Repositoryzustand.

## Testplan

### Unit-Tests

- Porcelain-v2-Parser für `1`, `2`, `u`, `?`, Branchheader und Submoduleflags.
- Kombinationen wie `MM`, `AM`, `MD`, Rename mit altem/neuem Pfad.
- NUL-getrennte Namen mit Leerzeichen, Tabs, Unicode und Zeilenumbrüchen.
- Unified-Diff-Parser für Add/Delete/Modify/Rename, Dateimodus, `No newline`, mehrere Hunks und Binary.
- Größenlimit bricht vollständig und fail-closed ab; kein abgeschnittener Patch wird zurückgegeben.
- Repository-Deduplizierung und `outside_authority` bei Toplevel oberhalb des Roots.
- Opake IDs können nicht zwischen Projekt, Repository, WebContents oder Snapshot wiederverwendet werden.
- Zod lehnt unbekannte Felder, freie Pfade, Git-Args, Patchtext und zu viele Hunk-IDs ab.
- Staler Snapshot führt zu keiner Mutation.

### Git-Integrationstests in temporären Repositories

- sauberes Repository und Repository ohne Commit,
- unstaged, staged sowie gleichzeitig staged+unstaged,
- untracked, add, delete, rename/copy, executable bit und Binary,
- Konfliktzustand,
- Linked Worktree und optional Submodule,
- Stage/Unstage eines einzelnen von mehreren Hunks,
- Änderung durch einen simulierten externen Prozess zwischen Snapshot und Apply,
- Dateinamen mit Windows-/Unicode-relevanten Sonderfällen,
- `git apply --check`-Fehler hinterlässt Index und Worktree unverändert.

Jeder temporäre Test setzt `user.name` und `user.email` nur lokal im Testrepository. Er verändert keine globale Git-Konfiguration.

### Security-Tests

- Manipulierte `diff.external`-/Textconv-Konfiguration wird nicht ausgeführt.
- Renderer kann keinen absoluten Pfad oder `../` einschleusen.
- Ein Repository oberhalb des autorisierten Roots wird nicht gelesen.
- Untracked Symlink nach außerhalb wird nicht verfolgt.
- `--unsafe-paths` wird nie verwendet.
- Nicht vertrauenswürdiger Frame kann Git-IPC nicht aufrufen.
- Diff-Text mit HTML/Script wird nur als Text gerendert.
- Output-Limit, Timeout und Abbruch räumen den Kindprozess auf.

### Renderer- und E2E-Tests

- Multi-Repo-Gruppierung und leerer Nicht-Git-Zustand.
- Staged/unstaged Tabs und doppelter `MM`-Eintrag.
- Binary-/Konflikt-/Too-large-Darstellung.
- Panel bleibt während eines laufenden Turns sichtbar; Composer bleibt sichtbar und bedienbar.
- Projektwechsel beendet alte Subscription und zeigt keine verspäteten fremden Events.
- Stale-Fehler lädt den Diff neu, statt optimistisch einen falschen Zustand anzuzeigen.
- Playwright-Smoke auf macOS und Windows mit einem temporären Gitrepository.

## Empfohlene Umsetzung in Phasen

### Phase 1: Sicherer read-only Viewer

1. Git-Capability und Binary-Probe.
2. Repository-Erkennung pro Root und Autoritätsprüfung.
3. Porcelain-v2-Status einschließlich Multi-Repo-Gruppierung.
4. Staged-/unstaged-/untracked Diff mit Sonderfällen und harten Limits.
5. Changes-Panel, manueller Refresh und Refresh nach Turnende.
6. Unit-, Integration-, Security- und macOS/Windows-Tests.

Diese Phase liefert bereits den Hauptnutzen und schreibt weder Worktree noch Index.

### Phase 2: Stage und Unstage

1. Main-only Snapshots und Repository-Mutex.
2. Whole-file und vollständige Text-Hunks über `git apply --cached`.
3. Idempotente IPC-Mutationen und Stale-Refresh.
4. Rename/Binary/Submodule als klar begrenzte Whole-file-Aktionen.

### Phase 3: Destruktive und feinere Bearbeitung

1. Unstaged Hunk verwerfen mit Backup und Undo.
2. Untracked Datei wiederherstellbar entfernen.
3. Optional zeilenweise Auswahl, wobei Main den Patch konstruiert.
4. Erst nach gesonderter Bedrohungsanalyse eventuell ein manueller Patch-Editor.

## Akzeptanzkriterien für die erste produktive Version

- Ein Projekt mit zwei getrennten Git-Roots zeigt beide Repositories eindeutig getrennt.
- Nicht-Git-Roots beeinträchtigen weder andere Roots noch den Chat.
- Staged, unstaged, untracked, deleted, renamed, conflict, binary und submodule werden nicht miteinander verwechselt.
- Ein Diff ist entweder vollständig oder wird als zu groß/fehlgeschlagen markiert; niemals still abgeschnitten.
- Kein Git-Aufruf nutzt eine Shell, externe Diffprogramme, freie Rendererargumente oder Netzwerkoperationen.
- Kein Repository außerhalb eines autorisierten Projektroots wird gelesen.
- Während Gemini Dateien ändert, bleibt Composer sichtbar und der Status aktualisiert sich zeitnah ohne UI-Flackern.
- macOS und Windows verarbeiten Pfade, Unicode, CRLF und Prozessabbrüche korrekt.
- Schreibaktionen werden erst nach erfolgreichem read-only Release aktiviert und sind snapshotgebunden, konfliktprüfend und idempotent.

## Offene Produktentscheidung

Vor der Implementierung muss nur noch entschieden werden, wie weit „Diff ändern“ in der ersten Lieferung reichen soll. Die sichere Empfehlung lautet: zuerst read-only Viewer, danach Stage/Unstage kompletter Hunks. „Verwerfen“ und frei editierbare Patches sollten wegen des Datenverlustrisikos bewusst in eine spätere Phase fallen.
