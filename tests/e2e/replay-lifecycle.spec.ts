import { expect, test, _electron as electron } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("replays more than 1000 events and releases subscription listeners", async () => {
  const userDataDirectory = await mkdtemp(path.join(os.tmpdir(), "geminui-replay-e2e-"));
  const application = await electron.launch({ args: [path.resolve("."), `--user-data-dir=${userDataDirectory}`] });
  const sessionId = randomUUID();
  const projectId = randomUUID();
  const rootId = randomUUID();
  const messageId = randomUUID();
  const turnId = randomUUID();
  const eventCount = 5_002;
  try {
    const page = await application.firstWindow();
    await expect(page).toHaveTitle("GeminUI");
    await page.waitForFunction(() => typeof window.gemUi === "object");
    await application.evaluate(async ({ app }, fixture) => {
      const { createRequire } = await import("node:module");
      const path = await import("node:path");
      const require = createRequire(path.join(app.getAppPath(), "package.json"));
      const Database = require("better-sqlite3");
      const db = new Database(path.join(app.getPath("userData"), "data", "gem-ui.sqlite3"));
      db.pragma("foreign_keys = ON");
      try {
        db.transaction(() => {
          const timestamp = new Date().toISOString();
          const fingerprint = "a".repeat(64);
          db.prepare(`INSERT INTO projects (id,name,primary_root_id,root_revision,root_fingerprint,archived,created_at,updated_at)
            VALUES (?,?,?,1,?,0,?,?)`).run(fixture.projectId, "Replay fixture", fixture.rootId, fingerprint, timestamp, timestamp);
          db.prepare(`INSERT INTO project_roots (id,project_id,kind,path,real_path,label,sort_order,created_at,updated_at)
            VALUES (?,?,'primary',?,?,'Fixture',0,?,?)`).run(fixture.rootId, fixture.projectId, app.getPath("userData"), app.getPath("userData"), timestamp, timestamp);
          db.prepare(`INSERT INTO sessions (id,provider,project_id,last_root_revision,last_root_fingerprint,title,status,pinned,archived,created_at,updated_at)
            VALUES (?,'gemini-cli',?,1,?,'Long history','idle',0,0,?,?)`).run(fixture.sessionId, fixture.projectId, fingerprint, timestamp, timestamp);
          const insert = db.prepare("INSERT INTO events (session_id,seq,turn_id,event_type,payload_json,created_at) VALUES (?,?,?,?,?,?)");
          for (let seq = 1; seq <= fixture.eventCount; seq += 1) {
            const event = seq === 1 ? { type: "message.user", messageId: fixture.turnId, text: "Start", attachmentIds: [] }
              : seq === fixture.eventCount ? { type: "turn.completed", stopReason: "end_turn" }
              : { type: "message.assistant.delta", messageId: fixture.messageId, delta: "x" };
            insert.run(fixture.sessionId, seq, fixture.turnId, event.type, JSON.stringify(event), timestamp);
          }
        })();
      } finally { db.close(); }
    }, { sessionId, projectId, rootId, messageId, turnId, eventCount });

    const listenerCount = () => application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.listenerCount("destroyed"));
    const initialListeners = await listenerCount();
    const replay = await page.evaluate(async ({ sessionId }) => {
      const sequences: number[] = [];
      const stop = await window.gemUi.subscribeSessionEvents({ sessionId, afterSeq: 0 }, (events) => {
        sequences.push(...events.map((event) => event.seq));
      });
      stop();
      return { count: sequences.length, first: sequences[0], last: sequences.at(-1), unique: new Set(sequences).size };
    }, { sessionId });
    expect(replay).toEqual({ count: eventCount, first: 1, last: eventCount, unique: eventCount });
    await page.evaluate(async ({ sessionId, eventCount }) => {
      for (let index = 0; index < 100; index += 1) {
        const stop = await window.gemUi.subscribeSessionEvents({ sessionId, afterSeq: eventCount }, () => undefined);
        stop();
      }
    }, { sessionId, eventCount });
    await expect.poll(listenerCount).toBe(initialListeners);
  } finally {
    await application.close();
    await rm(userDataDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
