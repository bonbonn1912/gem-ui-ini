import type { JiraIssueAttachment, JiraIssueDetails } from "../../../shared/contracts";

export type JiraAuthOptions = {
  baseUrl: string;
  token: string;
  email?: string | null;
};

export type JiraRawIssueResponse = {
  key: string;
  fields: {
    summary: string;
    description?: unknown;
    status?: { name: string };
    issuetype?: { name: string };
    priority?: { name: string };
    assignee?: { displayName: string } | null;
    labels?: string[];
    attachment?: Array<{
      id: string | number;
      filename?: string;
      size?: number;
      mimeType?: string;
      created?: string;
      content?: string;
      [key: string]: unknown;
    }>;
    [key: string]: unknown;
  };
};

export function isJiraCloudUrl(baseUrl: string): boolean {
  try {
    const parsed = new URL(baseUrl);
    return parsed.hostname.toLowerCase().endsWith(".atlassian.net");
  } catch {
    return false;
  }
}

export function buildJiraAuthHeader(options: JiraAuthOptions): string {
  const token = options.token.trim();
  const email = options.email?.trim() || "";

  if (token.startsWith("Basic ") || token.startsWith("Bearer ")) {
    return token;
  }

  // If token contains colon or email is provided, use Basic Auth (standard for Jira Cloud)
  if (email) {
    const credentials = Buffer.from(`${email}:${token}`).toString("base64");
    return `Basic ${credentials}`;
  }

  if (token.includes(":")) {
    const credentials = Buffer.from(token).toString("base64");
    return `Basic ${credentials}`;
  }

  // If it's a Jira Cloud URL without an explicit email, Basic auth with token or Bearer
  if (isJiraCloudUrl(options.baseUrl)) {
    // If user provided an API token without email, try Bearer first or Basic with empty username
    return `Bearer ${token}`;
  }

  // Self-hosted Jira Server / Data Center default is Personal Access Token (PAT)
  return `Bearer ${token}`;
}

export class JiraApiClient {
  readonly #baseUrl: string;
  readonly #authHeader: string;

  constructor(options: JiraAuthOptions) {
    this.#baseUrl = options.baseUrl.trim().replace(/\/+$/, "");
    this.#authHeader = buildJiraAuthHeader(options);
  }

  async getIssue(issueKey: string): Promise<JiraIssueDetails> {
    const normalizedKey = issueKey.trim().toUpperCase();
    const endpoint = `${this.#baseUrl}/rest/api/2/issue/${encodeURIComponent(normalizedKey)}`;

    const response = await fetch(endpoint, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: this.#authHeader,
      },
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      let errorMsg = `Jira API HTTP ${response.status} (${response.statusText})`;
      try {
        const parsed = JSON.parse(errorBody);
        if (Array.isArray(parsed.errorMessages) && parsed.errorMessages.length > 0) {
          errorMsg = parsed.errorMessages.join(", ");
        } else if (parsed.errors && typeof parsed.errors === "object") {
          errorMsg = Object.values(parsed.errors).join(", ");
        }
      } catch {
        if (errorBody) errorMsg += `: ${errorBody.slice(0, 200)}`;
      }
      throw new Error(`Fehler beim Abrufen von Jira-Issue ${normalizedKey}: ${errorMsg}`);
    }

    const data = (await response.json()) as JiraRawIssueResponse;
    return parseRawJiraIssue(data, this.#baseUrl);
  }

