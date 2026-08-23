# Projekt-Explorer im rechten Panel

## Ziel und Interpretation

GeminUI soll in der rechten Panel-Leiste (`PanelRail`) ein zusätzliches Ordner-Icon erhalten. Ein Klick darauf öffnet auf derselben rechten Fläche, auf der heute schon „Änderungen", „Anhänge", „Todos", „MCP" usw. sitzen, einen Datei-Explorer im Stil von VS Code. Der Wunsch wird hier so interpretiert:

1. Der Explorer zeigt den oder die Projektordner als Baum: Unterordner lassen sich per Mausklick auf- und zuklappen, ohne dass der Baum dabei neu geladen oder die Scrollposition verloren geht.
2. Eine Datei oder ein Ordner lässt sich per Klick markieren (ersetzt die bisherige Auswahl). Mit gehaltener Strg-Taste (macOS: Cmd) lässt sich die Auswahl erweitern oder wieder abwählen — echte Mehrfachauswahl wie im VS-Code-Explorer.
3. Die markierten Einträge lassen sich per Drag-and-drop aus dem Explorer in das Chatfenster ziehen und werden dort als Kontext für die nächste Nachricht übernommen — als Datei- oder Ordnerreferenz, nicht als Bilddatei-Anhang.
4. Der Explorer ist rein lesend. Er zeigt den vorhandenen Projektbaum an; er benennt, verschiebt, löscht oder erstellt keine Dateien und öffnet auch keinen eingebetteten Editor.

Ausdrücklich nicht Teil dieser Ausbaustufe:

- Umbenennen, Verschieben, Löschen oder Neuanlegen von Dateien/Ordnern.
- Eine Vorschau oder ein Editor für den Dateiinhalt innerhalb des Panels.
- Drag-and-drop *aus* GeminUI heraus auf den Desktop des Betriebssystems (das wäre ein natives OS-Drag über `webContents.startDrag()` im Main-Prozess und eine eigene Ausbaustufe).
- Volltextsuche über Dateiinhalte im Baum. Die bestehende `@`-Fuzzy-Suche im Composer deckt das bereits ab und wird unten bewusst wiederverwendet statt dupliziert.
- Ein Dateisystem-Watcher für Live-Updates. Der Baum aktualisiert sich beim Öffnen, über einen Refresh-Button und wenn sich `rootRevision` ändert — nicht bei jeder externen Dateisystemänderung in Echtzeit.

## Ergebnis der Analyse

Die Funktion lässt sich weitgehend aus vorhandenen Bausteinen zusammensetzen. Es muss kein neuer Dienst und keine neue Datenbanktabelle entstehen; der bestehende `ProjectFileService` kennt bereits fast alles, was ein Baum braucht, und der Composer kennt bereits einen Mechanismus, um Projektdateien als Kontext an einen Prompt zu hängen. Die Arbeit besteht vor allem darin, eine vorhandene Suchfunktion um eine echte, eindeutige Baum-Navigation zu ergänzen und eine neue Drag-Quelle an ein vorhandenes Drop-Ziel anzuschließen.

Die wichtigsten Rahmenbedingungen des bestehenden Codes:

