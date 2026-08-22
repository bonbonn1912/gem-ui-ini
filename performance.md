# Performance: warum sich die Oberfläche träge anfühlt

Stand: 22. August 2026
Analysierter Stand: GeminUI 0.9.8, React 19.2, Electron 43.4 (Chromium 138), Vite 8.2

## Kurzfassung

Die wahrgenommene Trägheit auf schwächeren Rechnern kommt fast vollständig aus
dem Renderer. Der Main-Prozess ist an der heißen Stelle bereits sauber gebaut:
`AppController.#queueEvent` fasst Streaming-Deltas in 32-ms-Fenstern zusammen,
verschmilzt aufeinanderfolgende Deltas derselben Nachricht und schreibt sie
gebündelt über `EventRepository.appendBatch` (`src/main/app-controller.ts:990`).
Aus dem Modell kommen also rund 30 Batches pro Sekunde — das ist eine
angemessene Rate.

Was diese 30 Batches im Renderer auslösen, ist das Problem:

1. **Jeder Batch rendert den gesamten React-Baum neu.** Im Renderer existiert
   kein einziges `React.memo`. Ein Dispatch in `App` rendert Sidebar,
   ChatHeader, Timeline, Composer und alle offenen Panels mit.
2. **Jeder Batch parst sämtliches Markdown neu.** Jede Assistant-Nachricht in
   der Timeline — auch die zwanzig längst abgeschlossenen darüber — läuft bei
   jedem Render komplett durch `react-markdown` + `remark-gfm`.
3. **Jeder Tastendruck im Composer erzwingt ein synchrones Layout des gesamten
   Dokuments**, weil die Textarea-Höhe per `scrollHeight` gemessen wird.
4. **Dauerhaft sichtbare `backdrop-filter: blur()`-Flächen** kosten auf
   integrierter Grafik bei jedem Repaint.

Punkte 1 und 2 erklären das Ruckeln während der Antwort, Punkt 3 das hakende
Tippen, Punkt 4 die generelle Zähigkeit auch im Leerlauf. Alle vier sind ohne
Architekturänderung behebbar.

## 1. Messgrundlage

Bevor etwas geändert wird, sollte der Ist-Zustand einmal aufgezeichnet werden —
sonst lässt sich später nicht belegen, dass die Maßnahme gewirkt hat.

- **React DevTools Profiler**, Option *Highlight updates when components
  render*: während einer streamenden Antwort blinkt sichtbar der komplette
  Fensterinhalt statt nur der letzten Nachricht. Das ist der Befund aus
  Abschnitt 2.1 in einem Bild.
- **Chrome DevTools → Performance**, Aufzeichnung über eine Antwort von etwa
  3.000 Zeichen. Interessant sind der Anteil *Scripting* (Markdown-Parse) und
  die Zahl der *Layout*-Einträge.
- **Performance → Aufzeichnung beim Tippen** eines Satzes im Composer. Ein
  violetter *Layout*-Balken pro Tastendruck, dessen Dauer mit der Länge der
  Timeline wächst, ist der Befund aus Abschnitt 2.3.
- Als Referenzlast eignet sich eine Session mit mehreren hundert Timeline-Items
  und mindestens einem großen Diff — genau dort fällt die Sache auseinander,
  nicht in einer frischen Session.

## 2. Befunde

Sortiert nach Wirkung auf das Gefühl der Anwendung.

### 2.1 Ein Stream-Chunk rendert die gesamte App neu

`App` hält 28 `useState` plus den Chat-Reducer. Jeder `dispatch({ type:
"events" })` rendert die Komponente und damit ihren gesamten Teilbaum. Weil im
Renderer nirgends `React.memo` verwendet wird, gibt es keine Stelle, an der
dieser Durchlauf abgeschnitten würde.

Drei Details verhindern zusätzlich, dass ein späteres Memo überhaupt greifen
könnte:

```tsx
// src/renderer/app/App.tsx:1369
chat={{ ...chat, phase: effectivePhase }}
```

ChatHeader (735 Zeilen) bekommt bei jedem Render ein frisches Objekt. Selbst
memoisiert würde die Komponente immer neu rendern. Sie braucht `chat.phase`,
`chat.usage`, `chat.modes`, `chat.models` und `chat.providerSessions` — aber
nicht `chat.items`, das sich als Einziges während des Streams ändert.

```tsx
// src/renderer/app/App.tsx:1388
onRespondToPermission={(request, option) => void respondToPermission(request, option)}
```

Inline-Arrow, also bei jedem Render eine neue Funktionsreferenz. Sie wird bis in
jede `PermissionCard` durchgereicht.

```tsx
// src/renderer/components/MarkdownContent.tsx:46
const components: Components = { a(...) {...}, img(...) {...}, pre(...) {...} };
```

