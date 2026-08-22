import { BrowserWindow, dialog } from "electron";
import fs from "node:fs/promises";
import type {
  EventRepository,
  ProjectRepository,
  SessionRepository,
  SqliteDatabase,
} from "../storage";
import type {
  ExportSessionInput,
  ExportSessionResult,
  StreamEnvelope,
} from "../../shared/contracts";

export type SessionExportServiceOptions = {
  sessions: SessionRepository;
  projects: ProjectRepository;
  events: EventRepository;
  database?: SqliteDatabase;
};

type TurnMetricDbRow = {
  turn_id: string;
  model: string;
  duration_ms: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  thought_tokens: number;
  lines_added: number;
  lines_deleted: number;
  status: string;
  created_at: string;
};

const RATING_INFO: Record<number, { emoji: string; label: string; color: string }> = {
  1: { emoji: "😡", label: "Sehr unzufrieden", color: "#ef4444" },
  2: { emoji: "🙁", label: "Unzufrieden", color: "#f97316" },
  3: { emoji: "😐", label: "Neutral", color: "#eab308" },
  4: { emoji: "🙂", label: "Zufrieden", color: "#84cc16" },
  5: { emoji: "😃", label: "Sehr zufrieden", color: "#10b981" },
};

export class SessionExportService {
  readonly #sessions: SessionRepository;
  readonly #projects: ProjectRepository;
  readonly #events: EventRepository;
  readonly #database?: SqliteDatabase;

  constructor(options: SessionExportServiceOptions) {
    this.#sessions = options.sessions;
    this.#projects = options.projects;
    this.#events = options.events;
    this.#database = options.database;
  }

