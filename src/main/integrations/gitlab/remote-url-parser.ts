export type ParsedGitLabRemote = {
  rawUrl: string;
  sanitizedUrl: string;
  host: string;
  port: number | null;
  instanceUrl: string;
  projectPath: string;
};

export function parseGitLabRemoteUrl(rawUrl: string): ParsedGitLabRemote | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;

  // Case 1: SCP-style git@host:group/subgroup/project.git
  const scpMatch = trimmed.match(/^(?:[\w.-]+@)?([\w.-]+):(?!\/\/)(.+)$/);
  if (scpMatch) {
    const host = scpMatch[1]!.toLowerCase();
    let rawPath = scpMatch[2]!;
    if (rawPath.endsWith(".git")) rawPath = rawPath.slice(0, -4);
    const normalizedPath = rawPath
      .split("/")
      .map((s) => s.trim())
      .filter(Boolean)
      .join("/");
    if (!normalizedPath || normalizedPath.includes("..")) return null;

    const instanceUrl = `https://${host}`;
    const sanitizedUrl = `git@${host}:${normalizedPath}.git`;
    return {
      rawUrl: trimmed,
      sanitizedUrl,
      host,
      port: null,
      instanceUrl,
      projectPath: normalizedPath,
    };
  }

  // Case 2: Standard URI (https://, http://, ssh://, git://)
  try {
    const url = new URL(trimmed);
    const host = url.hostname.toLowerCase();
    if (!host) return null;

    const port = url.port ? parseInt(url.port, 10) : null;
    const isSsh = url.protocol === "ssh:" || url.protocol === "git:";
    let pathname = url.pathname;

    const instanceUrl = isSsh || !port || (url.protocol === "https:" && port === 443) || (url.protocol === "http:" && port === 80)
      ? `https://${host}`
      : `${url.protocol}//${host}:${port}`;

    if (pathname.endsWith(".git")) pathname = pathname.slice(0, -4);
    const segments = pathname
      .split("/")
      .map((s) => s.trim())
      .filter(Boolean);

    if (segments.length === 0) return null;

    // For GitLab project paths, typically group/project or group/subgroup/project.
    const projectPath = segments.join("/");
    const portSuffix = port ? `:${port}` : "";
    const sanitizedUrl = `${url.protocol}//${host}${portSuffix}/${projectPath}.git`;

    return {
      rawUrl: trimmed,
      sanitizedUrl,
      host,
      port,
      instanceUrl,
      projectPath,
    };
  } catch {
    return null;
  }
}

export function sanitizeRemoteUrl(rawUrl: string): string {
  const parsed = parseGitLabRemoteUrl(rawUrl);
  return parsed ? parsed.sanitizedUrl : rawUrl.trim();
}
