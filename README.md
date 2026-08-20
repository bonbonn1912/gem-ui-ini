# GeminUI

GeminUI ist ein nativer Electron-Client für die lokal installierte Gemini CLI. Die App verwaltet mehrere Projekte und Sessions, streamt ACP-Antworten, zeigt Tool-Aufrufe und Freigaben und unterstützt Bilder per Auswahl, Drag-and-drop und Zwischenablage.

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
npm run build
npm run test:e2e
```

Der reale ACP-Multi-Root-Smoke-Test ist bewusst opt-in, weil er die lokal installierte und angemeldete Gemini CLI startet:

```bash
npm run test:gemini
```

## Paket erzeugen

```bash
npm run package
npm run make
```

Forge legt die Ergebnisse unter `out/` ab. Lokale Entwicklungsartefakte sind nicht notarisiert beziehungsweise für eine öffentliche Verteilung signiert.

## Funktionsumfang

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

Der Renderer läuft ohne Node-Integration in einer Sandbox. Die Preload-Bridge bietet nur konkrete, typisierte Aktionen; der Main-Prozess validiert jeden IPC-Payload und den Absender erneut. Navigation, neue Fenster und Chromium-Permissions sind standardmäßig gesperrt. Markdown wird ohne Raw HTML gerendert, und externe Links dürfen nur als validiertes `https:` im Systembrowser geöffnet werden.

Die Auswahl aller Projektordner ist die explizite Trust-Entscheidung. Deshalb startet die App Gemini mit `--skip-trust`; Geminis Tool-Freigaben bleiben davon unberührt. Die Root-Liste ist keine Betriebssystem-Sandbox: Für eine harte Isolation muss zusätzlich Geminis eigener Sandbox-Modus verwendet werden.

Die ausführliche Architektur, Datenmodelle, Risiken und Abnahmekriterien stehen in [implementation.md](./implementation.md).