- **`PanelRail`** (`src/renderer/features/chat/PanelRail.tsx`) ist bereits genau für diesen Fall gebaut: eine feste Spalte mit einem Icon pro Panel, `badge`/`subBadge` für Zähler, ein `onToggle(id)`. Ein neuer Eintrag kostet ein Icon, kein Redesign.
- **`RightPanel`** in `src/renderer/app/App.tsx` ist eine geschlossene Union (`"none" | "changes" | "attachments" | "todos" | "gitlab" | "jira" | "skills" | "mcp"`) mit einer parallelen `RESTORABLE_RIGHT_PANELS`-Liste, die den zuletzt offenen Panel-Typ aus `localStorage` (`geminui.right-panel`) wiederherstellt. Es kann immer nur ein rechtes Panel gleichzeitig offen sein; das Layout, die Breitenlogik (`DEFAULT_RIGHT_PANEL_WIDTH`, `MIN_RIGHT_PANEL_WIDTH` …) und der Umschaltmechanismus sind bereits fertig und müssen nur um einen weiteren Fall erweitert werden.
- **`ProjectFileService`** (`src/main/project-files/project-file-service.ts`) indiziert bereits den kompletten, autorisierten Dateibaum jedes Projekts (`#buildIndex`/`indexRoot`), mit sinnvollen Standard-Ausschlüssen (`EXCLUDED_DIRECTORIES`: `node_modules`, `.git`, `dist`, `build`, `coverage`, `.venv`, `__pycache__` …), einer Tiefenbegrenzung (`MAX_DIRECTORY_DEPTH = 40`), einer harten Obergrenze (`MAX_INDEXED_FILES = 50_000`, dann `truncated: true`) und einem 30-Sekunden-Cache pro Projekt. Symlinks werden schon heute sowohl bei Dateien (`inspectSearchEntry`, `lstat`) als auch faktisch bei Ordnern ausgeschlossen, weil `entry.isDirectory()` für einen Symlink-Eintrag `false` liefert — der Explorer erbt diese Sicherheitsgrenze, ohne selbst etwas dafür tun zu müssen.
- Die vorhandene Methode `search()` bedient heute genau einen Anwendungsfall: die `@`-Autovervollständigung im Composer. Sie kennt bereits eine Ordner-Navigation (`#browse`, ausgelöst durch ein `query`, das auf `/` endet oder einen `/` enthält) und eine Fuzzy-Suche über den ganzen Baum (`#rank`). Für einen echten Baum-Explorer hat sie aber eine Lücke: **`search()`/`#browse()` kennen keine `rootId`.** Der Präfix-Abgleich in `#browse()` matcht `relativePath` über *alle* Roots eines Projekts hinweg. Bei einem Projekt mit mehreren Roots, die zufällig gleich benannte Unterordner haben (z. B. zwei Roots mit je einem `src/`), würde ein Baumknoten „`src/`" beim Aufklappen die Kinder *beider* Roots vermischt zurückbekommen — für die Fuzzy-Suche unschädlich (jeder Treffer trägt seine eigene `rootId`), für das gezielte Aufklappen *eines* Baumknotens aber falsch. Das ist unten als konkrete Erweiterung aufgenommen.
- **`shared/contracts/project-files.ts`** liefert mit `ProjectFileSearchEntrySchema` bereits genau die Zeilenform, die ein Explorer-Eintrag braucht: `rootId`, `rootLabel`, `relativePath`, `displayName`, `kind: "file" | "directory"`, `size`, `childCount`, `contextEligible`, `contextUnavailableReason`. Diese Form muss nicht neu erfunden werden.
- **`Composer.tsx`** (`src/renderer/features/attachments/Composer.tsx`) führt bereits einen State `projectFiles: ProjectFileSearchEntry[]`, der beim Senden unverändert an `onSend(text, attachments, projectFiles)` weitergereicht wird. Es gibt schon eine sichtbare Chip-Leiste dafür (`.project-file-reference-strip`, ab Zeile ~680) mit Icon, Anzeigename, `rootLabel`/„Ordner" als Kleingedrucktem und einem Entfernen-Button. `selectProjectFile()` fügt neue Einträge hinzu (dedupliziert über `rootId` + `relativePath`, begrenzt durch `MAX_PROJECT_FILE_REFERENCES_PER_PROMPT = 10`), verlangt dafür aber eine aktive `@`-Erwähnung im Textfeld — das passt nicht direkt für Drag-and-drop und braucht eine eigene, schlankere Variante (siehe unten).
- **Es gibt bereits einen zweiten, bewusst getrennten Mechanismus für Datei-Kontext:** `ContextAttachmentService` (`src/main/context-attachments/`) plus das „Anhänge"-Panel. Composer.tsx nutzt ihn heute für *native* OS-Drag-and-drop (`window.gemUi.contextAttachments.addDroppedFiles(...)`, ausgelöst über `dataTransfer.types.includes("Files")`). Dieser Weg liest Bytes ein, hasht sie, extrahiert Text/Bilder und legt eine dauerhafte, session- oder projektgebundene Kopie an. Das ist der richtige Weg für Dateien, die *von außerhalb* in den Chat gezogen werden. Für Dateien, die bereits Teil eines autorisierten Projektordners sind, ist er der falsche Weg: Er würde den Dateiinhalt ein zweites Mal speichern, obwohl `ProjectFileService.buildPromptContext()` ihn beim Senden ohnehin frisch von der Platte liest. Der Explorer sollte deshalb **nicht** über `ContextAttachmentService` gehen, sondern über denselben `@`-Referenzmechanismus wie die Composer-Suche (siehe „Abgrenzung" unten).
- **`Icon.tsx`** kennt bereits `folder`, `folder-plus`, `file-text`, `chevron-down`, `chevron-up`, aber kein `chevron-right`/`chevron-left` für ein klassisches Auf-/Zu-Dreieck. Das lässt sich entweder durch eine neue Icon-Variante oder — günstiger — durch eine CSS-Rotation von `chevron-down` um −90° im eingeklappten Zustand lösen.
- Alle rechten Panels folgen demselben Bauplan (`ChangesPanel.tsx`, `McpPanel.tsx`): ein `<aside>` mit `aria-label`, ein `<header>` mit Icon, Titel, Zähler, Refresh- und Schließen-Button, darunter ein scrollbarer Body. Ein neues `ExplorerPanel` sollte sich exakt in dieses Muster einfügen.

