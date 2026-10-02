# GeminUI

GeminUI ist ein nativer Electron-Client für die lokal installierte Gemini CLI. Die App verwaltet mehrere Projekte und Sessions, streamt ACP-Antworten, zeigt Tool-Aufrufe und Freigaben und unterstützt Bilder per Auswahl, Drag-and-drop und Zwischenablage.

## Voraussetzungen und Anmeldung

- macOS, Linux oder Windows 10/11 (64 Bit) mit lokal installierter Gemini CLI. Google empfiehlt für die aktuelle Gemini CLI offiziell Windows 11 24H2 oder neuer; Windows 10 ist deshalb Best-Effort.
- Installation: `npm install -g @google/gemini-cli`
- Google-/Workspace-/Enterprise-Anmeldung: einmal `gemini` im Terminal bzw. in PowerShell starten und **Sign in with Google** wählen. GeminUI verwendet anschließend ausschließlich die von Gemini CLI lokal zwischengespeicherte Anmeldung.
- Unternehmens-/Workspace-Konten benötigen je nach Organisation zusätzlich `GOOGLE_CLOUD_PROJECT` und die von der Administration vorgegebene Auth-Policy.
- API-Key: `GEMINI_API_KEY` für Gemini CLI dauerhaft konfigurieren (empfohlen in der Gemini-Konfiguration bzw. einer von Gemini geladenen `.gemini/.env`) und einmal in `gemini` **Use Gemini API key** wählen. Der Schlüssel wird von GeminUI weder in SQLite noch im Renderer gespeichert.

Unter Windows löst GeminUI den üblichen npm-Wrapper `gemini.cmd` auf den verifizierten `@google/gemini-cli`-JavaScript-Einstiegspunkt auf und startet ihn mit `node.exe` ohne Shell. Unter macOS werden Homebrew-Pfade wie `/opt/homebrew/bin` auch bei einem Finder-Start erkannt.

Ein Projekt besitzt genau einen Hauptordner und bis zu fünf zusätzliche Ordner an beliebigen Orten. Der Hauptordner wird Geminis `cwd`; alle weiteren Roots werden als einzelne `--include-directories`-Argumente an denselben Gemini-Prozess übergeben.

GeminUI prüft beim Start die ausgewählte Gemini-Binary und das verfügbare ACP-Startflag (`--acp` oder `--experimental-acp`). Die Projektanforderung `0.56.0 oder neuer` ist keine Zusage, dass jede CLI-Version und jede ACP-Funktion mit GeminUI getestet wurde. Für 0.60.x und 0.61.x liegt mit v0.16.0 keine vollständige reale Kompatibilitätsmatrix vor.

## Entwicklung

```bash
npm install
npm start
```

Wichtige Prüfungen:

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e
```

Der reale ACP-Multi-Root-Smoke-Test ist bewusst opt-in, weil er die lokal installierte und angemeldete Gemini CLI startet:

```bash
npm run test:gemini
```

## Paket erzeugen

macOS (auf einem Mac):

```bash
npm ci
npm run make
```

Das ZIP liegt anschließend unter
`out/make/zip/darwin/arm64/GeminUI-darwin-arm64-0.1.0.zip` (auf Intel
entsprechend `x64`). `npm run package` erzeugt nur das lokale `.app`-Bundle.

Windows (in PowerShell auf Windows 10/11):

```powershell
npm ci
npm run make
```

Der Squirrel-Installer liegt anschließend unter
`out\make\squirrel.windows\x64\`. Windows-Artefakte sollten wegen Electron und
der nativen SQLite-Binary auf Windows gebaut werden. Alternativ erzeugt der
Workflow `.github/workflows/windows.yml` das Artefakt auf `windows-2022`.

Forge legt alle Ergebnisse unter `out/` ab. Lokale Entwicklungsartefakte sind
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

- native Projekte mit einem unveränderlichen Primary Root und bis zu fünf Additional Roots
- Projektordner später hinzufügen oder entfernen; laufende Turns schützen die Root-Änderung
- mehrere persistente Sessions pro Projekt
- isolierte Gemini-Child-Prozesse innerhalb des gewählten Ressourcenbudgets; aktive Sessions können bei Platzmangel auf einen freien Slot warten
- Session-Recovery bevorzugt über `session/resume`, mit `session/load` als kompatiblem Fallback und dem jeweils aktuellen Root-Satz
- live gestreamte Markdown-Antworten, Gedanken- und Toolkarten
- ausgehandelte ACP-Konfigurationsoptionen einschließlich Modell-/Modusfeldern und booleschen Werten, soweit der Agent sie anbietet
- ACP-Pläne, verfügbare Slash Commands sowie Formular- und URL-Rückfragen, wenn der Agent die jeweilige Funktion unterstützt
- exakte ACP-Permission-Optionen mit Allow/Reject-Antwort
- semantischer Abbruch über `session/cancel`, danach kontrollierter Prozess-Fallback
- PNG, JPEG, WebP und GIF per Picker, Drop oder Paste
- paginierte SQLite-Timeline, Textsuche in Nachrichten und sequenzierter Replay nach Renderer-Reload
- virtuelle Timeline- und Dateiviewer-Zeilen sowie ein einstellbares Ressourcenprofil
- keine HTTP-Ports und kein Cloud-Backend der UI

Das Profil **Sparsam** hält höchstens einen Gemini-Prozess und gibt inaktive Sessions unmittelbar frei. **Ausgewogen** erlaubt zwei Prozesse und gibt inaktive Sessions nach 90 Sekunden frei. **Leistung** erlaubt drei Prozesse mit 180 Sekunden Leerlaufzeit. Ausgelagerte Anhangstextextraktion verwendet einen eigenen Utility-Prozess, der nach Leerlauf endet.

Die vollständige Umsetzungszuordnung und offene Grenzen stehen in [docs/v0.16.0-implementation.md](./docs/v0.16.0-implementation.md). Dort sind auch die unverifizierten CLI-/Plattformannahmen genannt.

## Sicherheitsmodell

Der Renderer läuft ohne Node-Integration in einer Sandbox. Die Preload-Bridge bietet nur konkrete, typisierte Aktionen; der Main-Prozess validiert jeden IPC-Payload und den Absender erneut. Navigation, neue Fenster und Chromium-Permissions sind standardmäßig gesperrt. Markdown wird ohne Raw HTML gerendert, und externe Links dürfen nur als validiertes `https:` im Systembrowser geöffnet werden.

Die Auswahl aller Projektordner ist die explizite Trust-Entscheidung. Deshalb startet die App Gemini mit `--skip-trust`; Geminis Tool-Freigaben bleiben davon unberührt. Die Root-Liste ist keine Betriebssystem-Sandbox: Für eine harte Isolation muss zusätzlich Geminis eigener Sandbox-Modus verwendet werden.

Die ausführliche Architektur, Datenmodelle, Risiken und Abnahmekriterien stehen in [implementation.md](./implementation.md).
