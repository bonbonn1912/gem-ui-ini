import { createHash } from "node:crypto";

import {
  MAX_GIT_DIFF_HUNKS,
  MAX_GIT_DIFF_LINES,
  type GitDiffHunk,
} from "../../shared/contracts";

export type ParsedUnifiedDiff = {
  binary: boolean;
  additions: number;
  deletions: number;
  metadata: string[];
  hunks: GitDiffHunk[];
};

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

export function parseUnifiedDiff(input: Buffer | string): ParsedUnifiedDiff {
  const text = typeof input === "string" ? input : input.toString("utf8");
  const sourceLines = text.split("\n");
  if (sourceLines.at(-1) === "") sourceLines.pop();

  const metadata: string[] = [];
  const hunks: GitDiffHunk[] = [];
  let binary = false;
  let additions = 0;
  let deletions = 0;
  let totalLines = 0;

  for (let index = 0; index < sourceLines.length;) {
    const line = stripTerminalCr(sourceLines[index] ?? "");
    if (line.startsWith("Binary files ") || line === "GIT binary patch") {
      binary = true;
      metadata.push(line);
      index += 1;
      continue;
    }
    if (!line.startsWith("@@ ")) {
      if (isDisplayMetadata(line) && metadata.length < 100) metadata.push(line);
      index += 1;
      continue;
    }

    const match = line.match(HUNK_HEADER);
    if (!match) throw new Error("Invalid unified diff hunk header");
    if (hunks.length >= MAX_GIT_DIFF_HUNKS) {
      throw new DiffLineLimitError();
    }
    const oldStart = Number(match[1]);
    const oldLines = match[2] === undefined ? 1 : Number(match[2]);
    const newStart = Number(match[3]);
    const newLines = match[4] === undefined ? 1 : Number(match[4]);
    let oldLine = oldStart;
    let newLine = newStart;
    const lines: GitDiffHunk["lines"] = [];
    index += 1;

    while (index < sourceLines.length) {
      const source = stripTerminalCr(sourceLines[index] ?? "");
      if (source.startsWith("@@ ") || source.startsWith("diff --git ")) break;
      const prefix = source[0];
      if (prefix === " ") {
        lines.push({
          kind: "context",
          content: source.slice(1),
          oldLine,
          newLine,
        });
        oldLine += 1;
        newLine += 1;
      } else if (prefix === "+") {
        lines.push({
          kind: "addition",
          content: source.slice(1),
          oldLine: null,
          newLine,
        });
        additions += 1;
        newLine += 1;
      } else if (prefix === "-") {
        lines.push({
          kind: "deletion",
          content: source.slice(1),
          oldLine,
          newLine: null,
        });
        deletions += 1;
        oldLine += 1;
      } else if (prefix === "\\") {
        lines.push({
          kind: "no_newline",
          content: source.slice(1).trimStart(),
          oldLine: null,
          newLine: null,
        });
      } else {
        break;
      }
      totalLines += 1;
      if (totalLines > MAX_GIT_DIFF_LINES) throw new DiffLineLimitError();
      index += 1;
    }

    hunks.push({
      hunkId: createHash("sha256")
        .update(`${hunks.length}\0${line}`, "utf8")
        .digest("hex"),
      header: line,
      oldStart,
      oldLines,
      newStart,
      newLines,
      lines,
    });
  }

  return { binary, additions, deletions, metadata, hunks };
}

export class DiffLineLimitError extends Error {
  constructor() {
    super("The diff exceeds the safe parsed-line limit");
    this.name = "DiffLineLimitError";
  }
}

function stripTerminalCr(value: string): string {
  return value.endsWith("\r") ? value.slice(0, -1) : value;
}

function isDisplayMetadata(line: string): boolean {
  return /^(?:diff --git |index |--- |\+\+\+ |old mode |new mode |new file mode |deleted file mode |similarity index |dissimilarity index |rename from |rename to |copy from |copy to |Submodule )/.test(line);
}