  async exportSession(
    input: ExportSessionInput,
    parentWindow?: BrowserWindow,
  ): Promise<ExportSessionResult> {
    const session = this.#sessions.getById(input.sessionId);
    const project = this.#projects.getById(session.projectId);

    const envelopes: StreamEnvelope[] = [];
    let afterSeq = 0;
    while (true) {
      const batch = this.#events.listAfter(session.id, afterSeq, 1_000);
      if (batch.length === 0) break;
      envelopes.push(...batch);
      afterSeq = batch[batch.length - 1].seq;
      if (batch.length < 1_000) break;
    }

    const metricsMap = new Map<string, TurnMetricDbRow>();
    if (this.#database) {
      try {
        const rows = this.#database
          .prepare(
            `SELECT turn_id, model, duration_ms, input_tokens, output_tokens, total_tokens, thought_tokens, lines_added, lines_deleted, status, created_at
             FROM turn_metrics
             WHERE session_id = ?`,
          )
          .all(session.id) as TurnMetricDbRow[];
        for (const row of rows) {
          if (row.turn_id) {
            metricsMap.set(row.turn_id, row);
          }
        }
      } catch {
        // ignore if metrics query fails
      }
    }

    const dateStr = new Date(session.createdAt).toISOString().slice(0, 10);
    const cleanTitle = (session.title || "session")
      .toLowerCase()
      .replace(/[^a-z0-9äöüß_-]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
    const suggestedFileName = `${cleanTitle || "session"}-${dateStr}.${input.format}`;
    const targetWindow = parentWindow ?? (typeof BrowserWindow.getFocusedWindow === "function" ? BrowserWindow.getFocusedWindow() : null);
    const saveOptions = {
      title: `Chat exportieren als ${input.format.toUpperCase()}`,
      defaultPath: suggestedFileName,
      filters:
        input.format === "pdf"
          ? [{ name: "PDF Dokument (*.pdf)", extensions: ["pdf"] }]
          : [{ name: "PNG Bild (*.png)", extensions: ["png"] }],
    };

    const saveResult = targetWindow
      ? await dialog.showSaveDialog(targetWindow, saveOptions)
      : await dialog.showSaveDialog(saveOptions);

    if (saveResult.canceled || !saveResult.filePath) {
      return { canceled: true };
    }

    const html = buildExportHtml({
      session,
      project,
      envelopes,
      metricsMap,
      mode: input.mode,
      theme: input.theme ?? "light",
      includeMetadata: input.includeMetadata ?? true,
      rating: input.rating ?? null,
      feedbackNote: input.feedbackNote?.trim() || null,
    });

    let exportWindow: BrowserWindow | null = null;
    try {
      exportWindow = new BrowserWindow({
        show: false,
        width: 1200,
        height: 900,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
        },
      });

      await exportWindow.loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
      );

      // Wait a moment for fonts/rendering
      await new Promise((resolve) => setTimeout(resolve, 350));

      if (input.format === "pdf") {
        const pdfBuffer = await exportWindow.webContents.printToPDF({
          printBackground: true,
          pageSize: "A4",
          margins: {
            top: 0.4,
            bottom: 0.4,
            left: 0.4,
            right: 0.4,
          },
        });
        await fs.writeFile(saveResult.filePath, pdfBuffer);
      } else {
        const contentHeight = await exportWindow.webContents.executeJavaScript(
          "Math.max(document.body.scrollHeight, document.documentElement.scrollHeight, 600)",
        );
        exportWindow.setContentSize(1200, Math.min(Math.round(contentHeight) + 40, 25_000));
        await new Promise((resolve) => setTimeout(resolve, 200));

        const image = await exportWindow.webContents.capturePage();
        let pngBuffer = image.toPNG();

        // Inject rating & feedback metadata into PNG tEXt chunks
        const metadataRecord: Record<string, string> = {
          Title: session.title,
          Project: project.name,
          Model: session.model || "gemini",
          ExportDate: new Date().toISOString(),
        };
        if (input.rating) {
          metadataRecord.Rating = String(input.rating);
          metadataRecord.RatingDescription = RATING_INFO[input.rating]?.label || String(input.rating);
        }
        if (input.feedbackNote?.trim()) {
          metadataRecord.Feedback = input.feedbackNote.trim();
        }
        metadataRecord.GeminUIMetadata = JSON.stringify({
          sessionId: session.id,
          sessionTitle: session.title,
          projectName: project.name,
          model: session.model,
          rating: input.rating ?? null,
          feedbackNote: input.feedbackNote?.trim() || null,
          createdAt: session.createdAt,
          exportedAt: new Date().toISOString(),
        });

        pngBuffer = injectPngMetadata(pngBuffer, metadataRecord);
        await fs.writeFile(saveResult.filePath, pngBuffer);
      }

      return {
        canceled: false,
        filePath: saveResult.filePath,
      };
    } finally {
      if (exportWindow && !exportWindow.isDestroyed()) {
        exportWindow.destroy();
      }
    }
  }
}

// ---------------------------------------------------------------------------
// PNG Metadata Injection (tEXt Chunks)
// ---------------------------------------------------------------------------

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createPngTextChunk(keyword: string, text: string): Buffer {
  const cleanKeyword = keyword.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 79);
  const keywordBuf = Buffer.from(cleanKeyword, "latin1");
  const nullBuf = Buffer.from([0]);
  const textBuf = Buffer.from(text, "utf8");
  const data = Buffer.concat([keywordBuf, nullBuf, textBuf]);

  const type = Buffer.from("tEXt", "ascii");
  const typeAndData = Buffer.concat([type, data]);
  const crcVal = crc32(typeAndData);

  const lengthBuf = Buffer.alloc(4);
  lengthBuf.writeUInt32BE(data.length, 0);

  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crcVal, 0);

  return Buffer.concat([lengthBuf, type, data, crcBuf]);
}