## Abgrenzung: `@`-Projektdateien vs. Anhänge

| Eigenschaft | `@`-Projektdateireferenz (bestehend, wird wiederverwendet) | `context_attachments` (bestehend, **nicht** die richtige Wahl für den Explorer) |
| --- | --- | --- |
| Quelle | ausschließlich Dateien innerhalb eines autorisierten Projektroots | beliebige Dateien, auch von außerhalb des Projekts |
| Speicherung | keine eigene Kopie; wird beim Senden frisch gelesen | dauerhafte, gehashte Kopie inkl. Extraktion |
| Lebensdauer | ein einzelner Prompt | Projekt oder Session, bis der Benutzer sie löscht |
| Sichtbarkeit | Chip-Leiste im Composer (`.project-file-reference-strip`) | eigenes „Anhänge"-Panel |
| Ordner | Kurzform für „bis zu 25 enthaltene Dateien", zur Sendezeit aufgelöst | kein Ordnerkonzept |

Der Explorer zieht Dateien und Ordner, die per Definition bereits im Projektbaum liegen. Er gehört damit in die linke Spalte dieser Tabelle. Das hält den Datenfluss einfach: Der Explorer liest denselben Index, den auch die `@`-Suche liest, und der Drop im Chat erzeugt denselben Eintragstyp, den auch die `@`-Suche erzeugt. Es entsteht kein zweiter Pfad, der dieselben Bytes ein zweites Mal anfasst.

## Empfohlene Architektur

### Main-Prozess: `ProjectFileService` um eine eindeutige Baum-Navigation erweitern

Zusätzlich zur bestehenden `search()`-Methode (bleibt unverändert für die `@`-Suche) eine neue, `rootId`-scharfe Methode:

```ts
// src/main/project-files/project-file-service.ts
async listChildren(input: ListProjectDirectoryInput): Promise<ProjectFileSearchResult> {
  const parsed = ListProjectDirectoryInputSchema.parse(input);
  const stored = this.projects.get(parsed.projectId);
  if (stored.rootRevision !== parsed.expectedRootRevision) {
    throw new Error("Die Projektordner wurden geändert. Öffne den Explorer erneut.");
  }
  const index = await this.#getIndex(parsed.projectId, parsed.expectedRootRevision);
  const prefix = parsed.relativePath ? `${parsed.relativePath}/` : "";

  const directories = index.directories
    .filter((d) => d.rootId === parsed.rootId && isDirectChild(d.relativePath, prefix))
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath, "de"))
    .map(toDirectoryEntry);

  const files = index.files
    .filter((f) => f.rootId === parsed.rootId && isDirectChild(f.relativePath, prefix));
  const inspected = (await Promise.all(files.map(inspectSearchEntry)))
    .filter((entry): entry is ProjectFileSearchEntry => entry !== null)
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath, "de"));

  return ProjectFileSearchResultSchema.parse({
    projectId: parsed.projectId,
    rootRevision: parsed.expectedRootRevision,
    entries: [...directories, ...inspected],
    truncated: index.truncated,
  });
}
```