  /**
   * Downloads an attachment from Jira.
   *
   * Handles Self-Hosted Jira & Jira Cloud specifics:
   * 1. Tries the official REST API endpoint (`/rest/api/2/attachment/content/{id}`) which works with Bearer PATs.
   * 2. Tries the provided `contentUrl` (often `/secure/attachment/...`).
   * 3. Follows HTTP 301/302/303/307 redirects manually so the Authorization header is not lost on internal redirects.
   */
  async downloadAttachment(contentUrl: string, attachmentId?: string): Promise<Buffer> {
    const candidateUrls: string[] = [];

    if (attachmentId) {
      candidateUrls.push(`${this.#baseUrl}/rest/api/2/attachment/content/${encodeURIComponent(attachmentId)}`);
    }

    if (contentUrl) {
      try {
        const resolved = new URL(contentUrl, this.#baseUrl).toString();
        if (!candidateUrls.includes(resolved)) {
          candidateUrls.push(resolved);
        }
      } catch {
        if (!candidateUrls.includes(contentUrl)) {
          candidateUrls.push(contentUrl);
        }
      }
    }

    let lastError: Error | null = null;

    for (const url of candidateUrls) {
      try {
        return await this.#fetchWithAuthRedirects(url);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }

    throw lastError ?? new Error(`Fehler beim Herunterladen des Anhangs (${contentUrl})`);
  }

  async #fetchWithAuthRedirects(initialUrl: string, maxRedirects = 5): Promise<Buffer> {
    let currentUrl = initialUrl;
    let redirectsCount = 0;

    while (redirectsCount < maxRedirects) {
      const parsedCurrent = new URL(currentUrl, this.#baseUrl);
      let isSameHost = false;
      try {
        isSameHost = parsedCurrent.origin.toLowerCase() === new URL(this.#baseUrl).origin.toLowerCase();
      } catch {
        isSameHost = false;
      }

      const headers: Record<string, string> = {
        Accept: "*/*",
      };

      if (isSameHost) {
        headers["Authorization"] = this.#authHeader;
      }

      const response = await fetch(parsedCurrent.toString(), {
        method: "GET",
        headers,
        redirect: "manual",
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) {
          throw new Error(`HTTP ${response.status} Weiterleitung ohne Location Header von ${currentUrl}`);
        }
        const nextUrl = new URL(location, currentUrl).toString();
        currentUrl = nextUrl;
        redirectsCount++;
        continue;
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} (${response.statusText}) von ${currentUrl}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    }

    throw new Error(`Zu viele Weiterleitungen beim Herunterladen von ${initialUrl}`);
  }
}

export function parseRawJiraIssue(
  data: JiraRawIssueResponse,
  baseUrl: string,
): JiraIssueDetails {
  const issueKey = data.key;
  const summary = data.fields?.summary || issueKey;
  const rawDescription = data.fields?.description;
  const descriptionMarkdown = convertJiraDescriptionToMarkdown(rawDescription);

  const status = data.fields?.status?.name ?? undefined;
  const issueType = data.fields?.issuetype?.name ?? undefined;
  const priority = data.fields?.priority?.name ?? undefined;
  const assignee = data.fields?.assignee?.displayName ?? null;
  const labels = Array.isArray(data.fields?.labels) ? data.fields.labels : [];
  const url = `${baseUrl.replace(/\/+$/, "")}/browse/${issueKey}`;

  const attachments: JiraIssueAttachment[] = Array.isArray(data.fields?.attachment)
    ? data.fields.attachment.map((att) => ({
        id: String(att.id),
        filename: String(att.filename || "attachment"),
        size: Number(att.size) || 0,
        mimeType: typeof att.mimeType === "string" ? att.mimeType : undefined,
        created: typeof att.created === "string" ? att.created : undefined,
        contentUrl: String(att.content || `${baseUrl.replace(/\/+$/, "")}/rest/api/2/attachment/content/${att.id}`),
      }))
    : [];

  const storyMarkdown = formatStoryMarkdown({
    issueKey,
    summary,
    descriptionMarkdown,
    status,
    issueType,
    priority,
    assignee,
    labels,
    attachments,
    url,
  });

  return {
    issueKey,
    summary,
    descriptionMarkdown,
    status,
    issueType,
    priority,
    assignee,
    labels,
    attachments,
    storyMarkdown,
    url,
  };
}

export function formatStoryMarkdown(issue: {
  issueKey: string;
  summary: string;
  descriptionMarkdown: string;
  status?: string;
  issueType?: string;
  priority?: string;
  assignee?: string | null;
  labels?: string[];
  attachments?: JiraIssueAttachment[];
  url: string;
}): string {
  const lines: string[] = [];

  lines.push(`# [${issue.issueKey}] ${issue.summary}`);
  lines.push("");

  if (issue.status) lines.push(`- **Status:** ${issue.status}`);
  if (issue.issueType) lines.push(`- **Typ:** ${issue.issueType}`);
  if (issue.priority) lines.push(`- **Priorität:** ${issue.priority}`);
  lines.push(`- **Zugewiesen:** ${issue.assignee || "Nicht zugewiesen"}`);
  if (issue.labels && issue.labels.length > 0) {
    lines.push(`- **Labels:** ${issue.labels.join(", ")}`);
  }
  lines.push(`- **Jira-Link:** [${issue.issueKey} in Jira öffnen](${issue.url})`);
  lines.push("");
  lines.push("## Beschreibung");
  lines.push("");
  lines.push(issue.descriptionMarkdown.trim() || "_Keine Beschreibung vorhanden._");

  if (issue.attachments && issue.attachments.length > 0) {
    lines.push("");
    lines.push("## Anhänge");
    lines.push("");
    for (const att of issue.attachments) {
      const sizeKb = Math.round(att.size / 1024);
      lines.push(`- [${att.filename}](${att.contentUrl}) (${sizeKb} KB)`);
    }
  }

  return lines.join("\n");
}

export function convertJiraDescriptionToMarkdown(description: unknown): string {
  if (!description) return "";

  if (typeof description === "string") {
    return convertJiraWikiMarkupToMarkdown(description);
  }

  if (typeof description === "object" && description !== null) {
    // Check if it's an Atlassian Document Format (ADF) object
    if ("type" in description && (description as { type: string }).type === "doc") {
      return convertAdfToMarkdown(description as AdfNode);
    }
  }

  return String(description);
}

export type AdfNode = {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
  marks?: Array<{
    type: string;
    attrs?: Record<string, unknown>;
  }>;
};

export function convertAdfToMarkdown(node: AdfNode): string {
  if (!node) return "";

  switch (node.type) {
    case "doc":
      return (node.content || []).map(convertAdfToMarkdown).join("\n\n").trim();

    case "paragraph": {
      const content = (node.content || []).map(convertAdfToMarkdown).join("");
      return content;
    }

    case "heading": {
      const level = Math.min(Math.max(Number(node.attrs?.level) || 1, 1), 6);
      const hashes = "#".repeat(level);
      const content = (node.content || []).map(convertAdfToMarkdown).join("");
      return `${hashes} ${content}`;
    }

    case "bulletList": {
      return (node.content || [])
        .map((item) => `- ${convertAdfToMarkdown(item).trim()}`)
        .join("\n");
    }

    case "orderedList": {
      let counter = 1;
      return (node.content || [])
        .map((item) => `${counter++}. ${convertAdfToMarkdown(item).trim()}`)
        .join("\n");
    }

    case "listItem": {
      return (node.content || []).map(convertAdfToMarkdown).join("\n");
    }

    case "codeBlock": {
      const language = (node.attrs?.language as string) || "";
      const content = (node.content || []).map((c) => c.text || "").join("");
      return `\`\`\`${language}\n${content}\n\`\`\``;
    }

    case "blockquote": {
      const inner = (node.content || []).map(convertAdfToMarkdown).join("\n");
      return inner
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
    }

    case "rule":
      return "---";

    case "table": {
      const rows = (node.content || []).map((rowNode) => {
        const cells = (rowNode.content || []).map((cellNode) => {
          return convertAdfToMarkdown(cellNode).replace(/\n+/g, " ").trim();
        });
        return `| ${cells.join(" | ")} |`;
      });
      if (rows.length === 0) return "";
      const colCount = (node.content?.[0]?.content || []).length || 1;
      const separator = `| ${Array(colCount).fill("---").join(" | ")} |`;
      return [rows[0], separator, ...rows.slice(1)].join("\n");
    }

    case "tableRow":
      return (node.content || []).map(convertAdfToMarkdown).join(" | ");

    case "tableHeader":
    case "tableCell":
      return (node.content || []).map(convertAdfToMarkdown).join(" ");

    case "text": {
      let text = node.text || "";
      if (node.marks && node.marks.length > 0) {
        for (const mark of node.marks) {
          switch (mark.type) {
            case "strong":
              text = `**${text}**`;
              break;
            case "em":
              text = `*${text}*`;
              break;
            case "strike":
              text = `~~${text}~~`;
              break;
            case "code":
              text = `\`${text}\``;
              break;
            case "underline":
              text = `<u>${text}</u>`;
              break;
            case "link": {
              const href = (mark.attrs?.href as string) || "";
              text = href ? `[${text}](${href})` : text;
              break;
            }
          }
        }
      }
      return text;
    }

    case "mention": {
      const name = (node.attrs?.text as string) || (node.attrs?.id as string) || "user";
      return `@${name.replace(/^@/, "")}`;
    }

    case "inlineCard":
    case "blockCard": {
      const cardUrl = (node.attrs?.url as string) || "";
      return cardUrl ? `[${cardUrl}](${cardUrl})` : "";
    }

    default:
      if (node.content && node.content.length > 0) {
        return node.content.map(convertAdfToMarkdown).join("");
      }
      return node.text || "";
  }
}

export function convertJiraWikiMarkupToMarkdown(markup: string): string {
  if (!markup) return "";

  let md = markup;

  // Code blocks: {code:lang}...{code} or {code}...{code}
  md = md.replace(/\{code(?::([a-zA-Z0-9_-]+))?\}([\s\S]*?)\{code\}/g, (_, lang, content) => {
    return `\`\`\`${lang || ""}\n${content.trim()}\n\`\`\``;
  });

  // Noformat blocks: {noformat}...{noformat}
  md = md.replace(/\{noformat\}([\s\S]*?)\{noformat\}/g, (_, content) => {
    return `\`\`\`\n${content.trim()}\n\`\`\``;
  });

  // Quotes: {quote}...{quote}
  md = md.replace(/\{quote\}([\s\S]*?)\{quote\}/g, (_, content) => {
    return content
      .trim()
      .split("\n")
      .map((line: string) => `> ${line}`)
      .join("\n");
  });

  // Panels: {panel:title=...}...{panel}
  md = md.replace(/\{panel(?::(?:title=([^|}]+))?[^}]*)?\}([\s\S]*?)\{panel\}/g, (_, title, content) => {
    const prefix = title ? `> **${title.trim()}**\n` : "";
    const body = content
      .trim()
      .split("\n")
      .map((line: string) => `> ${line}`)
      .join("\n");
    return `${prefix}${body}`;
  });

  // Color tags: {color:red}text{color} -> text
  md = md.replace(/\{color(?::[^}]+)?\}([\s\S]*?)\{color\}/g, "$1");

  // Numbered list items: # item -> 1. item, ## subitem ->   1. subitem
  md = md.replace(/^[ \t]*(#+)\s+(.*)$/gm, (_, hashes, text) => {
    const depth = hashes.length - 1;
    const indent = "  ".repeat(depth);
    return `${indent}1. ${text.trim()}`;
  });

  // Bullet list items: * item -> - item, ** subitem ->   - subitem
  md = md.replace(/^[ \t]*(\*+)\s+(.*)$/gm, (_, stars, text) => {
    const depth = stars.length - 1;
    const indent = "  ".repeat(depth);
    return `${indent}- ${text.trim()}`;
  });

  // Headings: h1. Heading -> # Heading, ..., h6. Heading -> ###### Heading
  md = md.replace(/^[ \t]*h([1-6])\.\s+(.*)$/gm, (_, level, text) => {
    const hashes = "#".repeat(parseInt(level, 10));
    return `${hashes} ${text.trim()}`;
  });

  // Blockquotes: bq. Quote -> > Quote
  md = md.replace(/^[ \t]*bq\.\s+(.*)$/gm, "> $1");

  // Tables: ||header 1||header 2|| and |cell 1|cell 2|
  md = md.replace(/((?:^[ \t]*\|[^\n]+\|[ \t]*(?:\n|$))+)/gm, (tableBlock) => {
    const lines = tableBlock.trim().split("\n");
    const formattedLines: string[] = [];
    let isFirst = true;

    for (const line of lines) {
      const isHeader = line.includes("||");
      const cleaned = line
        .replace(/^\|+/, "")
        .replace(/\|+$/, "")
        .split(/\|\||\|/)
        .map((cell) => cell.trim());

      formattedLines.push(`| ${cleaned.join(" | ")} |`);

      if (isFirst) {
        formattedLines.push(`| ${Array(cleaned.length).fill("---").join(" | ")} |`);
        isFirst = false;
      }
    }
    return formattedLines.join("\n");
  });

  // Links: [Text|URL] -> [Text](URL) and [URL] -> [URL](URL)
  md = md.replace(/\[(?:([^|\]]+)\|)?([^\]]+)\]/g, (_, title, url) => {
    const linkUrl = (url || "").trim();
    const linkTitle = (title || linkUrl).trim();
    return `[${linkTitle}](${linkUrl})`;
  });

  // Images: !image.png|width=100! or !image.png! -> ![image.png](image.png)
  md = md.replace(/!([^!|\n]+)(?:\|[^!]*)?!/g, "![$1]($1)");

  // Inline formatting:
  // Monospace: {{code}} -> `code`
  md = md.replace(/\{\{([^{}\n]+)\}\}/g, "`$1`");

  // Bold: *bold* -> **bold**
  md = md.replace(/(?<=^|[\s(])\*([^*\n]+)\*(?=$|[\s),.:;!?])/g, "**$1**");

  // Italic: _italic_ -> *italic*
  md = md.replace(/(?<=^|[\s(])_([^_\n]+)_(?=$|[\s),.:;!?])/g, "*$1*");

  // Strikethrough: -strike- -> ~~strike~~
  md = md.replace(/(?<=^|[\s(])-([^\-\n]+)-(?=$|[\s),.:;!?])/g, "~~$1~~");

  // Underline: +underline+ -> <u>underline</u>
  md = md.replace(/(?<=^|[\s(])\+([^\+\n]+)\+(?=$|[\s),.:;!?])/g, "<u>$1</u>");

  return md.trim();
}