function injectPngMetadata(pngBuffer: Buffer, metadata: Record<string, string>): Buffer {
  const pngSig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (pngBuffer.length < 8 || !pngBuffer.subarray(0, 8).equals(pngSig)) {
    return pngBuffer;
  }

  let pos = 8;
  const chunks: Buffer[] = [pngBuffer.subarray(0, pos)];

  while (pos < pngBuffer.length) {
    const length = pngBuffer.readUInt32BE(pos);
    const type = pngBuffer.toString("ascii", pos + 4, pos + 8);
    const chunkTotal = 12 + length;
    const chunk = pngBuffer.subarray(pos, pos + chunkTotal);
    chunks.push(chunk);
    pos += chunkTotal;

    if (type === "IHDR") {
      for (const [key, val] of Object.entries(metadata)) {
        if (val) {
          chunks.push(createPngTextChunk(key, val));
        }
      }
    }
  }

  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// HTML Generation Logic
// ---------------------------------------------------------------------------

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatDuration(ms: number): string {
  if (ms <= 0) return "0 ms";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000);
  return `${mins}m ${secs}s`;
}

function formatNumber(num: number): string {
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}k`;
  return num.toLocaleString("de-DE");
}

function renderSimpleMarkdown(md: string): string {
  if (!md) return "";

  const codeBlocks: string[] = [];
  let text = md.replace(/```([a-z0-9_-]*)\n([\s\S]*?)```/gi, (_match, lang, code) => {
    const idx = codeBlocks.length;
    const langLabel = lang ? `<div class="code-header">${escapeHtml(lang)}</div>` : "";
    codeBlocks.push(
      `<div class="code-block">${langLabel}<pre><code>${escapeHtml(code)}</code></pre></div>`,
    );
    return `__CODE_BLOCK_${idx}__`;
  });

  text = text.replace(/`([^`]+)`/g, (_m, code) => `<code>${escapeHtml(code)}</code>`);
  text = text.replace(/^#### (.*$)/gim, "<h4>$1</h4>");
  text = text.replace(/^### (.*$)/gim, "<h3>$1</h3>");
  text = text.replace(/^## (.*$)/gim, "<h2>$1</h2>");
  text = text.replace(/^# (.*$)/gim, "<h1>$1</h1>");
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  text = text.replace(/^\> (.*$)/gim, "<blockquote>$1</blockquote>");
  text = text.replace(/^\s*[-*]\s+(.*$)/gim, "<li>$1</li>");
  text = text.replace(/(<li>.*<\/li>)/gis, "<ul>$1</ul>");

  const paragraphs = text.split(/\n\n+/);
  const rendered = paragraphs
    .map((p) => {
      const trimmed = p.trim();
      if (!trimmed) return "";
      if (
        trimmed.startsWith("<h") ||
        trimmed.startsWith("<ul") ||
        trimmed.startsWith("<blockquote") ||
        trimmed.startsWith("__CODE_BLOCK_")
      ) {
        return trimmed;
      }
      return `<p>${trimmed.replace(/\n/g, "<br/>")}</p>`;
    })
    .join("\n");

  return rendered.replace(/__CODE_BLOCK_(\d+)__/g, (_m, idx) => {
    return codeBlocks[Number(idx)] || "";
  });
}

type TurnState = {
  turnId: string | null;
  timestamp: string;
  userMessage?: {
    text: string;
    attachmentIds?: string[];
    contextAttachments?: Array<{ id: string; kind: string; title: string }>;
    projectFiles?: Array<{ rootId: string; rootLabel: string; relativePath: string; displayName: string }>;
  };
  thoughts: string[];
  assistantMessages: string[];
  tools: Array<{
    toolCallId: string;
    title: string;
    status: string;
    input?: unknown;
    output?: unknown;
    error?: unknown;
  }>;
};

function buildExportHtml(params: {
  session: { id: string; title: string; model: string | null; createdAt: string; updatedAt: string };
  project: { name: string };
  envelopes: StreamEnvelope[];
  metricsMap: Map<string, TurnMetricDbRow>;
  mode: "rendered" | "raw";
  theme: "light" | "dark";
  includeMetadata: boolean;
  rating: number | null;
  feedbackNote: string | null;
}): string {
  const { session, project, envelopes, metricsMap, mode, theme, includeMetadata, rating, feedbackNote } = params;

  const isDark = theme === "dark";
  const bg = isDark ? "#0f172a" : "#f8fafc";
  const surface = isDark ? "#1e293b" : "#ffffff";
  const surfaceSubtle = isDark ? "#334155" : "#f1f5f9";
  const border = isDark ? "#334155" : "#e2e8f0";
  const text = isDark ? "#f8fafc" : "#0f172a";
  const muted = isDark ? "#94a3b8" : "#64748b";
  const accent = isDark ? "#38bdf8" : "#0284c7";
  const userBubble = isDark ? "#0369a1" : "#e0f2fe";
  const userText = isDark ? "#f0f9ff" : "#0369a1";
  const codeBg = isDark ? "#0b0f19" : "#f1f5f9";

  const ratingInfo = rating ? RATING_INFO[rating] : null;

  let bodyContent = "";

  const ratingBadgeHtml = ratingInfo || feedbackNote
    ? `
      <div class="rating-banner">
        ${
          ratingInfo
            ? `
              <div class="rating-badge" style="border-color: ${ratingInfo.color}; background: color-mix(in srgb, ${ratingInfo.color} 15%, transparent);">
                <span class="rating-emoji">${ratingInfo.emoji}</span>
                <strong>${ratingInfo.label} (${rating}/5)</strong>
              </div>
            `
            : ""
        }
        ${
          feedbackNote
            ? `
              <div class="rating-feedback-note">
                <span class="feedback-icon">💬</span>
                <span>„${escapeHtml(feedbackNote)}“</span>
              </div>
            `
            : ""
        }
      </div>
    `
    : "";

  if (mode === "raw") {
    // RAW EVENT SEQUENCE
    const itemsHtml = envelopes
      .map((env) => {
        const payloadStr = JSON.stringify(env.event, null, 2);
        const metric = env.turnId ? metricsMap.get(env.turnId) : undefined;
        return `
          <div class="raw-card">
            <div class="raw-header">
              <span class="raw-seq">#${env.seq}</span>
              <span class="raw-type">${escapeHtml(env.event.type)}</span>
              ${env.turnId ? `<span class="raw-turn">Turn: ${escapeHtml(env.turnId.slice(0, 8))}</span>` : ""}
              ${
                includeMetadata && metric
                  ? `<span class="meta-tag">🧠 ${escapeHtml(metric.model)}</span>
                     <span class="meta-tag">⏱️ ${formatDuration(metric.duration_ms)}</span>
                     <span class="meta-tag">🪙 ${formatNumber(metric.total_tokens)} Tokens</span>`
                  : ""
              }
              <span class="raw-time">${escapeHtml(new Date(env.timestamp).toLocaleTimeString())}</span>
            </div>
            <pre class="raw-code"><code>${escapeHtml(payloadStr)}</code></pre>
          </div>
        `;
      })
      .join("\n");

    bodyContent = `
      <div class="export-header">
        <h1>${escapeHtml(session.title)}</h1>
        <div class="meta-row">
          <span>Projekt: <b>${escapeHtml(project.name)}</b></span>
          <span>•</span>
          <span>Modus: <b>Raw (JSON-Events)</b></span>
          <span>•</span>
          <span>${envelopes.length} Events</span>
          <span>•</span>
          <span>${escapeHtml(new Date(session.createdAt).toLocaleString("de-DE"))}</span>
        </div>
        ${ratingBadgeHtml}
      </div>
      <div class="raw-container">
        ${itemsHtml || '<p class="empty-state">Keine Events in dieser Session vorhanden.</p>'}
      </div>
    `;
  } else {
    // RENDERED CHAT (ALL STEPS FULLY EXPANDED)
    const turns: TurnState[] = [];
    let currentTurn: TurnState = {
      turnId: null,
      timestamp: session.createdAt,
      thoughts: [],
      assistantMessages: [],
      tools: [],
    };

    for (const env of envelopes) {
      const event = env.event;
      if (env.turnId && env.turnId !== currentTurn.turnId) {
        if (
          currentTurn.userMessage ||
          currentTurn.thoughts.length > 0 ||
          currentTurn.assistantMessages.length > 0 ||
          currentTurn.tools.length > 0
        ) {
          turns.push(currentTurn);
        }
        currentTurn = {
          turnId: env.turnId,
          timestamp: env.timestamp,
          thoughts: [],
          assistantMessages: [],
          tools: [],
        };
      }

      switch (event.type) {
        case "message.user":
          currentTurn.userMessage = {
            text: event.text,
            attachmentIds: event.attachmentIds,
            contextAttachments: event.contextAttachments,
            projectFiles: event.projectFiles,
          };
          break;
        case "message.thought.delta":
          if (currentTurn.thoughts.length === 0) currentTurn.thoughts.push("");
          currentTurn.thoughts[currentTurn.thoughts.length - 1] += event.delta;
          break;
        case "message.assistant.delta":
          if (currentTurn.assistantMessages.length === 0) currentTurn.assistantMessages.push("");
          currentTurn.assistantMessages[currentTurn.assistantMessages.length - 1] += event.delta;
          break;
        case "tool.started":
          currentTurn.tools.push({
            toolCallId: event.toolCallId,
            title: event.title,
            status: "running",
            input: event.arguments,
          });
          break;
        case "tool.updated": {
          const tool = currentTurn.tools.find((t) => t.toolCallId === event.toolCallId);
          if (tool) {
            tool.status = event.status;
            if (event.update) tool.output = event.update;
          }
          break;
        }
        case "tool.completed": {
          const tool = currentTurn.tools.find((t) => t.toolCallId === event.toolCallId);
          if (tool) {
            tool.status = "completed";
            tool.output = event.result;
          } else {
            currentTurn.tools.push({
              toolCallId: event.toolCallId,
              title: "Werkzeug",
              status: "completed",
              output: event.result,
            });
          }
          break;
        }
        case "tool.failed": {
          const tool = currentTurn.tools.find((t) => t.toolCallId === event.toolCallId);
          if (tool) {
            tool.status = "failed";
            tool.error = event.error;
          } else {
            currentTurn.tools.push({
              toolCallId: event.toolCallId,
              title: "Werkzeug",
              status: "failed",
              error: event.error,
            });
          }
          break;
        }
      }
    }

    if (
      currentTurn.userMessage ||
      currentTurn.thoughts.length > 0 ||
      currentTurn.assistantMessages.length > 0 ||
      currentTurn.tools.length > 0
    ) {
      turns.push(currentTurn);
    }

    const turnsHtml = turns
      .map((turn, index) => {
        const metric = turn.turnId ? metricsMap.get(turn.turnId) : undefined;
        let turnHtml = `<div class="turn-card">`;

        // Turn Header
        turnHtml += `
          <div class="turn-header">
            <span>Turn #${index + 1}</span>
            ${
              includeMetadata && metric
                ? `
                  <div class="turn-metadata-bar">
                    <span class="meta-tag">🧠 ${escapeHtml(metric.model)}</span>
                    <span class="meta-tag">⏱️ ${formatDuration(metric.duration_ms)}</span>
                    <span class="meta-tag">🪙 ${formatNumber(metric.total_tokens)} Tokens (${formatNumber(metric.input_tokens)} In / ${formatNumber(metric.output_tokens)} Out${metric.thought_tokens > 0 ? ` / ${formatNumber(metric.thought_tokens)} Thought` : ""})</span>
                    <span class="meta-tag">🕒 ${escapeHtml(new Date(metric.created_at || turn.timestamp).toLocaleTimeString())}</span>
                  </div>
                `
                : `<span class="turn-time">${escapeHtml(new Date(turn.timestamp).toLocaleTimeString())}</span>`
            }
          </div>
        `;

        // User Message
        if (turn.userMessage) {
          const contextBadges = [
            ...(turn.userMessage.contextAttachments || []).map((c) => `<span class="chip">🔗 ${escapeHtml(c.title)}</span>`),
            ...(turn.userMessage.projectFiles || []).map((p) => `<span class="chip">📄 ${escapeHtml(p.relativePath)}</span>`),
            ...(turn.userMessage.attachmentIds || []).map((id) => `<span class="chip">📎 Anhang ${escapeHtml(id.slice(0, 6))}</span>`),
          ].join("");

          turnHtml += `
            <div class="user-bubble">
              <div class="bubble-header">
                <strong>Du</strong>
                <span>${escapeHtml(new Date(turn.timestamp).toLocaleTimeString())}</span>
              </div>
              <div class="bubble-text">${escapeHtml(turn.userMessage.text).replace(/\n/g, "<br/>")}</div>
              ${contextBadges ? `<div class="attachment-chips">${contextBadges}</div>` : ""}
            </div>
          `;
        }

        // Thoughts (Expanded)
        for (const thought of turn.thoughts) {
          if (!thought.trim()) continue;
          turnHtml += `
            <div class="thought-card">
              <div class="thought-header">
                <span>🧠 Gedanken des Assistenten</span>
              </div>
              <div class="thought-body">${escapeHtml(thought).replace(/\n/g, "<br/>")}</div>
            </div>
          `;
        }

        // Tools / Work Steps (All Fully Expanded)
        for (const tool of turn.tools) {
          const inputStr = tool.input !== undefined && tool.input !== null ? (typeof tool.input === "string" ? tool.input : JSON.stringify(tool.input, null, 2)) : "";
          const outputStr = tool.output !== undefined && tool.output !== null ? (typeof tool.output === "string" ? tool.output : JSON.stringify(tool.output, null, 2)) : "";
          const errorStr = tool.error !== undefined && tool.error !== null ? (typeof tool.error === "string" ? tool.error : JSON.stringify(tool.error, null, 2)) : "";

          turnHtml += `
            <div class="tool-card tool-card--${tool.status}">
              <div class="tool-header">
                <span class="tool-icon">🛠️</span>
                <span class="tool-title">${escapeHtml(tool.title)}</span>
                <span class="tool-status-badge ${tool.status === "failed" ? "tool-status-badge--error" : ""}">${tool.status === "completed" ? "Abgeschlossen" : tool.status === "failed" ? "Fehlgeschlagen" : "Läuft"}</span>
              </div>
              <div class="tool-body">
                ${inputStr ? `<div class="tool-section"><div class="tool-subhead">Eingabeparameter / Inhalt:</div><pre class="tool-code"><code>${escapeHtml(inputStr)}</code></pre></div>` : ""}
                ${outputStr ? `<div class="tool-section"><div class="tool-subhead">Ergebnis / Ausgabe:</div><pre class="tool-code"><code>${escapeHtml(outputStr)}</code></pre></div>` : ""}
                ${errorStr ? `<div class="tool-section"><div class="tool-subhead">Fehler:</div><pre class="tool-code tool-code--error"><code>${escapeHtml(errorStr)}</code></pre></div>` : ""}
              </div>
            </div>
          `;
        }

        // Assistant Messages
        for (const msg of turn.assistantMessages) {
          if (!msg.trim()) continue;
          turnHtml += `
            <div class="assistant-message">
              <div class="assistant-header">
                <strong>Assistent</strong>
                <span>${session.model ? escapeHtml(session.model) : "Gemini"}</span>
              </div>
              <div class="assistant-content markdown-body">
                ${renderSimpleMarkdown(msg)}
              </div>
            </div>
          `;
        }

        turnHtml += `</div>`;
        return turnHtml;
      })
      .join("\n");

    bodyContent = `
      <div class="export-header">
        <h1>${escapeHtml(session.title)}</h1>
        <div class="meta-row">
          <span>Projekt: <b>${escapeHtml(project.name)}</b></span>
          <span>•</span>
          <span>Modell: <b>${session.model ? escapeHtml(session.model) : "gemini"}</b></span>
          <span>•</span>
          <span>${turns.length} Turns</span>
          <span>•</span>
          <span>${escapeHtml(new Date(session.createdAt).toLocaleString("de-DE"))}</span>
        </div>
        ${ratingBadgeHtml}
      </div>
      <div class="chat-container">
        ${turnsHtml || '<p class="empty-state">Keine Nachrichten in dieser Session vorhanden.</p>'}
      </div>
    `;
  }

  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <title>${escapeHtml(session.title)} - GeminUI Export</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 32px 40px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background-color: ${bg};
      color: ${text};
      line-height: 1.5;
      font-size: 13.5px;
    }
    .export-header {
      border-bottom: 2px solid ${border};
      padding-bottom: 16px;
      margin-bottom: 24px;
    }
    .export-header h1 {
      margin: 0 0 8px 0;
      font-size: 24px;
      font-weight: 700;
      color: ${text};
    }
    .meta-row {
      display: flex;
      gap: 10px;
      align-items: center;
      color: ${muted};
      font-size: 12px;
      flex-wrap: wrap;
    }
    .meta-row b { color: ${text}; }

    /* Rating & Feedback Banner */
    .rating-banner {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-top: 12px;
      flex-wrap: wrap;
    }
    .rating-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 8px;
      border: 1px solid;
      font-size: 12px;
    }
    .rating-emoji { font-size: 16px; }
    .rating-feedback-note {
      font-style: italic;
      color: ${text};
      font-size: 12.5px;
      display: flex;
      align-items: center;
      gap: 6px;
      background: ${surfaceSubtle};
      padding: 4px 10px;
      border-radius: 8px;
      border: 1px solid ${border};
    }

    /* Turn Container */
    .turn-card {
      background: ${surface};
      border: 1px solid ${border};
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 20px;
      page-break-inside: avoid;
    }
    .turn-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: ${muted};
      margin-bottom: 14px;
      border-bottom: 1px dashed ${border};
      padding-bottom: 8px;
      flex-wrap: wrap;
    }
    .turn-metadata-bar {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
    }
    .meta-tag {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 7px;
      border-radius: 6px;
      background: ${surfaceSubtle};
      border: 1px solid ${border};
      font-size: 10.5px;
      font-weight: 600;
      text-transform: none;
      letter-spacing: normal;
      color: ${text};
    }

    /* User Bubble */
    .user-bubble {
      background: ${userBubble};
      color: ${userText};
      border-radius: 10px;
      padding: 12px 16px;
      margin-bottom: 16px;
      border: 1px solid color-mix(in srgb, ${accent} 25%, transparent);
    }
    .bubble-header {
      display: flex;
      justify-content: space-between;
      font-size: 11px;
      margin-bottom: 4px;
      opacity: 0.85;
    }
    .bubble-text { font-weight: 500; }
    .attachment-chips { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
    .chip {
      background: rgba(255, 255, 255, 0.3);
      padding: 2px 8px;
      border-radius: 6px;
      font-size: 11px;
    }

    /* Thoughts */
    .thought-card {
      background: color-mix(in srgb, #8b5cf6 8%, ${surface});
      border: 1px solid color-mix(in srgb, #8b5cf6 25%, transparent);
      border-radius: 8px;
      padding: 12px 14px;
      margin-bottom: 16px;
    }
    .thought-header {
      font-size: 11.5px;
      font-weight: 600;
      color: #8b5cf6;
      margin-bottom: 6px;
    }
    .thought-body {
      font-style: italic;
      color: ${muted};
      font-size: 12.5px;
    }

    /* Tool Cards (Expanded) */
    .tool-card {
      background: ${surfaceSubtle};
      border: 1px solid ${border};
      border-left: 4px solid #3b82f6;
      border-radius: 8px;
      padding: 12px 14px;
      margin-bottom: 16px;
    }
    .tool-card--failed {
      border-left-color: #ef4444;
    }
    .tool-header {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      font-weight: 600;
    }
    .tool-status-badge {
      margin-left: auto;
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 4px;
      background: #10b981;
      color: #fff;
      font-weight: 600;
    }
    .tool-status-badge--error {
      background: #ef4444;
    }
    .tool-locations {
      margin: 6px 0;
      font-size: 11px;
      color: ${muted};
    }
    .tool-subhead {
      font-size: 11px;
      font-weight: 600;
      color: ${muted};
      margin: 8px 0 4px;
    }
    .tool-code {
      background: ${codeBg};
      color: ${text};
      padding: 8px 10px;
      border-radius: 6px;
      overflow-x: auto;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 11px;
      margin: 0;
      white-space: pre-wrap;
      word-break: break-all;
    }
    .tool-code--error {
      color: #ef4444;
      border: 1px solid color-mix(in srgb, #ef4444 30%, transparent);
    }

    /* Assistant Message */
    .assistant-message {
      margin-top: 14px;
    }
    .assistant-header {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      color: ${muted};
      margin-bottom: 8px;
    }
    .assistant-header strong { color: ${text}; font-size: 13px; }
    .markdown-body {
      color: ${text};
      font-size: 13.5px;
    }
    .markdown-body p { margin: 8px 0; }
    .markdown-body h1, .markdown-body h2, .markdown-body h3, .markdown-body h4 {
      margin: 14px 0 6px;
    }
    .markdown-body ul { margin: 6px 0; padding-left: 20px; }
    .markdown-body blockquote {
      border-left: 3px solid ${accent};
      margin: 8px 0;
      padding-left: 12px;
      color: ${muted};
    }
    .code-block {
      background: ${codeBg};
      border: 1px solid ${border};
      border-radius: 8px;
      margin: 10px 0;
      overflow: hidden;
    }
    .code-header {
      background: color-mix(in srgb, ${codeBg} 80%, ${surface});
      padding: 4px 10px;
      font-size: 10.5px;
      font-weight: 600;
      color: ${muted};
      border-bottom: 1px solid ${border};
    }
    .code-block pre {
      margin: 0;
      padding: 10px 14px;
      overflow-x: auto;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 12px;
    }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      background: ${codeBg};
      padding: 2px 4px;
      border-radius: 4px;
      font-size: 12px;
    }

    /* Raw Events Container */
    .raw-card {
      background: ${surface};
      border: 1px solid ${border};
      border-radius: 8px;
      padding: 12px 14px;
      margin-bottom: 12px;
      page-break-inside: avoid;
    }
    .raw-header {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 11.5px;
      margin-bottom: 8px;
      flex-wrap: wrap;
    }
    .raw-seq { font-weight: 700; color: ${accent}; }
    .raw-type { font-weight: 600; color: ${text}; }
    .raw-turn { color: ${muted}; }
    .raw-time { margin-left: auto; color: ${muted}; font-size: 10.5px; }
    .raw-code {
      background: ${codeBg};
      color: ${text};
      padding: 10px;
      border-radius: 6px;
      margin: 0;
      overflow-x: auto;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 11px;
      white-space: pre-wrap;
    }

    .empty-state {
      text-align: center;
      padding: 40px;
      color: ${muted};
    }
  </style>
</head>
<body>
  ${bodyContent}
</body>
</html>`;
}