Der einzige inhaltliche Unterschied zu `#browse()` ist der zusätzliche `rootId`-Filter — die restliche Logik (Ausschlüsse, Tiefenbegrenzung, `truncated`, Sortierung) kommt vollständig aus dem bereits gebauten Index. Kein neuer Scan, kein neuer Cache.

Für den Wurzelknoten jedes Roots braucht es keinen eigenen Aufruf: Die Roots selbst (`id`, `label`, `kind: "primary" | "additional"`) sind dem Renderer über das ohnehin geladene Projektobjekt bereits bekannt (`ProjectWithRoots.roots`, sichtbar u. a. in `ProjectSettingsDialog`). Der Explorer kann seine oberste Ebene direkt daraus aufbauen und ruft `listChildren` erst beim ersten Aufklappen eines Root- oder Unterordner-Knotens auf (`relativePath: ""` für die Wurzel eines Roots).

### Shared Contracts

Ergänzung in `src/shared/contracts/project-files.ts`, direkt neben `SearchProjectFilesInputSchema`:

```ts
export const ListProjectDirectoryInputSchema = z
  .object({
    projectId: EntityIdSchema,
    expectedRootRevision: RootRevisionSchema,
    rootId: EntityIdSchema,
    // "" adressiert die Wurzel des Roots.
    relativePath: z.string().max(32_768).default(""),
  })
  .strict();

export type ListProjectDirectoryInput = z.input<typeof ListProjectDirectoryInputSchema>;
```

Der Ergebnistyp bleibt `ProjectFileSearchResultSchema` — dieselbe Form, die `search()` schon zurückgibt und die Composer bereits kennt.

### IPC

Analog zum bestehenden Eintrag registrieren (`src/main/ipc/register-app-ipc.ts`, neben `IPC_CHANNELS.searchProjectFiles`):

```ts
register(IPC_CHANNELS.listProjectDirectory, (input) =>
  options.projectFiles.listChildren(input as ListProjectDirectoryInput),
);
```

Preload-Fläche (`src/preload/index.ts`, im bestehenden `projectFiles`-Objekt, Zeile ~178):

```ts
projectFiles: {
  search: (input) => ipcRenderer.invoke(IPC_CHANNELS.searchProjectFiles, input),
  listDirectory: (input) => ipcRenderer.invoke(IPC_CHANNELS.listProjectDirectory, input),
},
```

Wie alle mutierenden bzw. lesenden Aufrufe läuft das durch `registerValidatedIpcHandler()` mit Zod-Validierung und die bestehende `assertTrustedIpcSender()`-Prüfung — hier ist ohnehin nichts Neues nötig, weil sich der Explorer an das vorhandene IPC-Muster hängt.

### Renderer: neues Feature `explorer`

Neuer Ordner `src/renderer/features/explorer/` mit drei Bausteinen:

**`ExplorerPanel.tsx`** — folgt dem `ChangesPanel`/`McpPanel`-Bauplan: `<aside className="explorer-panel">`, Header mit Ordner-Icon, Titel „Explorer", optionalem Refresh-Button und Schließen-Button, darunter `<ExplorerTree>` in einem scrollbaren Body. Bei mehr als einem Root zeigt der Header oder die oberste Baumebene den jeweiligen `rootLabel`, damit „welcher Ordner ist das" nie unklar ist.

**`ExplorerTree.tsx`** — die rekursive Baumdarstellung. Jede Zeile trägt `role="treeitem"`, `aria-expanded` (nur bei Ordnern), `aria-selected`, `aria-level` entsprechend der Tiefe; der Wurzelcontainer trägt `role="tree" aria-multiselectable="true"`. Das ist dasselbe ARIA-Baummuster, das VS Code selbst verwendet, und passt zum bestehenden, aria-lastigen Stil der App (`PanelRail`, `ChangesPanel`). Einrückung über eine CSS-Variable pro Zeile (`style={{ "--depth": depth }}`), keine verschachtelten Margins.

**`useProjectExplorer.ts`** — der State- und Datenhook:

```ts
type ExplorerNodeKey = `${string}\0${string}`; // `${rootId}\0${relativePath}`

type ExplorerState = {
  expanded: Set<ExplorerNodeKey>;
  children: Map<ExplorerNodeKey, ProjectFileSearchEntry[] | "loading" | Error>;
  selection: Set<ExplorerNodeKey>;
  lastClicked: ExplorerNodeKey | null;
};
```

