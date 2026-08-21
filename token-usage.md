# Token-Usage in GeminUI

Stand: 21. August 2026  
Analysierter Stand: GeminUI mit `@agentclientprotocol/sdk` 1.3.0 und lokal installierter `@google/gemini-cli` 0.56.0

## Kurzfassung

Die Anzeige funktioniert mit einer echten Gemini-CLI-Session derzeit nicht, obwohl Renderer und Fake Agent eine Usage-Anzeige besitzen. Dafür gibt es zwei unabhängige Hauptursachen:

1. Gemini CLI 0.56.0 sendet im ACP-Modus kein `usage_update`. Sie schreibt die Tokenzahlen erst am Ende eines Prompt-Turns in das proprietäre Feld `PromptResponse._meta.quota.token_count`.
2. GeminUI liest nur das standardisierte, bei Gemini aber leere Feld `PromptResponse.usage`. Das tatsächlich gefüllte Gemini-Feld `_meta.quota` wird ignoriert. Selbst ein künftig gefülltes `PromptResponse.usage` wird zwar intern bis `turn.completed` transportiert, im `AppController` aber verworfen und nie als öffentliches Usage-Event an den Renderer gesendet.

Der vorhandene Fake Agent verdeckt diese Lücke: Er sendet sowohl ein standardkonformes `usage_update` als auch `PromptResponse.usage`. Genau das tut die echte Gemini CLI 0.56.0 nicht.

Ein belastbarer Fix muss daher zwei Datenarten getrennt behandeln:

- **verbrauchte Token** eines Turns beziehungsweise der Session;
- **aktuelle Belegung des Kontextfensters** (`used / size`).

Diese Werte sind nicht austauschbar. Aus kumuliert verbrauchten Token darf kein Kontext-Prozentwert berechnet werden.

Mit GeminUI allein ist bei Gemini CLI 0.56.0 eine exakte Aktualisierung **direkt nach Abschluss eines Turns** möglich. Eine exakte Aktualisierung während des Streamings ist erst möglich, wenn Gemini CLI selbst `usage_update` sendet oder ihr ACP-Server entsprechend erweitert wird.

## Untersuchte Datenstrecke

```text
Gemini CLI --acp
  -> ACP SDK ClientConnection
  -> GeminiAcpSession
  -> normalizeSessionNotification / runPrompt
  -> GeminiSessionManager
  -> AppController.toSharedEvent
  -> EventRepository (SQLite)
  -> IPC / Preload
  -> Chat-Reducer
  -> ChatHeader
```

### 1. Gemini CLI 0.56.0

Die lokal installierte CLI wurde anhand ihres ausgelieferten Bundles geprüft. In `Session.prompt()` werden `totalInputTokens` und `totalOutputTokens` für genau den aktuellen `session/prompt`-Aufruf gesammelt. Dazu können mehrere interne Modellaufrufe gehören, beispielsweise wenn Gemini Werkzeuge ausführt. Am Ende antwortet die CLI in dieser Form:

```json
{
  "stopReason": "end_turn",
  "_meta": {
    "quota": {
      "token_count": {
        "input_tokens": 1234,
        "output_tokens": 567
      },
      "model_usage": [
        {
          "model": "gemini-…",
          "token_count": {
            "input_tokens": 1234,
            "output_tokens": 567
          }
        }
      ]
    }
  }
}
```

Wichtige Eigenschaften dieses Payloads:

- `_meta.quota.token_count` ist **pro GeminUI-Prompt-Turn**, nicht kumulativ für die gesamte Provider-Session. Die Zähler werden am Anfang jedes `Session.prompt()`-Aufrufs wieder auf null gesetzt.
- Die Werte werden erst mit der abschließenden `PromptResponse` geliefert.
- Die CLI sendet kein `session/update` mit `sessionUpdate: "usage_update"`.
- `PromptResponse.usage` bleibt leer.
- `model_usage` enthält eine Aufteilung nach den innerhalb des Turns tatsächlich verwendeten Modellen.
- Die CLI übernimmt aus Googles `usageMetadata` nur Prompt- und Kandidaten-Token. Gedanken-, Cache-, Tool- und der echte Gesamtwert werden in diesem ACP-Payload nicht weitergereicht.

