# Änderungen

## 0.16.0

- Gemini 3.8 Flash als explizite Auswahl für den Legacy-ACP-Modellwechsel; Modellwahl aus Session-Fähigkeiten aktiviert und nach Idle-Wiederaufnahme wiederhergestellt.

- Vollständiger paginierter Replay und materialisierte Timeline mit nachladbaren älteren Einträgen.
- Prozessbudgets und Ressourcenprofile mit sicherer Wiederaufnahme und geschützter Prompt-Vorbereitung.
- Virtuelle Timeline/Dateiansicht, begrenzte Markdown-Arbeit und getrennte optionale UI-Bundles.
- Korrekte Nachrichtensuche über Streaming-Grenzen mit FTS5 und Hintergrundmigration.
- Zuverlässigere Eventpersistenz, sichtbare Speicherfehler und bei Bedarf geladene Payload-Blobs.
- Lifecycle-Korrekturen für Vorschauen, Subscriptions und Extraktionsworker; weniger parallele Git-/Dateiarbeit.
- ACP SDK 1.5.1 auf ACP v1; generische Konfiguration, Pläne, Slash Commands und Rückfragen.
- Schutz vor veralteten asynchronen Antworten sowie begrenzte, redigierte Diagnoseprotokolle.

Details und verbleibende Freigabegrenzen: [Umsetzungsübersicht](docs/v0.16.0-implementation.md).