Verantwortlichkeiten:

- Kinder eines Knotens nur beim ersten Aufklappen laden (`listDirectory`), danach im `children`-Map cachen. Erneutes Zuklappen verwirft den Cache nicht — nur ein expliziter Refresh oder eine geänderte `rootRevision` tut das.
- Bei einer `rootRevision`-Änderung (Root hinzugefügt/entfernt, in `ProjectSettingsDialog`) den kompletten Cache verwerfen und die aktuell aufgeklappten Pfade, soweit sie noch existieren, neu laden — genau das Muster, das `useContextAttachments` bereits für `project.rootRevision` in seinen Effect-Dependencies nutzt.
- Aufklapp-Zustand pro Projekt in `localStorage` merken (z. B. `geminui.explorer.expanded.<projectId>`), analog zu `geminui.right-panel` — ein Projekt, das man täglich öffnet, soll nicht jedes Mal wieder bei eingeklappten Ordnern starten.

### Anbindung an `PanelRail` und `RightPanel`

In `App.tsx`:

```ts
type RightPanel =
  | "none"
  | "explorer"
  | "changes"
  | "attachments"
  | "todos"
  | "gitlab"
  | "jira"
  | "skills"
  | "mcp";

const RESTORABLE_RIGHT_PANELS = [
  "explorer", "changes", "attachments", "todos", "gitlab", "jira", "skills", "mcp",
] as const satisfies readonly RightPanel[];
```

Und in `railItems` (vor oder nach „Anhänge" — „Explorer" passt inhaltlich als erster Eintrag, weil er den Projektordner selbst zeigt, nicht dessen Auswahl):

```ts
{ id: "explorer", icon: "folder", label: "Explorer" },
```

Kein Badge nötig — anders als offene Todos oder ungelesene Änderungen ist „wie viele Dateien liegen im Projekt" keine sinnvolle Kennzahl für die Leiste. Die beiden bestehenden Render-Zweige (`rightPanel === "mcp" ? ... : ...`, je einmal für die Desktop- und die Overlay-Variante des Layouts, aktuell um Zeile 1468 und 1600) bekommen jeweils einen weiteren Fall für `"explorer"`.

## Interaktion im Detail

### Auf- und Zuklappen

Ein Klick auf die Zeile eines Ordners klappt ihn auf oder zu **und** markiert ihn — das ist auch das Verhalten von VS Code selbst. Ein zusätzliches, kleines Dreieck-Icon links (das oben erwähnte `chevron-right`/rotiertes `chevron-down`) bietet denselben Effekt als präziseres Klickziel, ist aber nicht zwingend, um die Grundinteraktion zu bedienen. Ein Klick auf eine Datei markiert sie, klappt aber naturgemäß nichts auf.

### Einfache und Mehrfachauswahl