Dieses Verhalten ist auch im aktuellen offiziellen Gemini-CLI-Quellcode auf `main` sichtbar: Die Zähler werden innerhalb von `prompt()` angelegt, aus `GeminiEventType.Finished` befüllt und ausschließlich unter `_meta.quota` zurückgegeben; `usage_update` kommt in der Datei nicht vor. Siehe [Gemini CLI `acpSession.ts`](https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/acp/acpSession.ts). Ein weiterhin offenes offizielles Issue beschreibt genau diese Abweichung und fordert `PromptResponse.usage` sowie `UsageUpdate`: [google-gemini/gemini-cli#24280](https://github.com/google-gemini/gemini-cli/issues/24280).

### 2. ACP SDK und Protokoll

Das installierte `@agentclientprotocol/sdk` 1.3.0 kennt zwei unterschiedliche Usage-Kanäle:

- `PromptResponse.usage`: Tokenzähler mit `totalTokens`, `inputTokens`, `outputTokens` sowie optional Gedanken- und Cache-Token;
- `usage_update`: Session-Notification mit `used`, `size` und optional kumulativen Kosten.

Der ACP-Entwurf trennt Tokenverbrauch ausdrücklich von Kontextfenster und Kosten. `used / size` ist die aktuelle Kontextbelegung; `PromptResponse.usage` beschreibt Tokenzähler. Bei `session/load` oder `session/resume` soll ein Agent einen Kontextstand senden, wenn er ihn kennt. Siehe [ACP: Session Usage and Context Status](https://agentclientprotocol.com/rfds/session-usage).

Zu beachten ist eine noch nicht vollständig stabile Semantik: Die Typkommentare des SDK 1.3.0 beschreiben `PromptResponse.usage` als kumulativ über die Session, während das ACP-RFD von Tokenwerten eines Turns spricht. Der GeminUI-Vertrag darf deshalb die Gültigkeitsebene nicht implizit raten, sondern muss sie als `scope` festhalten.

### 3. `GeminiAcpSession`

In `src/main/gemini/acp-session.ts` geschieht aktuell Folgendes:

```ts
const response = await this.agent.request(/* session/prompt */);
const result = {
  stopReason: response.stopReason,
  ...(response.usage ? { usage: response.usage } : {}),
};
```

Damit entstehen drei Lücken:

- `response._meta.quota` wird überhaupt nicht ausgewertet;
- `usage` bleibt als `unknown` typisiert und wird nicht fachlich normalisiert;
- aus einer abschließenden Prompt-Antwort wird kein separates Usage-Ereignis erzeugt.

Native `usage_update`-Notifications würden dagegen in `event-normalizer.ts` korrekt als `used`, `size` und optional `cost` erkannt. Dieser Pfad wird von Gemini CLI 0.56.0 nur nicht bedient.

### 4. `GeminiSessionManager`

Der Manager reicht normalisierte Events unverändert an seine Listener weiter. Hier liegt nicht die primäre Ursache. Sein Test nutzt jedoch den Fake Agent und prüft lediglich, ob irgendwann der Eventtyp `usage.updated` vorkam. Er prüft nicht, ob die Tokenwerte der abschließenden `PromptResponse` die öffentliche UI erreichen.

### 5. Fake Agent

`tests/fake-acp-agent/fake-acp-agent.mjs` sendet aktuell beides:

```json
{
  "sessionUpdate": "usage_update",
  "used": 10,
  "size": 100
}
```

und anschließend:

```json
{
  "stopReason": "end_turn",
  "usage": {
    "totalTokens": 10,
    "inputTokens": 4,
    "outputTokens": 6
  }
}
```

Das ist ein guter Test für einen vollständig implementierten ACP-Agenten, aber kein repräsentativer Test für die aktuell unterstützte Gemini CLI. Dadurch sind Tests grün, während die reale UI keine Usage erhält.

### 6. `AppController`

`toSharedEvent()` mappt eine native Kontextmeldung derzeit so:

```ts
{
  type: "usage.updated",
  inputTokens: null,
  outputTokens: null,
  totalTokens: event.payload.used,
  used: event.payload.used,
  size: event.payload.size
}
```

Hier werden zwei verschiedene Bedeutungen vermischt: `used` ist Kontextbelegung, nicht automatisch der gesamte Tokenverbrauch. Das Feld zusätzlich als `totalTokens` auszugeben, ist semantisch falsch.

Noch wichtiger: Bei `turn.completed` wird `event.payload.usage` vollständig verworfen. Selbst wenn eine zukünftige Gemini CLI `PromptResponse.usage` korrekt liefert, erreicht es die UI mit dem aktuellen Code nicht.

### 7. Öffentlicher Eventvertrag

`src/shared/contracts/events.ts` enthält nur:

```ts
{
  inputTokens,
  outputTokens,
  totalTokens,
  used?,
  size?
}
```

Probleme dabei:

- keine explizite Trennung von Turn-, Session- und Kontextwerten;
- kein `scope`, keine Quelle und keine Aussage zur Vollständigkeit;
- kein Kostenfeld, obwohl der Renderer ein solches Feld intern erwartet;
- keine Gedanken-, Cache- oder Modellaufschlüsselung;
- striktes Zod-Schema: Ein echtes zusätzliches `cost` im Event würde abgelehnt. Der UI-Test umgeht den Typfehler mit `as unknown as StreamEnvelope`, statt den realen Vertrag zu testen.

### 8. SQLite und Neustart

Usage-Events würden zwar in der allgemeinen `events`-Tabelle persistiert. Es gibt aber keinen eigenen, idempotenten Usage-Snapshot und keine Turn-Usage-Tabelle.

Zusätzlich lädt die Event-Subscription beim Öffnen einer Session nur `listAfter(..., limit = 1000)`, und der Renderer abonniert immer ab Sequenz null. Bei Sessions mit mehr als 1000 Events kann der neueste Usage-Stand nach einem Neustart außerhalb des Replay-Fensters liegen.

Historische Gemini-CLI-Sessions speichern laut offizieller Dokumentation Tokenstatistiken in den Chatdaten unter `~/.gemini/tmp/<project_hash>/chats/`. Dieses interne Dateiformat ist jedoch kein ACP-Vertrag und sollte nicht automatisch von GeminUI geparst werden. Siehe [Gemini CLI Session Management](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/session-management.md).

### 9. Renderer

Der Reducer und `ChatHeader` können etwas anzeigen, sobald überhaupt ein `usage.updated` ankommt. Aktuell gibt es dennoch fachliche und UX-Probleme:

- `used` fällt auf `totalTokens` zurück und umgekehrt. Dadurch wird Tokenverbrauch als Kontextbelegung ausgegeben.
- Ohne Usage wird die Pill vollständig ausgeblendet. Für den Benutzer wirkt das wie eine defekte Funktion statt wie „vom Agenten noch nicht gemeldet“.
- Die Beschriftung unterscheidet nicht zuverlässig zwischen „aktueller Kontext“, „letzter Turn“ und „Sessionverbrauch“.
- Es gibt keinen Hinweis, ob ein Wert vollständig, nur seit Aktivierung der Erfassung oder vom Provider kumulativ gemeldet ist.

## Fachlich korrekte Begriffe

Die Implementierung soll folgende Werte getrennt halten:

| Wert | Bedeutung | Bei Gemini CLI 0.56.0 verfügbar |
|---|---|---:|
| Turn Input | Summe der von Gemini im aktuellen `session/prompt` gemeldeten Eingabe-Token über interne Modellaufrufe | Ja, nach Turn-Ende |
| Turn Output | Summe der Ausgabe-Token des aktuellen Turns | Ja, nach Turn-Ende |
| Turn Total | Provider-Gesamtwert oder ersatzweise `input + output` | Teilweise |
| Session Consumption | Kumulierte verbrauchte Token aller von GeminUI beobachteten Turns | Durch GeminUI berechenbar |
| Context Used | Token, die aktuell das Modellkontextfenster belegen | Nein |
| Context Size | effektive Größe des aktuellen Modellkontextfensters | Nein |
| Thought/Cache/Tool Tokens | detaillierte API-Aufschlüsselung | Durch Gemini ACP 0.56.0 verworfen |
| Cost | kumulative Kosten der Session | Nein |

Googles zugrunde liegende API kann deutlich mehr liefern: `promptTokenCount`, `candidatesTokenCount`, `totalTokenCount`, `toolUsePromptTokenCount`, `thoughtsTokenCount` und `cachedContentTokenCount`. Siehe [Google `UsageMetadata`](https://ai.google.dev/api/generate-content). Dass diese Werte in der API existieren, bedeutet aber nicht, dass GeminUI sie außerhalb des Gemini-CLI-Prozesses sehen kann.

## Empfohlener Datenvertrag

Das öffentliche Event sollte einen vollständigen Snapshot statt eines mehrdeutigen flachen Patches enthalten. Beispiel:

```ts
type TokenCounters = {
  input: number | null;
  output: number | null;
  total: number | null;
  thought: number | null;
  cachedRead: number | null;
  cachedWrite: number | null;
  tool: number | null;
  totalKind: "provider" | "derived_input_plus_output" | null;
};

type UsageSnapshot = {
  revision: number;
  lastTurn: {
    turnId: string;
    tokens: TokenCounters;
    byModel: Array<{
      model: string;
      input: number;
      output: number;
    }>;
    source: "acp_prompt_usage" | "gemini_meta_quota";
  } | null;
  session: {
    tokens: TokenCounters;
    coverage: "complete" | "partial" | "provider_reported";
    source: "geminui_aggregate" | "acp_prompt_usage";
  } | null;
  context: {
    used: number;
    size: number;
    source: "acp_usage_update";
  } | null;
  cost: {
    amount: number;
    currency: string;
    source: "acp_usage_update";
  } | null;
  updatedAt: string;
};

type UsageUpdatedEvent = {
  type: "usage.updated";
  snapshot: UsageSnapshot;
};
```

Der Snapshot hat mehrere Vorteile:

- Ein Kontext-Update löscht nicht versehentlich bestehende Sessionzähler.
- Der Renderer muss keine mehrdeutigen Patchregeln erraten.
- Der letzte persistierte Snapshot reicht beim Neustart.
- Quellen und Abdeckungsgrad sind sichtbar und testbar.
- Ein Modellwechsel kann den Kontextteil gezielt auf `null` setzen, ohne Tokenhistorie zu verlieren.

### Scope-Regeln

Die Provider-Normalisierung soll eine interne Observation mit explizitem Scope liefern:

```ts
type UsageObservation =
  | {
      kind: "tokens";
      scope: "turn" | "session_cumulative";
      source: "gemini_meta_quota" | "acp_prompt_usage";
      tokens: TokenCounters;
      byModel: ModelUsage[];
    }
  | {
      kind: "context";
      source: "acp_usage_update";
      used: number;
      size: number;
      cost: Cost | null;
    };
```

Regeln:

1. `PromptResponse.usage` ist nach dem Vertrag des installierten SDK zunächst als `session_cumulative` zu behandeln und ersetzt den bisherigen Sessionstand, statt aufaddiert zu werden.
2. Geminis `_meta.quota.token_count` ist für die geprüfte CLI als `turn` bekannt und wird genau einmal pro `turnId` aggregiert.
3. Wenn zukünftig beide Felder vorkommen, ist `PromptResponse.usage` für den Sessionstand maßgeblich; `_meta.quota` darf weiterhin die Aufteilung des letzten Turns und `model_usage` liefern, aber nicht doppelt in den Sessionstand eingehen.
4. `usage_update.used` darf niemals in `session.tokens.total` kopiert werden.
5. `size <= 0`, negative Werte, nicht endliche Zahlen und Werte außerhalb des sicheren JavaScript-Integerbereichs werden verworfen und diagnostiziert, nicht gerundet.
6. Fehlt `total`, darf bei Gemini `_meta` `input + output` berechnet werden. Der Snapshot markiert dies mit `totalKind: "derived_input_plus_output"`.

## Implementierungsplan

### Phase 1: Provider-Usage robust normalisieren

Neue Datei `src/main/gemini/usage.ts`:

- `parsePromptUsage(response: PromptResponse): UsageObservation | null`;
- zuerst standardisiertes `response.usage` validieren;
- zusätzlich Gemini `_meta.quota.token_count` und `_meta.quota.model_usage` mit einem engen, defensiven Schema auswerten;
- `snake_case` nur an dieser Providergrenze kennen;
- Null, unbekannte zusätzliche Felder und kaputte Teilwerte ohne Prozessabbruch behandeln;
- keine Roh-`_meta`-Daten in Renderer oder Datenbank durchreichen.

`src/main/gemini/types.ts`:

- `GeminiTurnResult.usage?: unknown` und `turn.completed.payload.usage?: unknown` durch typisierte Observations ersetzen;
- native Kontextmeldungen nicht mehr als denselben internen Eventtyp wie Tokenverbrauch modellieren, beispielsweise `usage.context.observed` und `usage.tokens.observed`.

`src/main/gemini/acp-session.ts`:

- Prompt-Antwort genau einmal parsen;
- eine Token-Observation **vor** `turn.completed` emittieren, damit der aktive `turnId` im `AppController` noch vorhanden ist;
- native `usage_update` sofort weiterreichen;
- Event-Reihenfolge garantieren: letzte Content-/Tool-Updates, Usage-Observation, `turn.completed`.

### Phase 2: Persistente, idempotente Aggregation

Migration mit zwei Tabellen:

```sql
CREATE TABLE turn_usage (
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  source TEXT NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,
  thought_tokens INTEGER,
  cached_read_tokens INTEGER,
  cached_write_tokens INTEGER,
  tool_tokens INTEGER,
  model_usage_json TEXT,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (session_id, turn_id),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
) STRICT;

CREATE TABLE session_usage (
  session_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  updated_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
) STRICT;
```

`turn_usage` verhindert Doppelzählungen nach Fehlern, Wiederholungen oder einem späteren Replay. Die Transaktion soll:

1. die Turn-Observation mit `INSERT ... ON CONFLICT DO NOTHING` reservieren;
2. nur bei einer neuen Zeile den aggregierten Sessionstand erhöhen;
3. den vollständigen `session_usage`-Snapshot aktualisieren;
4. anschließend ein öffentliches `usage.updated` mit genau diesem Snapshot persistieren und publizieren.

Falls die allgemeine Eventzeile nicht in derselben Repository-Transaktion erzeugt werden kann, ist `session_usage` die autoritative Quelle. Ein fehlendes UI-Event kann beim nächsten Subscription-Start aus dem Snapshot geheilt werden; die Tokenzähler dürfen trotzdem nicht doppelt erhöht werden.

### Phase 3: Neustart und lange Sessions

`EventSubscriptionResultSchema` soll zusätzlich einen aktuellen `usageSnapshot` enthalten. Alternativ kann ein separates `sessions:get-usage`-IPC angeboten werden. Der Snapshot darf nicht davon abhängen, ob das letzte Usage-Event unter den ersten 1000 Replay-Events liegt.

Außerdem sollte das allgemeine Session-Replay paginiert oder auf die neuesten relevanten Events umgestellt werden. Für die Usage-Anzeige ist der dedizierte Snapshot jedoch die verlässlichere und performantere Quelle.

Abdeckungsgrad beim Migrieren:

- neue GeminUI-Session ohne frühere Turns: `complete`;
- bestehende Session mit Turns vor Einführung der Usage-Erfassung: `partial`;
- vom Provider ausdrücklich kumulativ gemeldeter Sessionstand: `provider_reported`;
- ein historisches `used/size`-Event darf nicht als Tokenverbrauch migriert werden.

### Phase 4: Shared Contract, IPC und Renderer

`src/shared/contracts/events.ts`:

- verschachteltes `UsageSnapshotSchema` einführen;
- sichere Integer, ISO-Währungscode und konsistente Nullbarkeit prüfen;
- `cost` in den echten Vertrag aufnehmen;
- Legacy-Usage nur lesekompatibel halten, aber in einen eindeutig als Legacy markierten Snapshot überführen.

`src/main/app-controller.ts`:

- Token- und Kontext-Observations über einen `UsageService` verarbeiten;
- keinen Kontextwert in `totalTokens` kopieren;
- Usage-Snapshot vor `turn.completed` in die öffentliche Eventfolge stellen;
- bei Modellwechsel den bisherigen Kontextstand als veraltet entfernen, bis der Agent einen neuen meldet.

`src/renderer/features/chat/reducer.ts`:

- vollständige Snapshots ersetzen, nicht flache Felder gegenseitig als Fallback benutzen;
- initialen Usage-Snapshot aus der Subscription übernehmen;
- Legacy-Events nur über eine eigene Kompatibilitätsfunktion verarbeiten.

`src/renderer/features/chat/ChatHeader.tsx`:

- Pill immer anzeigen, zunächst beispielsweise `Token: –` mit Tooltip „Gemini hat noch keine Nutzung gemeldet“;
- wenn Kontext vorhanden: `Kontext 12.345 / 1.048.576 · 1 %`;
- sonst wenn Sessionverbrauch vorhanden: `Session 18,4 Tsd. Token`;
- Tooltip mit Input, Output, letztem Turn, Quelle und Abdeckungsgrad;
- bei `partial`: sichtbar „seit Erfassung“ statt „Session gesamt“;
- während eines laufenden Turns bei Gemini 0.56.0: letzten Stand plus „Aktualisierung nach Abschluss dieses Turns“;
- Kosten nur anzeigen, wenn der Agent sie wirklich meldet.

### Phase 5: Zukunftsfähige native ACP-Unterstützung

Wenn eine spätere Gemini CLI `usage_update` sendet, soll GeminUI ohne Sonderfall sofort präzisere Kontextwerte anzeigen. Wenn sie `PromptResponse.usage` füllt, soll der Standardpfad Vorrang vor dem Gemini-Fallback erhalten.

Bei der Capability-Erkennung kann zusätzlich die Agentversion im Diagnosezustand gespeichert werden. Verhalten darf jedoch nicht ausschließlich an einer Versionsnummer hängen; entscheidend ist der tatsächlich empfangene Payload.

## Was „so live wie möglich“ konkret bedeutet

### Mit Gemini CLI 0.56.0

- Text, Gedanken und Tools streamen live.
- Exakte Tokenzahlen werden von der CLI erst mit der abschließenden Prompt-Antwort freigegeben.
- GeminUI kann die Anzeige unmittelbar nach deren Empfang aktualisieren, typischerweise direkt vor dem Wechsel von „arbeitet“ zu „bereit“.
- Während des laufenden Turns ist nur der Stand des vorherigen Turns exakt.

### Mit einem Agenten, der `usage_update` sendet

- Jedes empfangene Kontext-/Kosten-Update wird sofort durchgereicht, persistiert und angezeigt.
- GeminUI braucht dafür kein Polling.
- Die tatsächliche Frequenz bestimmt der Agent.

### Für echtes In-Turn-Live-Tracking mit Gemini

Dafür wäre eine Änderung in Gemini CLI nötig: Sie müsste nach jedem internen `GeminiEventType.Finished` ein `usage_update` oder eine gleichwertige Token-Notification senden. Für einen korrekten Kontextwert müsste die CLI zusätzlich die effektive Kontextfenstergröße des wirklich verwendeten Modells kennen und melden.

Das ist in GeminUI allein nicht exakt rekonstruierbar, weil der Client unter anderem den vollständigen Systemprompt, interne Toolrepräsentationen, Kompressionen, Cachebelegung, automatische Modellwechsel und Provider-Tokenisierung nicht kennt.

## Fallback-Priorität

| Priorität | Quelle | Aktualität | Liefert |
|---:|---|---|---|
| 1 | ACP `usage_update` | potenziell während des Turns | Kontext `used/size`, optional Kosten |
| 2 | ACP `PromptResponse.usage` | Turn-Ende | standardisierte Tokenzähler, Scope beachten |
| 3 | Gemini `_meta.quota.token_count` | Turn-Ende | Input/Output des aktuellen Prompt-Turns |
| 4 | persistierter GeminUI-Snapshot | sofort beim Öffnen | letzter bekannter Session-/Kontextstand |
| 5 | keine Daten | ehrlich leer | `Token: –`, kein erfundener Wert |

## Nicht empfohlene Fallbacks

### Modelllimits hart codieren

Nicht verwenden. Modellaliases, Previewmodelle, Enterprise-Endpunkte, automatische Modellwahl und Limits ändern sich. Selbst eine richtige `size` löst nicht das Problem des unbekannten `used`.

### Token lokal aus Chattext schätzen

Nicht als exakten Wert ausgeben. GeminUI sieht nicht alle Inhalte, die Gemini an das Modell sendet. Bilder, Tools, versteckte Instruktionen, Gedanken, Kompression und Caches machen die Abweichung systematisch.

### `/stats model` automatisch senden und Text parsen

Gemini dokumentiert `/stats model` als interaktiven Snapshot. Dessen menschenlesbare Ausgabe ist aber kein stabiler ACP-Datenvertrag, kann sich ändern und würde als zusätzlicher Command-Turn in die Session eingreifen. Allenfalls als explizite Diagnosefunktion, nicht als Datenquelle der Headeranzeige.

### Telemetriedateien live verfolgen

Nicht als Produktpfad. Das Format ist nicht der ACP-Vertrag, die Konfiguration ist global, Sessions müssen sauber korreliert werden, Dateien können sensible Metadaten enthalten und die Verfügbarkeit hängt von Benutzereinstellungen ab.

### `~/.gemini/tmp/.../chats` automatisch parsen

Nicht für Live-Tracking und nicht standardmäßig für Backfills. Die Dateien gehören zur internen Persistenz der Gemini CLI, ihr Format und Speicherort können sich ändern, und Multi-Root-/Plattformzuordnung ist fehleranfällig. Eine spätere, explizit ausgelöste Importfunktion müsste versionsgebunden, read-only und mit klarer Vorschau gebaut werden.

### Direkt die Google API zusätzlich aufrufen

Nicht verwenden. GeminUI müsste Authentifizierungsdaten duplizieren, Enterprise-/Vertex-/Gateway-Konfigurationen nachbauen und könnte trotzdem nicht sicher den tatsächlichen CLI-Kontext reproduzieren. Außerdem entstünden zusätzliche Netzwerkaufrufe und potenziell Kosten.

## Testplan

### Unit-Tests: Providerparser

- standardisiertes `PromptResponse.usage` vollständig;
- Gemini `_meta.quota.token_count` in `snake_case`;
- `model_usage` mit einem und mehreren Modellen;
- Standardfeld und Gemini-Fallback gleichzeitig, ohne Doppelzählung;
- Werte null und null Token;
- fehlendes `quota`, fehlendes `token_count`, falsche Typen;
- negative, nicht endliche und nicht sichere Integer;
- Provider-Gesamtwert versus aus `input + output` abgeleiteter Wert;
- unbekannte `_meta`-Felder werden ignoriert.

### Unit-Tests: Eventnormalisierung

- natives `usage_update` behält `used`, `size` und `cost`;
- Token-Observation kommt vor `turn.completed`;
- `turn.completed` verwirft die Usage nicht;
- Kontextbelegung wird nie zu Session-Tokenverbrauch;
- Modellwechsel invalidiert nur Kontext, nicht Verbrauchshistorie.

### Unit-Tests: Aggregation und Storage

- zwei unterschiedliche Turns werden genau einmal summiert;
- dieselbe `turnId` zweimal bleibt idempotent;
- `session_cumulative` ersetzt statt addiert;
- eine `turn`-Observation plus späterer kumulativer Providerstand zählt nicht doppelt;
- Datenbankneustart liefert identischen Snapshot;
- Löschung einer Session löscht Usage per Foreign Key;
- vorhandene Sessions werden mit korrektem `coverage` migriert;
- mehr als 1000 Timeline-Events verhindern den Usage-Restore nicht.

### Fake-Agent-Tests

Mindestens drei getrennte Fixtures:

1. **Gemini 0.56 realistisch:** kein `usage_update`, kein `response.usage`, nur `_meta.quota`;
2. **ACP vollständig:** natives `usage_update` plus standardisiertes `response.usage`;
3. **defekter/alter Agent:** keinerlei Usage oder fehlerhafte Werte.

Der wichtigste Regressionstest muss Fixture 1 verwenden. Er soll beweisen, dass nach dem Turn ein öffentliches `usage.updated` mit Input, Output und aggregiertem Sessionstand im EventRepository steht.

### Renderer-Tests

- vor der ersten Messung sichtbarer Platzhalter;
- Sessionverbrauch ohne erfundene Kontextgröße;
- Kontextanzeige nur bei echtem `used/size`;
- korrekte Prozentberechnung und Clamping nur für die Balkendarstellung;
- „seit Erfassung“ bei partiellen Daten;
- Kosten nur bei realem Kostenwert;
- neuer Snapshot ersetzt atomar den alten;
- Neustartinitialisierung aus Subscription-Snapshot;
- laufender Turn zeigt letzten Stand und Aktualisierungshinweis.

### Integrations- und Smoke-Tests

- NDJSON-Trace einer echten Gemini-0.56-Prompt-Antwort als nicht sensibles Fixture aufnehmen;
- optionaler manueller Smoke-Test mit authentifizierter lokaler CLI, nicht verpflichtend in CI;
- prüfen, dass keine API-Schlüssel, Promptinhalte oder rohe `_meta`-Objekte in Diagnoseausgaben landen;
- Windows 10/11 und macOS verwenden denselben Parser und dieselbe SQLite-Logik.

## Akzeptanzkriterien

1. Mit Gemini CLI 0.56.0 erscheint nach einem erfolgreichen Turn eine Tokenanzeige, obwohl weder `usage_update` noch `PromptResponse.usage` geliefert wurden.
2. Die Anzeige wird spätestens 200 ms nach Verarbeitung der abschließenden Prompt-Antwort aktualisiert und vor beziehungsweise zusammen mit dem sichtbaren Wechsel auf „Bereit“ publiziert.
3. Input und Output entsprechen exakt `_meta.quota.token_count`; ein abgeleitetes Total ist als solches markiert.
4. Zwei beobachtete Turns ergeben einen korrekten, nicht doppelt gezählten Sessionverbrauch.
5. Ohne `used/size` wird kein Prozentbalken und keine Kontextfenstergröße erfunden.
6. Bei echtem ACP-`usage_update` wird `used/size` sofort angezeigt; Kosten werden vollständig durchgereicht.
7. Nach App-Neustart ist der letzte Usage-Snapshot ohne neuen Prompt sichtbar, auch bei mehr als 1000 Timeline-Events.
8. Bestehende Sessions ohne vollständige historische Tokenwerte werden sichtbar als „seit Erfassung“ gekennzeichnet.
9. Fehlerhafte oder unbekannte Usage-Payloads brechen weder ACP-Verbindung noch Turn ab.
10. Der Fake Agent besitzt einen realistischen Gemini-0.56-Modus; grüne Tests hängen nicht mehr von einem von Gemini derzeit nicht gesendeten `usage_update` ab.
11. Standardisierte zukünftige `PromptResponse.usage`-Werte funktionieren ohne erneute Rendereränderung.
12. Während eines laufenden Gemini-0.56-Turns behauptet die UI nicht, bereits den aktuellen Turn zu kennen.

## Grenzen und offene Upstream-Abhängigkeiten

- Exakte In-Turn-Aktualisierung ist mit der heutigen Gemini-ACP-Ausgabe nicht implementierbar.
- Kontextfensterbelegung und -größe sind mit Gemini CLI 0.56.0 nicht verfügbar.
- Gedanken-, Cache-, Tool- und echte Gesamt-Token gehen im Gemini-ACP-Adapter verloren, obwohl die Google API solche Felder grundsätzlich kennt.
- Kosten werden nicht gemeldet.
- Historische Provider-Sessionwerte vor Einführung der GeminUI-Erfassung sind ohne einen expliziten, fragilen Import nicht vollständig rekonstruierbar.
- ACP-Usage ist im SDK 1.3.0 noch als experimentell markiert; Parser und Vertrag brauchen Vorwärtskompatibilität.

Diese Grenzen sollen in der UI sichtbar und nicht durch Schätzwerte verdeckt werden.

## Empfohlene Umsetzungsreihenfolge

1. Gemini-`_meta.quota`-Parser und realistische Fake-Fixture.
2. Getrennte interne Observations für Token und Kontext.
3. Idempotente Turn-Aggregation und persistierter Session-Snapshot.
4. Shared Contract und IPC-Snapshot.
5. Rendererbeschriftung und Platzhalter.
6. Vollständiger Testplan inklusive Neustart und 1000-Event-Grenze.
7. Optional später: Upstream-Beitrag an Gemini CLI für standardisierte `PromptResponse.usage`- und `usage_update`-Ausgabe.

Damit liefert GeminUI kurzfristig korrekte Tokenzahlen am frühestmöglichen Zeitpunkt, bleibt bei nicht verfügbaren Kontextdaten ehrlich und kann spätere Verbesserungen der Gemini CLI ohne erneuten UI-Umbau nutzen.
