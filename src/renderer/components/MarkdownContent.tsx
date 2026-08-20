import { useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Icon } from "./Icon";

type MarkdownContentProps = {
  children: string;
  onOpenExternal: (url: string) => void;
};

function textFromNode(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textFromNode).join("");
  if (node && typeof node === "object" && "props" in node) {
    return textFromNode((node as { props: { children?: ReactNode } }).props.children);
  }
  return "";
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const content = textFromNode(children).replace(/\n$/, "");

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="code-block">
      <button className="code-copy" type="button" onClick={copy} aria-label="Code kopieren">
        <Icon name={copied ? "check" : "copy"} size={14} />
        <span>{copied ? "Kopiert" : "Kopieren"}</span>
      </button>
      <pre>{children}</pre>
    </div>
  );
}

export function MarkdownContent({ children, onOpenExternal }: MarkdownContentProps) {
  const components: Components = {
    a({ href, children: linkChildren }) {
      if (!href?.startsWith("https://")) {
        return <span className="unsafe-link">{linkChildren}</span>;
      }
      return (
        <a
          href={href}
          onClick={(event) => {
            event.preventDefault();
            onOpenExternal(href);
          }}
        >
          {linkChildren}
        </a>
      );
    },
    img({ alt }) {
      return <span className="blocked-image">[Externes Bild: {alt || "ohne Beschreibung"}]</span>;
    },
    pre({ children: preChildren }) {
      return <CodeBlock>{preChildren}</CodeBlock>;
    },
  };

  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} skipHtml>
        {children}
      </ReactMarkdown>
    </div>
  );
}