- **Klick** ersetzt die aktuelle Auswahl durch genau diesen Knoten.
- **Strg-Klick** (macOS: **Cmd-Klick**) schaltet die Zugehörigkeit dieses einen Knotens zur Auswahl um, ohne den Rest der Auswahl anzurühren.
- **Umschalt-Klick** (optional, siehe „Offene Fragen") würde einen zusammenhängenden Bereich der aktuell sichtbaren Zeilen auswählen — das setzt eine geflachte Liste der sichtbaren Zeilen voraus, die für die Tastaturnavigation ohnehin sinnvoll ist.
- Wird ein Knoten gezogen, der **nicht** Teil der aktuellen Auswahl ist, ersetzt der Drag die Auswahl durch genau diesen einen Knoten — wieder das VS-Code-Verhalten, das verhindert, dass versehentlich die halbe letzte Auswahl mitgezogen wird.

### Tastatur

Pfeil hoch/runter bewegt den Fokus über die sichtbaren Zeilen, Pfeil rechts klappt einen fokussierten, zugeklappten Ordner auf (oder springt in sein erstes Kind, wenn er schon offen ist), Pfeil links klappt zu (oder springt zum Elternknoten, wenn schon zu). Leertaste schaltet die Mehrfachauswahl des fokussierten Knotens um, Enter übernimmt die aktuelle Auswahl in den Chat-Kontext (siehe unten) — dieselbe Aktion, die sonst per Drag-and-drop ausgelöst wird, als tastaturbediente Alternative.

## Drag-and-drop in den Chat

### Ziehen aus dem Explorer (Quelle)

Jede Zeile ist `draggable`. `onDragStart` schreibt zwei Repräsentationen in `event.dataTransfer`:

```ts
const refs: ProjectFileReferenceInput[] = selectedEntries.map((e) => ({
  rootId: e.rootId,
  relativePath: e.relativePath,
  kind: e.kind,
}));
event.dataTransfer.setData(
  "application/x-geminui-project-file-refs",
  JSON.stringify(refs),
);
event.dataTransfer.setData(
  "text/plain",
  refs.map((r, i) => `@${selectedEntries[i]!.relativePath}${r.kind === "directory" ? "/" : ""}`).join(" "),
);
```

Der `text/plain`-Fallback sorgt dafür, dass ein Ziehen auf ein Ziel außerhalb dieses neuen Mechanismus (z. B. ein einfaches Textfeld) trotzdem sinnvollen Text liefert, statt ins Leere zu laufen.

### Fallen lassen im Chat (Ziel)

`Composer.tsx` hat bereits einen fensterweiten Drag-Handler (`useEffect` ab Zeile ~225), der heute ausschließlich native OS-Dateien erkennt:

```ts
const hasFiles = (event: DragEvent) =>
  Array.from(event.dataTransfer?.types ?? []).includes("Files");
```

Dieser Handler wird um die neue Repräsentation ergänzt:

```ts
const hasProjectFileRefs = (event: DragEvent) =>
  Array.from(event.dataTransfer?.types ?? []).includes("application/x-geminui-project-file-refs");
```

Im `drop`-Handler wird bei `hasProjectFileRefs(event)` **nicht** `addFiles()` (der OS-Pfad über `contextAttachments.addDroppedFiles`) aufgerufen, sondern eine neue, schlanke Funktion, die exakt denselben Effekt wie `selectProjectFile()` hat, aber ohne eine aktive `@`-Erwähnung im Text vorauszusetzen:

```ts
const addProjectFileReferences = (entries: ProjectFileSearchEntry[]) => {
  const eligible = entries.filter((e) => e.contextEligible);
  const skipped = entries.length - eligible.length;
  setProjectFiles((current) => {
    const seen = new Set(current.map((e) => `${e.rootId}\0${e.relativePath}`));
    const additions = eligible.filter((e) => !seen.has(`${e.rootId}\0${e.relativePath}`));
    const room = MAX_PROJECT_FILE_REFERENCES - current.length;
    if (additions.length > room) {
      onError(`Pro Nachricht können höchstens ${MAX_PROJECT_FILE_REFERENCES} Projektdateien oder -ordner referenziert werden.`);
    }
    return [...current, ...additions.slice(0, Math.max(0, room))];
  });
  if (skipped > 0) {
    onError(`${skipped} Eintrag/Einträge waren nicht als Kontext geeignet und wurden übersprungen.`);
  }
};
```

Das reicht bereits: `projectFiles` fließt beim Senden unverändert in `onSend(text, attachments, projectFiles)`, die bestehende Chip-Leiste zeigt die neuen Einträge sofort an, und ein gezogener Ordner wird — genau wie ein per `@ordner/` erwähnter — erst in `ProjectFileService.buildPromptContext()` zur Sendezeit zu seinen enthaltenen Dateien aufgelöst (bis zu `MAX_PROJECT_FILES_PER_DIRECTORY = 25`). Es entsteht kein neuer Code auf dem Weg vom Absenden bis zum Prompt.

Damit der Explorer die passenden `ProjectFileSearchEntry`-Objekte fürs Ziehen überhaupt besitzt (inklusive `contextEligible`, `size`, `rootLabel` …), liefert `listChildren()` bewusst dieselbe, bereits vollständig inspizierte Eintragsform, die auch `search()` zurückgibt — der Explorer muss beim Drag-Start also nichts nachladen.

## Randfälle und Sicherheit

- **Mehrdeutigkeit bei mehreren Roots.** Gelöst durch den `rootId`-Parameter von `listChildren()` (siehe oben) — ein Baumknoten adressiert immer genau einen Root, nie „alle Roots, deren relativer Pfad zufällig passt".
- **Geänderte Roots während der Baum offen ist.** `listChildren()` prüft `expectedRootRevision` wie `search()` und wirft bei Abweichung. Der Hook fängt das ab, verwirft den Cache und zeigt denselben Hinweistext, den auch `ProjectFileService` schon für die `@`-Suche formuliert („Die Projektordner wurden geändert …"), plus einen Reload-Button.
- **Sehr große Ordner/Repos.** `MAX_INDEXED_FILES = 50_000` und die bestehende `truncated`-Kennzeichnung gelten unverändert. Der Explorer sollte den vorhandenen `truncated`-Wert genauso sichtbar machen wie es `McpPanel` heute für „nicht alle gefundenen MCP-Server übernommen" tut — kein stilles Abschneiden.
- **Ausgeschlossene Ordner (`node_modules`, `.git`, `dist` …).** Bleiben standardmäßig unsichtbar, wie schon bei der `@`-Suche. Ein Baum, der eine 50.000-Dateien-`node_modules` mitrendert, wäre weder schnell noch nützlich. Ob es später eine „Ausgeschlossene Ordner einblenden"-Option braucht, ist unten als offene Frage vermerkt.
- **Symlinks.** Werden schon von `indexRoot()`/`inspectSearchEntry()` ausgeschlossen (siehe Analyse oben) — keine zusätzliche Prüfung im Explorer nötig, aber auch keine, die entfernt werden dürfte.
- **Zu große Einzeldateien.** Eine Datei über `MAX_PROJECT_FILE_BYTES` (1 MiB) trägt bereits `contextEligible: false` mit erklärendem `contextUnavailableReason`. Der Explorer zeigt solche Einträge visuell abgeblendet, genauso wie es das `@`-Vorschlagsmenü im Composer schon tut, und `addProjectFileReferences()` weist beim Drop-Versuch mit derselben Fehlermeldung ab.

## Zugänglichkeit

Der Baum folgt dem etablierten ARIA-Tree-Pattern (`role="tree"`, `role="treeitem"`, `aria-expanded`, `aria-selected`, `aria-level`, `aria-multiselectable="true"` auf dem Wurzelelement). Das deckt sich mit dem Rest der App, die durchgehend auf präzise `aria-label`/`aria-pressed`-Angaben setzt (`PanelRail`, `ChangesPanel`) statt auf rein visuelle Zustände. Drag-and-drop ist naturgemäß nicht tastaturbedienbar; Enter auf der aktuellen Auswahl (siehe „Tastatur" oben) ist der gleichwertige, rein tastaturbediente Ersatzweg, um Dateien in den Chat-Kontext zu übernehmen.

## Offene Fragen

1. **Ausgeschlossene Ordner einblenden?** Standardmäßig verstecken (wie die `@`-Suche) oder eine Umschaltung „Alle Dateien anzeigen" für den selteneren Fall anbieten, dass jemand gezielt in `node_modules` etwas nachsehen will?
2. **Umschalt-Klick für Bereichsauswahl** — für v1 aufnehmen oder auf eine spätere Ausbaustufe verschieben? Technisch günstig, sobald die geflachte Zeilenliste für die Tastaturnavigation ohnehin existiert.
3. **Eigene Dateityp-Icons** (wie VS Codes Extension-abhängige Icons) oder für v1 bei zwei Icons bleiben (`folder` für Ordner, `file-text` für alles andere), wie es die bestehende Chip-Leiste im Composer heute schon handhabt?
4. **Aufklapp-Zustand je Projekt merken** (`localStorage`) — sinnvoll angenommen, aber zu bestätigen, ob das pro Projekt oder pro Projekt *und* Session gelten soll.
5. **Sichtbarer Zähler beim Ziehen eines Ordners.** Ein Ordner kann still bis zu 25 Dateien einbringen. Reicht der Titel „Ordner" in der Chip-Leiste, oder soll die Chip-Beschriftung schon die tatsächliche `childCount` zeigen, um Überraschungen beim Senden zu vermeiden?
