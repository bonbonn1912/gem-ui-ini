# GeminUI

GeminUI ist ein schlanker Tauri-2-Desktop-Client für die lokal installierte Gemini CLI. Das Backend läuft in Rust, die Oberfläche in SolidJS. Die App verwaltet mehrere Projekte und Sessions, streamt ACP-Antworten, zeigt Tool-Aufrufe und Freigaben und unterstützt Bilder per Auswahl, Drag-and-drop und Zwischenablage.

## Voraussetzungen und Anmeldung

- macOS oder Windows 10/11 (64 Bit) mit lokal installierter Gemini CLI. Google empfiehlt für die aktuelle Gemini CLI offiziell Windows 11 24H2 oder neuer; Windows 10 ist deshalb Best-Effort und wird separat getestet.
- Installation: `npm install -g @google/gemini-cli`
- Google-/Workspace-/Enterprise-Anmeldung: einmal `gemini` im Terminal bzw. in PowerShell starten und **Sign in with Google** wählen. GeminUI verwendet anschließend ausschließlich die von Gemini CLI lokal zwischengespeicherte Anmeldung.
- Unternehmens-/Workspace-Konten benötigen je nach Organisation zusätzlich `GOOGLE_CLOUD_PROJECT` und die von der Administration vorgegebene Auth-Policy.
- API-Key: `GEMINI_API_KEY` für Gemini CLI dauerhaft konfigurieren (empfohlen in der Gemini-Konfiguration bzw. einer von Gemini geladenen `.gemini/.env`) und einmal in `gemini` **Use Gemini API key** wählen. Der Schlüssel wird von GeminUI weder in SQLite noch im Renderer gespeichert.

Unter Windows löst GeminUI den üblichen npm-Wrapper `gemini.cmd` auf den verifizierten `@google/gemini-cli`-JavaScript-Einstiegspunkt auf und startet ihn mit `node.exe` ohne Shell. Unter macOS werden Homebrew-Pfade wie `/opt/homebrew/bin` auch bei einem Finder-Start erkannt.

Ein Projekt besitzt genau einen Hauptordner und bis zu fünf zusätzliche Ordner an beliebigen Orten. Der Hauptordner wird Geminis `cwd`; alle weiteren Roots werden als einzelne `--include-directories`-Argumente an denselben Gemini-Prozess übergeben.

## Voraussetzungen

