import { describe, expect, it } from "vitest";
import { debugLogger } from "../../src/renderer/features/debug/debug-logger";

describe("debugLogger", () => {
  it("erfasst Logs verschiedener Level und benachrichtigt Subscriber", () => {
    debugLogger.clear();
    const received: number[] = [];

    const unsubscribe = debugLogger.subscribe((logs) => {
      received.push(logs.length);
    });

    debugLogger.info("app", "App gestartet", { version: "1.0.0" });
    debugLogger.warn("gemini", "Langsames Netzwerk", { latencyMs: 1500 });
    debugLogger.error("renderer", "Render-Fehler", { stack: "Error..." });
    debugLogger.stream("gemini", "tool.completed", { toolCallId: "tool-1" });
    debugLogger.ipc("git", "Git-Status abgefragt");

    const logs = debugLogger.getLogs();
    expect(logs.length).toBe(5);
    expect(logs[0].level).toBe("info");
    expect(logs[0].source).toBe("app");
    expect(logs[1].level).toBe("warn");
    expect(logs[2].level).toBe("error");
    expect(logs[3].level).toBe("stream");
    expect(logs[4].level).toBe("ipc");

    unsubscribe();
    debugLogger.clear();
    expect(debugLogger.getLogs().length).toBe(0);
  });
});
