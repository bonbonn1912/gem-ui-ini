import MarkdownIt from "markdown-it";
import { createMemo, createSignal, type JSX } from "solid-js";

type MarkdownContentProps = {
  children: string;
  onOpenExternal: (url: string) => void;
};

const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true });

function isSafeExternalUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function renderMarkdown(source: string): string {
  let unsafeLink = false;
  const { rules } = markdown.renderer;
  const defaultLinkOpen = rules.link_open;
  const defaultLinkClose = rules.link_close;
  const defaultImage = rules.image;
  const defaultFence = rules.fence;

  rules.link_open = (tokens, index, options, env, self) => {
    const rawHref = tokens[index]?.attrGet("href");
    const href = rawHref == null ? undefined : String(rawHref);
    if (!isSafeExternalUrl(href)) {
      unsafeLink = true;
      return `<span class="unsafe-link">`;
    }
    return defaultLinkOpen
      ? defaultLinkOpen(tokens, index, options, env, self)
      : self.renderToken(tokens, index, options);
  };
  rules.link_close = (tokens, index, options, env, self) => {
    if (unsafeLink) {
      unsafeLink = false;
      return "</span>";
    }
    return defaultLinkClose
      ? defaultLinkClose(tokens, index, options, env, self)
      : self.renderToken(tokens, index, options);
  };
  rules.image = (tokens, index) => {
    const rawAlt = tokens[index]?.attrGet("alt");
    const alt = rawAlt == null ? "ohne Beschreibung" : String(rawAlt);
    return `<span class="blocked-image">[Externes Bild: ${markdown.utils.escapeHtml(alt)}]</span>`;
  };
  rules.fence = (tokens, index) => {
    const token = tokens[index];
    const content = token?.content ?? "";
    const language = token?.info?.trim() ? ` class="language-${escapeAttribute(token.info.trim())}"` : "";
    const code = markdown.utils.escapeHtml(content.replace(/\n$/, ""));
    return `<div class="code-block"><button class="code-copy" type="button" data-code="${escapeAttribute(content.replace(/\n$/, ""))}" aria-label="Code kopieren"><span>Kopieren</span></button><pre><code${language}>${code}</code></pre></div>`;
  };

  const output = markdown.render(source);
  rules.link_open = defaultLinkOpen;
  rules.link_close = defaultLinkClose;
  rules.image = defaultImage;
  rules.fence = defaultFence;
  return output;
}

export function MarkdownContent(props: MarkdownContentProps) {
  const [copied, setCopied] = createSignal<HTMLElement | null>(null);
  const rendered = createMemo(() => renderMarkdown(props.children));

  const onClick: JSX.EventHandlerUnion<HTMLDivElement, MouseEvent> = (event) => {
    const target = event.target as HTMLElement;
    const link = target.closest("a");
    if (link) {
      event.preventDefault();
      const href = link.getAttribute("href");
      if (isSafeExternalUrl(href)) props.onOpenExternal(href);
      return;
    }
    const button = target.closest<HTMLButtonElement>("button.code-copy");
    if (!button) return;
    void navigator.clipboard.writeText(button.dataset.code ?? "").then(() => {
      setCopied(button);
      button.querySelector("span")!.textContent = "Kopiert";
      window.setTimeout(() => {
        if (copied() === button) {
          button.querySelector("span")!.textContent = "Kopieren";
          setCopied(null);
        }
      }, 1_500);
    }).catch(() => undefined);
  };

  return <div class="markdown" innerHTML={rendered()} onClick={onClick} data-copied={copied() ? "true" : undefined} />;
}
