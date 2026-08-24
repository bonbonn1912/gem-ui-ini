// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FileViewer } from "../../src/renderer/features/explorer/FileViewer";
import {
  detectLanguage,
  highlightCode,
} from "../../src/renderer/features/explorer/syntax-highlighter";
import type { AppProject } from "../../src/renderer/types";

describe("syntax-highlighter", () => {
  describe("detectLanguage", () => {
    it("detects languages from file extensions", () => {
      expect(detectLanguage("App.tsx")).toBe("tsx");
      expect(detectLanguage("service.ts")).toBe("typescript");
      expect(detectLanguage("index.js")).toBe("javascript");
      expect(detectLanguage("Component.jsx")).toBe("jsx");
      expect(detectLanguage("schema.json")).toBe("json");
      expect(detectLanguage("style.css")).toBe("css");
      expect(detectLanguage("style.scss")).toBe("scss");
      expect(detectLanguage("index.html")).toBe("html");
      expect(detectLanguage("README.md")).toBe("markdown");
      expect(detectLanguage("script.py")).toBe("python");
      expect(detectLanguage("main.rs")).toBe("rust");
      expect(detectLanguage("server.go")).toBe("go");
      expect(detectLanguage("query.sql")).toBe("sql");
      expect(detectLanguage("deploy.sh")).toBe("bash");
      expect(detectLanguage("config.yaml")).toBe("yaml");
      expect(detectLanguage("Cargo.toml")).toBe("toml");
    });

    it("detects languages from special filenames", () => {
      expect(detectLanguage("Dockerfile")).toBe("dockerfile");
      expect(detectLanguage("Makefile")).toBe("makefile");
      expect(detectLanguage("package.json")).toBe("json");
      expect(detectLanguage("tsconfig.json")).toBe("json");
    });

    it("falls back to plain for unknown files", () => {
      expect(detectLanguage("LICENSE")).toBe("plain");
      expect(detectLanguage("data.xyz123")).toBe("plain");
    });
  });

  describe("highlightCode", () => {
    it("tokenizes TypeScript code", () => {
      const code = `import { useState } from "react";\n// A comment\nconst count: number = 42;\nexport function getCount(): number {\n  return count;\n}`;
      const result = highlightCode(code, "typescript");
      expect(result).toHaveLength(6);

      // Line 1: import { useState } from "react";
      const line1Types = result[0]?.map((t) => t.type);
      expect(line1Types).toContain("keyword"); // import, from
      expect(line1Types).toContain("string"); // "react"

      // Line 2: // A comment
      expect(result[1]?.[0]?.type).toBe("comment");

      // Line 3: const count: number = 42;
      const line3Types = result[2]?.map((t) => t.type);
      expect(line3Types).toContain("keyword"); // const
      expect(line3Types).toContain("type"); // number
      expect(line3Types).toContain("number"); // 42

      // Line 4: export function getCount(): number {
      const line4Types = result[3]?.map((t) => t.type);
      expect(line4Types).toContain("keyword"); // export, function
      expect(line4Types).toContain("function"); // getCount

      // Line 5: return count;
      const line5Types = result[4]?.map((t) => t.type);
      expect(line5Types).toContain("keyword"); // return
    });

    it("handles multiline comments and strings across line breaks", () => {
      const code = `/*\n * Line 2 of comment\n */\nconst msg = \`multi\nline\`;`;
      const result = highlightCode(code, "typescript");

      expect(result).toHaveLength(5);
      expect(result[0]?.[0]?.type).toBe("comment");
      expect(result[0]?.[0]?.text).toBe("/*");

      expect(result[1]?.[0]?.type).toBe("comment");
      expect(result[1]?.[0]?.text).toBe(" * Line 2 of comment");

      expect(result[2]?.[0]?.type).toBe("comment");
      expect(result[2]?.[0]?.text).toBe(" */");

      // Template string on lines 4 and 5
      expect(result[3]?.some((t) => t.type === "string")).toBe(true);
      expect(result[4]?.some((t) => t.type === "string")).toBe(true);
    });

    it("tokenizes JSON correctly", () => {
      const json = `{\n  "name": "geminui",\n  "version": 1,\n  "private": true\n}`;
      const result = highlightCode(json, "json");
      expect(result).toHaveLength(5);

      // Line 2: "name": "geminui"
      const line2 = result[1]!;
      expect(line2.some((t) => t.type === "property" && t.text.includes("name"))).toBe(true);
      expect(line2.some((t) => t.type === "string" && t.text.includes("geminui"))).toBe(true);

      // Line 3: "version": 1
      const line3 = result[2]!;
      expect(line3.some((t) => t.type === "property" && t.text.includes("version"))).toBe(true);
      expect(line3.some((t) => t.type === "number" && t.text === "1")).toBe(true);

      // Line 4: "private": true
      const line4 = result[3]!;
      expect(line4.some((t) => t.type === "property" && t.text.includes("private"))).toBe(true);
      expect(line4.some((t) => t.type === "boolean" && t.text === "true")).toBe(true);
    });

    it("tokenizes Python correctly", () => {
      const py = `def greet(name: str) -> None:\n    # Says hello\n    print(f"Hello, {name}!")\n    return True`;
      const result = highlightCode(py, "python");
      expect(result).toHaveLength(4);

      // Line 1: def, greet, str, None
      const line1 = result[0]!;
      expect(line1.some((t) => t.type === "keyword" && t.text === "def")).toBe(true);
      expect(line1.some((t) => t.type === "function" && t.text === "greet")).toBe(true);
      expect(line1.some((t) => t.type === "type" && t.text === "str")).toBe(true);
      expect(line1.some((t) => t.type === "boolean" && t.text === "None")).toBe(true);

      // Line 2: comment
      expect(result[1]?.some((t) => t.type === "comment")).toBe(true);

      // Line 4: return, True
      const line4 = result[3]!;
      expect(line4.some((t) => t.type === "keyword" && t.text === "return")).toBe(true);
      expect(line4.some((t) => t.type === "boolean" && t.text === "True")).toBe(true);
    });

    it("tokenizes HTML correctly", () => {
      const html = `<!-- Header -->\n<div className="card">\n  <span>Text</span>\n</div>`;
      const result = highlightCode(html, "html");
      expect(result).toHaveLength(4);

      // Line 1: comment
      expect(result[0]?.[0]?.type).toBe("comment");

      // Line 2: <div, className, "card"
      const line2 = result[1]!;
      expect(line2.some((t) => t.type === "tag" && t.text === "<div")).toBe(true);
      expect(line2.some((t) => t.type === "attr-name" && t.text === "className")).toBe(true);
      expect(line2.some((t) => t.type === "attr-value" && t.text === '"card"')).toBe(true);
    });

    it("tokenizes CSS correctly", () => {
      const css = `.card {\n  color: var(--accent);\n  padding: 12px 16px;\n}`;
      const result = highlightCode(css, "css");
      expect(result).toHaveLength(4);

      // Line 2: color, var, --accent
      const line2 = result[1]!;
      expect(line2.some((t) => t.type === "property" && t.text === "color")).toBe(true);
      expect(line2.some((t) => t.type === "function" && t.text === "var")).toBe(true);

      // Line 3: padding, 12px, 16px
      const line3 = result[2]!;
      expect(line3.some((t) => t.type === "property" && t.text === "padding")).toBe(true);
      expect(line3.some((t) => t.type === "number" && t.text === "12px")).toBe(true);
    });

    it("tokenizes SQL correctly", () => {
      const sql = `SELECT id, name FROM users WHERE active = 1;`;
      const result = highlightCode(sql, "sql");
      expect(result).toHaveLength(1);

      const line1 = result[0]!;
      expect(line1.some((t) => t.type === "keyword" && t.text === "SELECT")).toBe(true);
      expect(line1.some((t) => t.type === "keyword" && t.text === "FROM")).toBe(true);
      expect(line1.some((t) => t.type === "keyword" && t.text === "WHERE")).toBe(true);
      expect(line1.some((t) => t.type === "number" && t.text === "1")).toBe(true);
    });

    it("tokenizes Bash correctly", () => {
      const bash = `echo "Deploying to $ENV" --verbose`;
      const result = highlightCode(bash, "bash");
      expect(result).toHaveLength(1);

      const line1 = result[0]!;
      expect(line1.some((t) => t.type === "function" && t.text === "echo")).toBe(true);
      expect(line1.some((t) => t.type === "string")).toBe(true);
      expect(line1.some((t) => t.type === "property" && t.text === "--verbose")).toBe(true);
    });

    it("tokenizes Java correctly", () => {
      const java = `@Override\npublic static void main(String[] args) {\n    // Print greeting\n    System.out.println("Hello World");\n    return null;\n}`;
      const result = highlightCode(java, "java");
      expect(result).toHaveLength(6);

      // Line 1: @Override
      expect(result[0]?.some((t) => t.type === "decorator" && t.text === "@Override")).toBe(true);

      // Line 2: public static void main(String[] args)
      const line2 = result[1]!;
      expect(line2.some((t) => t.type === "keyword" && t.text === "public")).toBe(true);
      expect(line2.some((t) => t.type === "keyword" && t.text === "static")).toBe(true);
      expect(line2.some((t) => t.type === "type" && t.text === "void")).toBe(true);
      expect(line2.some((t) => t.type === "function" && t.text === "main")).toBe(true);
      expect(line2.some((t) => t.type === "type" && t.text === "String")).toBe(true);

      // Line 3: comment
      expect(result[2]?.some((t) => t.type === "comment")).toBe(true);

      // Line 4: println("Hello World")
      const line4 = result[3]!;
      expect(line4.some((t) => t.type === "function" && t.text === "println")).toBe(true);
      expect(line4.some((t) => t.type === "string" && t.text === '"Hello World"')).toBe(true);

      // Line 5: return null;
      const line5 = result[4]!;
      expect(line5.some((t) => t.type === "keyword" && t.text === "return")).toBe(true);
      expect(line5.some((t) => t.type === "boolean" && t.text === "null")).toBe(true);
    });

    it("handles empty or blank lines gracefully", () => {
      const result = highlightCode("", "typescript");
      expect(result).toEqual([[]]);

      const resultWithBlank = highlightCode("const a = 1;\n\nconst b = 2;", "typescript");
      expect(resultWithBlank).toHaveLength(3);
      expect(resultWithBlank[1]).toEqual([]);
    });
  });

  describe("FileViewer integration", () => {
    it("renders syntax-highlighted tokens in the DOM", async () => {
      const mockProject: AppProject = {
        id: "p1",
        name: "Test Project",
        primaryRootId: "r1",
        rootRevision: 1,
        rootFingerprint: "0".repeat(64),
        approvalModeId: null,
        approvalModeState: "gemini_default",
        statsEnabled: false,
        liveTokensEnabled: false,
        archived: false,
        roots: [
          {
            id: "r1",
            projectId: "p1",
            kind: "primary",
            path: "/test",
            realPath: "/test",
            label: "test",
            sortOrder: 0,
            createdAt: "2026-08-24T10:00:00.000Z",
            updatedAt: "2026-08-24T10:00:00.000Z",
          },
        ],
        createdAt: "2026-08-24T10:00:00.000Z",
        updatedAt: "2026-08-24T10:00:00.000Z",
      };

      (window as unknown as { gemUi: Record<string, unknown> }).gemUi = {
        projectFiles: {
          readFile: vi.fn().mockResolvedValue({
            projectId: "p1",
            rootRevision: 1,
            rootId: "r1",
            relativePath: "src/utils.ts",
            displayName: "utils.ts",
            size: 45,
            mimeType: "text/typescript",
            binary: false,
            content: "export const MAX_RETRY = 5;",
            truncated: false,
            lineCount: 1,
            language: "typescript",
          }),
        },
      };

      render(
        <FileViewer
          project={mockProject}
          file={{
            rootId: "r1",
            relativePath: "src/utils.ts",
            displayName: "utils.ts",
          }}
          onClose={vi.fn()}
        />,
      );

      await waitFor(() => {
        expect(screen.getByText("export")).toHaveClass("tok-keyword");
        expect(screen.getByText("const")).toHaveClass("tok-keyword");
        expect(screen.getByText("5")).toHaveClass("tok-number");
      });
    });
  });
});
