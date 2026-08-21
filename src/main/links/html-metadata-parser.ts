export type HtmlMetadata = {
  title: string | null;
  description: string | null;
  siteName: string | null;
  imageUrl: string | null;
};

export function parseHtmlMetadata(html: string, pageUrl: URL): HtmlMetadata {
  let documentTitle: string | null = null;
  let title: string | null = null;
  let description: string | null = null;
  let siteName: string | null = null;
  let image: string | null = null;

  const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
  if (titleMatch?.[1]) documentTitle = cleanText(titleMatch[1], 300);

  for (const match of html.matchAll(/<(meta|link)\b([^>]*)>/gi)) {
    const tag = match[1]?.toLowerCase();
    const attributes = parseAttributes(match[2] ?? "");
    if (tag === "meta") {
      const key = (attributes.property ?? attributes.name ?? "").toLowerCase();
      const content = attributes.content;
      if (!content) continue;
      if (["og:title", "twitter:title"].includes(key) && !title) title = cleanText(content, 300);
      if (["og:description", "twitter:description", "description"].includes(key) && !description) {
        description = cleanText(content, 1_000);
      }
      if (key === "og:site_name" && !siteName) siteName = cleanText(content, 200);
      if (["og:image", "twitter:image", "twitter:image:src"].includes(key) && !image) image = content;
    } else if (tag === "link" && !image) {
      const rel = (attributes.rel ?? "").toLowerCase().split(/\s+/);
      if (rel.includes("icon") && attributes.href) image = attributes.href;
    }
  }

  return {
    title: title || documentTitle,
    description,
    siteName,
    imageUrl: resolveHttpsUrl(image, pageUrl),
  };
}

function parseAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of source.matchAll(/([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g)) {
    const name = match[1]?.toLowerCase();
    const value = match[2] ?? match[3] ?? match[4];
    if (name && value !== undefined) attributes[name] = decodeEntities(value);
  }
  return attributes;
}

function cleanText(value: string, maximum: number): string | null {
  const cleaned = decodeEntities(value)
    .replace(/<[^>]*>/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);
  return cleaned || null;
}

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (_match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith("#x")) return safeCodePoint(Number.parseInt(lower.slice(2), 16));
    if (lower.startsWith("#")) return safeCodePoint(Number.parseInt(lower.slice(1), 10));
    return ({ amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" } as Record<string, string>)[lower] ?? "";
  });
}

function safeCodePoint(value: number): string {
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff)
    ? String.fromCodePoint(value)
    : "";
}

function resolveHttpsUrl(value: string | null, pageUrl: URL): string | null {
  if (!value) return null;
  try {
    const resolved = new URL(value, pageUrl);
    return resolved.protocol === "https:" ? resolved.toString() : null;
  } catch {
    return null;
  }
}