Das `components`-Objekt wird bei jedem Render neu gebaut. `ReactMarkdown` sieht
dadurch bei jedem Durchlauf geänderte Props und kann intern nichts
wiederverwenden.

**Maßnahme.** `TimelineEntry`, `ToolCard`, `AssistantMessage` und
`MarkdownContent` in `React.memo` einpacken; der Reducer erzeugt ohnehin nur für
das tatsächlich geänderte Item ein neues Objekt, ein Referenzvergleich genügt
also. Callbacks in `App` in `useCallback` legen. ChatHeader die benötigten
Felder einzeln übergeben statt des ganzen `chat`-Objekts. Das
`components`-Objekt aus dem Render-Körper herausziehen (die einzige
Abhängigkeit ist `onOpenExternal`, also `useMemo` mit dieser Abhängigkeit — oder
`onOpenExternal` über einen Ref stabil halten und das Objekt ganz nach außen
verschieben).

### 2.2 Markdown wird bei jedem Chunk vollständig neu geparst

Dies ist der größte Einzelposten.

```tsx
// src/renderer/features/chat/Timeline.tsx:388
<MarkdownContent onOpenExternal={onOpenExternal}>{item.text}</MarkdownContent>
```

Während des Streams wächst `item.text` mit jedem Chunk, und `react-markdown`
baut daraufhin den kompletten mdast/hast-Baum neu auf — bei einer Antwort von
5.000 Zeichen also 30 Mal pro Sekunde über den gesamten Text. Zusammen mit 2.1
gilt das zusätzlich für jede abgeschlossene Nachricht weiter oben im Verlauf.

**Maßnahme, zwei Stufen.** Erstens: solange `item.streaming` gilt, kein
Markdown rendern, sondern rohen Text mit `white-space: pre-wrap` ausgeben und
erst beim Abschluss des Turns einmal formatieren. Die Formatierung eines
halbfertigen Markdown-Blocks ist ohnehin unzuverlässig — ein noch nicht
geschlossener Code-Fence oder eine halbe Tabelle sieht während des Tippens
schlechter aus als reiner Text.

Falls die formatierte Live-Ansicht erwünscht bleibt, zweitens: den an
`MarkdownContent` übergebenen Text throttlen (etwa 200 ms) statt jeden Chunk
durchzureichen, und die Komponente auf `children` memoisieren.

Derselbe Punkt betrifft `ToolCard`: `formatPayload` ruft
`JSON.stringify(value, null, 2)` für Input *und* Output bei jedem Render auf
(`Timeline.tsx:122` und `:144`), ungememoisiert und ungekürzt. Ergebnis in
`useMemo`, und große Payloads auf einige Kilobyte kürzen mit einem
Aufklapp-Rest.

### 2.3 Die Textarea erzwingt bei jedem Tastendruck ein Layout

```ts
// src/renderer/features/attachments/Composer.tsx:266-271
useEffect(() => {
  const textarea = textareaRef.current;
  if (!textarea) return;
  textarea.style.height = "0px";
  textarea.style.height = `${Math.min(textarea.scrollHeight, 190)}px`;
}, [text]);
```

Das Setzen von `height` invalidiert das Layout, das anschließende Lesen von
`scrollHeight` erzwingt es sofort wieder — ein *forced synchronous layout* über
das **gesamte** Dokument. Und im Dokument hängt die komplette Timeline mit
hunderten `<details>`, `<pre>`-Blöcken und, bei einem großen Diff, einem
`<span>` pro Zeile. Die Kosten pro Tastendruck wachsen also mit der Länge der
Session. Genau das ist die Ursache für „das Tippen hakt".

**Maßnahme.** Ersatzlos streichen und durch CSS ersetzen. Electron 43 bringt
Chromium 138, `field-sizing` ist damit verfügbar:

```css
.composer textarea {
  field-sizing: content;
  max-height: 190px;
}
```

Kein JavaScript, kein Reflow, gleiches Verhalten. Der `useEffect` und die
`text`-Abhängigkeit entfallen komplett.

### 2.4 `backdrop-filter` auf dauerhaft sichtbaren Flächen

```css
/* src/renderer/styles/app.css:217 */
.chat-header { ...; backdrop-filter: blur(18px); ... }
```

Der Header ist immer im Bild. Jeder Repaint dahinter — Scrollen der Timeline,
ein laufender `mini-spinner`, der `stream-cursor` — zwingt den Compositor, die
Unschärfe neu zu berechnen. Auf integrierter Grafik ist `backdrop-filter` mit
Abstand der teuerste Effekt im Stylesheet. Weitere Vorkommen:
`app.css:1159`, `:1891`, `:1910`, `:2220`, `:2521`, `:2653` (jeweils `blur(8px)`
bis `blur(20px)`).

