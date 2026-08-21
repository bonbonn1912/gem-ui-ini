import { Agent } from "undici";
import {
  RawGitLabDiscussionNoteSchema,
  RawGitLabDiscussionSchema,
  RawGitLabFileSchema,
  RawGitLabMergeRequestSchema,
  RawGitLabPersonalAccessTokenSchema,
  RawGitLabProjectSchema,
  RawGitLabUserSchema,
} from "./gitlab-api-schemas";

export type GitLabApiClientOptions = {
  instanceUrl: string;
  apiBaseUrl?: string;
  token: string;
  allowSelfSignedTls?: boolean;
  fetchFn?: typeof fetch;
};

export class GitLabApiError extends Error {
  readonly status: number;
  readonly retryAfterSeconds: number | null;

  constructor(status: number, message: string, retryAfterSeconds: number | null = null) {
    super(message);
    this.name = "GitLabApiError";
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function normalizeApiBaseUrl(instanceUrl: string): { instanceUrl: string; apiBaseUrl: string } {
  let urlStr = instanceUrl.trim();
  if (!urlStr.startsWith("http://") && !urlStr.startsWith("https://")) {
    urlStr = `https://${urlStr}`;
  }
  const parsed = new URL(urlStr);
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
    throw new Error("GitLab-Instanz-URLs müssen das HTTPS-Protokoll verwenden.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("GitLab-Instanz-URLs dürfen keine Benutzerdaten (Credentials) enthalten.");
  }

  let basePath = parsed.pathname.replace(/\/+$/, "");
  if (basePath.endsWith("/api/v4")) {
    basePath = basePath.slice(0, -"/api/v4".length);
  }

  // If host is gitlab.com, any pathname is a project/user path and not part of the instance base URL
  if (parsed.hostname.toLowerCase() === "gitlab.com") {
    basePath = "";
  } else if (basePath.endsWith(".git") || basePath.includes("/-/")) {
    // If a full git clone or MR URL was pasted as instance URL
    basePath = "";
  }

  const portSuffix = parsed.port ? `:${parsed.port}` : "";
  const normalizedInstance = `${parsed.protocol}//${parsed.hostname}${portSuffix}${basePath}`;
  const apiBaseUrl = `${normalizedInstance}/api/v4`;

  return {
    instanceUrl: normalizedInstance,
    apiBaseUrl,
  };
}

export class GitLabApiClient {
  readonly instanceUrl: string;
  readonly apiBaseUrl: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #dispatcher?: Agent;

  constructor(options: GitLabApiClientOptions) {
    const normalized = normalizeApiBaseUrl(options.instanceUrl);
    this.instanceUrl = normalized.instanceUrl;
    this.apiBaseUrl = options.apiBaseUrl ?? normalized.apiBaseUrl;
    this.#token = options.token.trim();
    this.#fetch = options.fetchFn ?? fetch;
    if (options.allowSelfSignedTls) {
      this.#dispatcher = new Agent({
        connect: {
          rejectUnauthorized: false,
        },
      });
    }
  }

  async getCurrentUser() {
    const data = await this.#request("GET", "/user");
    return RawGitLabUserSchema.parse(data);
  }

  async getPersonalAccessTokenSelf() {
    try {
      const data = await this.#request("GET", "/personal_access_tokens/self");
      return RawGitLabPersonalAccessTokenSchema.parse(data);
    } catch {
      return null;
    }
  }

  async getProject(projectPathOrId: string | number) {
    const encoded = encodeURIComponent(String(projectPathOrId));
    const data = await this.#request("GET", `/projects/${encoded}`);
    return RawGitLabProjectSchema.parse(data);
  }

  async listMergeRequests(
    projectPathOrId: number | string,
    options?: { sourceBranch?: string; state?: string },
  ) {
    const encoded = encodeURIComponent(String(projectPathOrId));
    const params = new URLSearchParams();
    params.set("per_page", "50");
    params.set("scope", "all");
    if (options?.state) params.set("state", options.state);
    if (options?.sourceBranch) params.set("source_branch", options.sourceBranch);

    const items = await this.#requestPaginated(`/projects/${encoded}/merge_requests?${params.toString()}`);
    return items.map((item) => RawGitLabMergeRequestSchema.parse(item));
  }