- macOS, Linux oder Windows mit einer kompatiblen Node-/Gemini-CLI-Installation
- Rust Stable und die [Tauri-Systemvoraussetzungen](https://v2.tauri.app/start/prerequisites/) für die jeweilige Plattform
- Gemini CLI `0.56.0` oder neuer mit `--acp`
- eine funktionierende Gemini-CLI-Anmeldung

Vor dem ersten App-Start sollte dieser Befehl im Terminal ohne Authentifizierungsfehler funktionieren:

```bash
gemini
```

Die App verwendet die vorhandene Gemini-Anmeldung und speichert selbst keine API-Schlüssel. Wenn eine Desktop-App einen anderen `PATH` als das Terminal erhält, kann die Gemini-Binary im Onboarding nativ ausgewählt werden.

## Entwicklung

```bash
npm install
npm start
```

Wichtige Prüfungen:

```bash
npm run typecheck
npm test
npm run verify
npm run build
```

## Paket erzeugen

macOS (auf einem Mac):

```bash
npm ci
npm run make
```

DMG und App-Bundle liegen anschließend unter
`src/target/release/bundle/` (bei explizitem Target unter dem jeweiligen
Target-Unterordner).

Windows (in PowerShell auf Windows 10/11):

```powershell
npm ci
npm run make
```

NSIS- und MSI-Installer liegen anschließend unter
`src\target\release\bundle\`. Alternativ erzeugt der Workflow
`.github/workflows/windows.yml` das Artefakt auf `windows-2022`.

### Signierte Updates

Der Updater liest das signierte Tauri-Manifest
`https://github.com/bonbonn1912/gem-ui-ini/releases/latest/download/latest.json`.
Lokale Builds bleiben deshalb absichtlich ohne Update-Artefakte. Der
Tag-Release-Workflow aktiviert sie und benötigt dafür zwei Repository-Secrets:

- `TAURI_SIGNING_PRIVATE_KEY`: Inhalt des privaten Schlüssels, der zur
  öffentlichen Key-Zeile in `src/tauri.conf.json` gehört
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: Passwort des Schlüssels (leer, falls
  der Schlüssel ohne Passwort erzeugt wurde)

Der private Schlüssel darf niemals committed oder in Logs ausgegeben werden.
Der GitLab-Tag-Build verwendet dieselben CI-Variablen. Ohne diese Variable
schlagen signierte Tag-Releases absichtlich mit einer klaren Fehlermeldung
fehl; Merge-Request- und `main`-Builds bleiben unsigniert und benötigen kein
Secret.

Tauri legt alle Ergebnisse unter `src/target/release/bundle/` ab. Lokale Entwicklungsartefakte sind
nicht notarisiert beziehungsweise für eine öffentliche Verteilung signiert.
Für einen Firmen-PC ist keine Microsoft-Store-Veröffentlichung nötig; eine
Unternehmensrichtlinie kann unsignierte Installer jedoch blockieren. Für eine
öffentliche oder breite interne Verteilung sollte der Windows-Workflow um
Authenticode/Artifact Signing und der macOS-Build um Developer-ID-Signierung
und Notarisierung ergänzt werden.

### macOS-Ordnerzugriff nach einem Neubau

macOS ordnet Datenschutzfreigaben der signierten App-Identität zu. Lokale
GeminUI-Builds sind ohne Developer-ID-Zertifikat nur ad-hoc signiert; nach einem
Neubau kann macOS deshalb den Zugriff auf einen bereits gespeicherten Ordner in
`Dokumente`, `Schreibtisch` oder `Downloads` erneut verlangen. Öffne in diesem
Fall die Projekteinstellungen und klicke beim betroffenen Root auf `Zugriff`.
Wähle exakt denselben Ordner erneut aus. GeminUI verändert dabei weder das
Projekt noch die Session-Historie. Ein stabil signiertes und notarisiertes
Release behält eine verlässliche App-Identität über Versionen hinweg.

## Funktionsumfang

### Stand von 0.11.0

Version 0.11.0 ist der native technische Rewrite mit vollständiger
Feature-Parität zur früheren Desktop-Anwendung. Produktiv verdrahtet sind die
Tauri-Shell, SQLite/WAL und Migrationen sowie Projektverwaltung einschließlich
Root-Validierung, Reautorisierung und Idempotenz. ACP-Prozesssteuerung,
Session-Limit, Permission-Broker, Event-Batching, Binary-Probing sowie Git-
und Diff-Parser sind in Rust implementiert und getestet. Sämtliche Session-,
Attachment-, Todo-, GitLab-, Jira-, Update- und Integrations-Commands sind über
die typisierte Tauri-Brücke an die SolidJS-Oberfläche angeschlossen. Native
Dateiauswahl, Drag-and-drop, Link-Vorschau und der signaturgeprüfte Tauri-Updater
ersetzen die früheren Electron-Pfade vollständig.

Der umgesetzte Funktionsumfang umfasst:

- native Projekte mit einem unveränderlichen Primary Root und bis zu fünf Additional Roots
- Projektordner später hinzufügen oder entfernen; laufende Turns schützen die Root-Änderung
- mehrere persistente Sessions pro Projekt
- genau ein isolierter `gemini --acp`-Child-Prozess pro aktiver Session, maximal drei gleichzeitig
- Session-Recovery über `session/load` und den jeweils aktuellen Root-Satz
- live gestreamte Markdown-Antworten, Gedanken- und Toolkarten
- exakte ACP-Permission-Optionen mit Allow/Reject-Antwort
- semantischer Abbruch über `session/cancel`, danach kontrollierter Prozess-Fallback
- PNG, JPEG, WebP und GIF per Picker, Drop oder Paste
- SQLite-Timeline und sequenzierter Replay nach Renderer-Reload
- keine HTTP-Ports und kein Cloud-Backend der UI

## Sicherheitsmodell

Der SolidJS-Renderer hat keinen Node-Zugriff. Tauri-Capabilities erlauben pro Fenster nur die benötigten Commands; der Vorschau-Webview erhält keine App-Commands. Rust deserialisiert und validiert Eingaben typisiert. Navigation und neue Fenster sind standardmäßig gesperrt. Markdown wird ohne Raw HTML gerendert, und externe Links dürfen nur als validiertes `https:` im Systembrowser geöffnet werden.

Die Auswahl aller Projektordner ist die explizite Trust-Entscheidung. Deshalb startet die App Gemini mit `--skip-trust`; Geminis Tool-Freigaben bleiben davon unberührt. Die Root-Liste ist keine Betriebssystem-Sandbox: Für eine harte Isolation muss zusätzlich Geminis eigener Sandbox-Modus verwendet werden.

Der verbindliche Migrationsplan, die Zielarchitektur, Risiken und Abnahmekriterien stehen in [rewrite.md](./rewrite.md).