**Maßnahme.** Im Header ersetzen durch eine deckende Fläche, etwa
`background: color-mix(in srgb, var(--canvas) 97%, transparent)` ohne Filter —
optisch kaum unterscheidbar, im Compositing um Größenordnungen billiger. In
Modals und Tooltips (`.modal-layer:493`, `.mode-info-tooltip:1891`) darf der
Blur bleiben: diese Flächen sind kurzlebig und liegen nicht unter einer
scrollenden Timeline.

Zusätzlich stehen zwölf `transition: all 0.15s ease` im Stylesheet
(`app.css:1086, 1241, 1348, 1462, 1522, 1687, 1740, 1994, 2011, 2081, 2133,
2166`). `all` animiert auch layout-relevante Eigenschaften und zwingt den
Browser, jede Property auf Änderung zu prüfen. Durch explizite Listen ersetzen —
idealerweise nur `opacity`, `transform`, `color`, `background-color` und
`border-color`.

### 2.5 Die Timeline rendert alles, immer

Es gibt keine Virtualisierung: eine Session mit 800 Items hält 800 Items im DOM.
Das verteuert jedes Layout, jeden Repaint und jedes forced layout aus 2.3.

Ein einzelner Posten sticht heraus:

```tsx
// src/renderer/features/chat/Timeline.tsx:129
{item.diff.split("\n").map((line, index) => (
  <span className={...} key={`${index}:${line}`}>{line || " "}{"\n"}</span>
))}
```

Ein React-Element und ein DOM-Knoten pro Diff-Zeile, unbegrenzt. Ein
2.000-Zeilen-Diff sind 2.000 Knoten in einer einzigen Tool-Karte — und die
Karten liegen in `<details>`, sind also auch im zugeklappten Zustand im Baum.

Dazu kommt Arbeit, die pro Render über alle Items läuft:

```tsx
// src/renderer/features/chat/Timeline.tsx:626
const contentSignature = items.map((item) => ...).join(":");
```

Bei jedem Render ein Durchlauf über alle Items plus String-Konkatenation, nur um
eine `useEffect`-Abhängigkeit zu bilden.

**Maßnahmen.**

- Diff-Ausgabe auf etwa 200 Zeilen deckeln, Rest hinter „weitere N Zeilen
  anzeigen".
- `contentSignature` durch `chat.lastSeq` ersetzen — der Reducer führt diesen
  Wert bereits (`ChatState.lastSeq`) und er ändert sich genau dann, wenn neue
  Events angekommen sind.
- Mittelfristig: nur die letzten ~50 Items rendern und ältere über einen
  „Frühere Nachrichten laden"-Knopf oder einen IntersectionObserver
  nachschieben. Volle Virtualisierung mit variablen Höhen ist bei aufklappbaren
  Karten aufwendig; das Fenster-Verfahren holt den Großteil des Gewinns.

### 2.6 Auto-Scroll löst 30 Layouts pro Sekunde aus

```tsx
// src/renderer/features/chat/Timeline.tsx:641
anchorRef.current?.scrollIntoView?.({ block: "end" });
```

`scrollIntoView` erzwingt Layout. Bei jedem Chunk aufgerufen, kommt das
zusätzlich zu allem anderen obendrauf.

**Maßnahme.** Auf `requestAnimationFrame` drosseln (höchstens ein Scroll pro
Frame) und `element.scrollTop = element.scrollHeight` auf dem bereits
vorhandenen `scrollRef` verwenden statt `scrollIntoView` auf einem Anker. Der
gleiche Punkt gilt für `ToolRunGroup` (`Timeline.tsx:180`), das dieselbe Logik
für seinen inneren Scroll-Container hat.

### 2.7 Kleinere Posten

- **Sourcemaps im Produktions-Build.** `vite.renderer.config.ts` setzt
  `sourcemap: true` ohne Modus-Unterscheidung. Das gilt damit auch für
  `electron-forge package`. Für Release-Builds auf `false` oder `"hidden"`
  setzen — kleineres Bundle, schnellerer Kaltstart.
- **`rows` in `Timeline`** (`Timeline.tsx:605`) baut die Gruppierung bei jeder
  Änderung von `items` neu auf. Das ist korrekt, aber der `useMemo` bringt
  während des Streams nichts, weil `items` bei jedem Chunk ein neues Array ist.
  Erst zusammen mit 2.1 lohnt es sich, hier zu optimieren.
- **`useGitChangePreviews`** liefert bei jeder Aktualisierung eine neue `Map`.
  Das ist unvermeidlich, wird aber erst dann unschädlich, wenn `TimelineEntry`
  memoisiert ist und die Map nicht mehr den ganzen Verlauf invalidiert; dafür
  sollte nur die betroffene `PreviewGroup` als Prop hineingereicht werden — was
  `Timeline.tsx` für den Einzelfall bereits tut, für `ToolRunGroup` aber nicht.