  async getMergeRequest(projectPathOrId: number | string, mergeRequestIid: number) {
    const encoded = encodeURIComponent(String(projectPathOrId));
    const data = await this.#request("GET", `/projects/${encoded}/merge_requests/${mergeRequestIid}`);
    return RawGitLabMergeRequestSchema.parse(data);
  }

  async listDiscussions(projectPathOrId: number | string, mergeRequestIid: number) {
    const encoded = encodeURIComponent(String(projectPathOrId));
    const items = await this.#requestPaginated(
      `/projects/${encoded}/merge_requests/${mergeRequestIid}/discussions?per_page=100`,
      20,
    );
    return items.map((item) => RawGitLabDiscussionSchema.parse(item));
  }

  async resolveDiscussion(
    projectPathOrId: number | string,
    mergeRequestIid: number,
    discussionId: string,
    resolved: boolean,
  ) {
    const encoded = encodeURIComponent(String(projectPathOrId));
    const data = await this.#request(
      "PUT",
      `/projects/${encoded}/merge_requests/${mergeRequestIid}/discussions/${discussionId}`,
      { resolved },
    );
    return RawGitLabDiscussionSchema.parse(data);
  }

  async replyToDiscussion(
    projectPathOrId: number | string,
    mergeRequestIid: number,
    discussionId: string,
    body: string,
  ) {
    const encoded = encodeURIComponent(String(projectPathOrId));
    const data = await this.#request(
      "POST",
      `/projects/${encoded}/merge_requests/${mergeRequestIid}/discussions/${discussionId}/notes`,
      { body },
    );
    return RawGitLabDiscussionNoteSchema.parse(data);
  }

  async getFileContent(projectPathOrId: number | string, filePath: string, ref: string): Promise<string> {
    const encodedProj = encodeURIComponent(String(projectPathOrId));
    const encodedPath = encodeURIComponent(filePath);
    const params = new URLSearchParams({ ref });
    const data = await this.#request("GET", `/projects/${encodedProj}/repository/files/${encodedPath}?${params.toString()}`);
    const parsed = RawGitLabFileSchema.parse(data);
    if (parsed.encoding === "base64") {
      return Buffer.from(parsed.content, "base64").toString("utf-8");
    }
    return parsed.content;
  }

  async #request(
    method: string,
    endpoint: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const url = endpoint.startsWith("http") ? endpoint : `${this.apiBaseUrl}${endpoint}`;
    const headers: Record<string, string> = {
      "PRIVATE-TOKEN": this.#token,
      Accept: "application/json",
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const timeoutSignal = AbortSignal.timeout(15000);
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

    let response: Response;
    try {
      response = await this.#fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        redirect: "follow",
        signal: combinedSignal,
        ...(this.#dispatcher ? { dispatcher: this.#dispatcher } : {}),
      } as RequestInit);
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new GitLabApiError(408, `Zeitüberschreitung bei der Anfrage an ${url}.`);
      }
      const cause = (err as any)?.cause ? ` (${(err as any).cause.message || (err as any).cause})` : "";
      throw new GitLabApiError(0, `Netzwerkfehler bei Verbindung zu ${url}: ${(err as Error).message}${cause}`);
    }

    if (!response.ok) {
      let retryAfterSeconds: number | null = null;
      const retryHeader = response.headers.get("retry-after");
      if (retryHeader) {
        const parsed = parseInt(retryHeader, 10);
        if (!isNaN(parsed) && parsed > 0) retryAfterSeconds = Math.min(parsed, 300);
      }

      let errorDetail = "";
      try {
        const errorJson = (await response.json()) as { message?: unknown; error?: unknown; error_description?: unknown };
        const msg = errorJson.message || errorJson.error_description || errorJson.error;
        if (msg) {
          errorDetail = typeof msg === "object" ? JSON.stringify(msg) : String(msg);
        }
      } catch {
        try {
          errorDetail = (await response.text()).slice(0, 300);
        } catch {
          // ignore
        }
      }

      if (response.status === 401) {
        throw new GitLabApiError(
          401,
          errorDetail
            ? `GitLab-Token ungültig/abgelehnt (${response.status}): ${errorDetail}`
            : `GitLab-Token ist ungültig, abgelaufen oder hat unzureichende Rechte für ${url}.`,
        );
      }
      if (response.status === 403) {
        throw new GitLabApiError(
          403,
          errorDetail
            ? `GitLab Zugriff verweigert (${response.status}): ${errorDetail}`
            : "Keine ausreichenden Berechtigungen für diese GitLab-Aktion (fehlender Scope oder Rolle).",
          retryAfterSeconds,
        );
      }
      if (response.status === 404) {
        throw new GitLabApiError(
          404,
          errorDetail
            ? `GitLab Ressource nicht gefunden (${response.status}): ${errorDetail}`
            : `GitLab-Endpunkt oder Ressource unter ${url} nicht gefunden.`,
          retryAfterSeconds,
        );
      }
      if (response.status === 429) {
        throw new GitLabApiError(429, "GitLab Rate Limit erreicht. Bitte kurz warten.", retryAfterSeconds);
      }

      throw new GitLabApiError(
        response.status,
        errorDetail ? `GitLab API Fehler (${response.status}): ${errorDetail}` : `GitLab API antwortete mit Status ${response.status}.`,
        retryAfterSeconds,
      );
    }

    return response.json();
  }

  async #requestPaginated(endpoint: string, maxPages = 10): Promise<unknown[]> {
    const allItems: unknown[] = [];
    let nextUrl: string | null = endpoint.startsWith("http") ? endpoint : `${this.apiBaseUrl}${endpoint}`;
    let pageCount = 0;

    while (nextUrl && pageCount < maxPages) {
      pageCount++;
      const headers: Record<string, string> = {
        "PRIVATE-TOKEN": this.#token,
        Accept: "application/json",
      };

      const timeoutSignal = AbortSignal.timeout(15000);
      let response: Response;
      try {
        response = await this.#fetch(nextUrl, {
          method: "GET",
          headers,
          redirect: "follow",
          signal: timeoutSignal,
          ...(this.#dispatcher ? { dispatcher: this.#dispatcher } : {}),
        } as RequestInit);
      } catch (err: unknown) {
        if (err instanceof Error && err.name === "TimeoutError") {
          throw new GitLabApiError(408, "Zeitüberschreitung bei der Anfrage an GitLab.");
        }
        const cause = (err as any)?.cause ? ` (${(err as any).cause.message || (err as any).cause})` : "";
        throw new GitLabApiError(0, `Netzwerkfehler bei Verbindung zu GitLab: ${(err as Error).message}${cause}`);
      }

      if (!response.ok) {
        let errorDetail = "";
        try {
          const errorJson = (await response.json()) as { message?: unknown; error?: unknown; error_description?: unknown };
          const msg = errorJson.message || errorJson.error_description || errorJson.error;
          if (msg) {
            errorDetail = typeof msg === "object" ? JSON.stringify(msg) : String(msg);
          }
        } catch {
          try {
            errorDetail = (await response.text()).slice(0, 300);
          } catch {
            // ignore
          }
        }

        if (response.status === 401) {
          throw new GitLabApiError(
            401,
            errorDetail
              ? `GitLab-Token ungültig/abgelehnt (${response.status}): ${errorDetail}`
              : "GitLab-Token ist ungültig oder abgelaufen.",
          );
        }
        if (response.status === 403) {
          throw new GitLabApiError(
            403,
            errorDetail
              ? `GitLab Zugriff verweigert (${response.status}): ${errorDetail}`
              : "Keine ausreichenden Berechtigungen.",
          );
        }
        if (response.status === 404) {
          throw new GitLabApiError(
            404,
            errorDetail
              ? `GitLab Ressource nicht gefunden (${response.status}): ${errorDetail}`
              : `GitLab-Ressource unter ${nextUrl} nicht gefunden.`,
          );
        }
        if (response.status === 429) {
          throw new GitLabApiError(429, "GitLab Rate Limit erreicht.");
        }
        throw new GitLabApiError(
          response.status,
          errorDetail
            ? `GitLab API Fehler (${response.status}): ${errorDetail}`
            : `GitLab API Fehler (${response.status})`,
        );
      }

      const json = await response.json();
      if (Array.isArray(json)) {
        allItems.push(...json);
      } else {
        break;
      }

      // Check pagination header
      const linkHeader = response.headers.get("link");
      const nextPageHeader = response.headers.get("x-next-page");

      if (linkHeader) {
        const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
        nextUrl = nextMatch ? nextMatch[1]! : null;
      } else if (nextPageHeader && parseInt(nextPageHeader, 10) > 0) {
        const urlObj = new URL(nextUrl);
        urlObj.searchParams.set("page", nextPageHeader);
        nextUrl = urlObj.toString();
      } else {
        nextUrl = null;
      }
    }

    return allItems;
  }
}