## 3. Der breite, billige Hebel: React Compiler

Die Codebasis enthält sehr wenig manuelle Memoisierung (zehn Stellen in
`App.tsx`, sonst einstellige Zahlen pro Datei). Der React Compiler memoisiert
Komponenten und Hooks automatisch und ist für React 19 stabil:

```ts
// vite.renderer.config.ts
plugins: [
  react({
    babel: { plugins: [["babel-plugin-react-compiler", { target: "19" }]] },
  }),
],
```

Das ersetzt Abschnitt 2.2 nicht — der Markdown-Parse läuft weiterhin, solange
sich `item.text` bei jedem Chunk ändert — deckt aber den größten Teil von 2.1
ohne manuelle Arbeit ab. Es lohnt sich, ihn als eigene Etappe einzuziehen und
die Wirkung getrennt zu messen, statt ihn mit Handoptimierungen zu vermischen.

## 4. Maßnahmenplan

| # | Maßnahme | Datei | Aufwand | Wirkung |
|---|---|---|---|---|
| 1 | Streamenden Text ohne Markdown-Parse ausgeben | `Timeline.tsx` | klein | sehr hoch |
| 2 | `field-sizing: content` statt Auto-Resize-Effekt | `Composer.tsx`, `app.css` | sehr klein | hoch (Tippen) |
| 3 | `React.memo` auf `TimelineEntry`, `ToolCard`, `AssistantMessage`, `MarkdownContent` | `Timeline.tsx`, `MarkdownContent.tsx` | mittel | sehr hoch |
| 4 | `useCallback` für Timeline-Callbacks, ChatHeader ohne `{...chat}` | `App.tsx` | klein | hoch |
| 5 | `backdrop-filter` aus `.chat-header` entfernen | `app.css:217` | sehr klein | mittel–hoch |
| 6 | `components`-Objekt aus dem Render-Körper ziehen | `MarkdownContent.tsx:46` | sehr klein | mittel |
| 7 | `formatPayload` in `useMemo`, Payloads kürzen | `Timeline.tsx` | klein | mittel |
| 8 | `contentSignature` → `lastSeq`, Auto-Scroll auf rAF drosseln | `Timeline.tsx` | klein | mittel |
| 9 | `transition: all` durch explizite Listen ersetzen | `app.css` (12 Stellen) | klein | klein–mittel |
| 10 | Diff-Ausgabe auf ~200 Zeilen deckeln | `Timeline.tsx:129` | klein | mittel bei großen Diffs |
| 11 | React Compiler aktivieren | `vite.renderer.config.ts` | sehr klein | hoch, breit |
| 12 | `sourcemap: false` für Release-Builds | `vite.renderer.config.ts` | sehr klein | klein (Kaltstart) |
| 13 | Fenster-Rendering der Timeline (letzte ~50 Items) | `Timeline.tsx` | groß | hoch bei langen Sessions |

## 5. Empfohlene Reihenfolge

**Etappe 1 — das spürbare Drittel (1, 2, 5).** Drei kleine, isolierte
Änderungen, die die drei lautesten Symptome adressieren: Ruckeln beim Streamen,
hakendes Tippen, zähes Scrollen. Danach messen und vergleichen.

**Etappe 2 — Memoisierung (3, 4, 6, 7, 8).** Zusammenhängend, weil Memos ohne
stabile Props wirkungslos bleiben. Alternativ zuerst 11 (React Compiler)
versuchen und prüfen, wie viel davon übrig bleibt.

**Etappe 3 — Feinschliff (9, 10, 12).** Unabhängig voneinander, jederzeit
einschiebbar.

**Etappe 4 — Fenster-Rendering (13).** Erst sinnvoll, wenn die Etappen davor
sitzen; vorher ist unklar, wie viel Gewinn überhaupt noch offen ist.

## 6. Verifikation

Nach jeder Etappe:

```bash
npm run typecheck && npm test
```

Zusätzlich manuell, jeweils gegen die in Abschnitt 1 aufgezeichnete Baseline:

- Eine lange Antwort streamen lassen und im React-Profiler prüfen, dass nur noch
  die letzte Nachricht neu rendert.
- Während des Streams in den Composer tippen — die Eingabe muss ohne
  wahrnehmbare Verzögerung erscheinen.
- Eine Session mit mehreren hundert Items öffnen und scrollen.
- Ein Tool mit großem Diff ausführen und die Karte auf- und zuklappen.

Die vorhandenen Playwright-Tests unter `tests/` decken das Verhalten ab, nicht
die Laufzeit; sie schützen also vor Regressionen der Funktion, nicht vor
Regressionen der Geschwindigkeit. Eine Messung von Hand bleibt nötig.
