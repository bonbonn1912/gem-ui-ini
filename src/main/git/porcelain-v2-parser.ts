export type ParsedGitBranch = {
  oid: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
};

export type ParsedGitStatusEntry = {
  path: string;
  previousPath: string | null;
  indexStatus: string;
  worktreeStatus: string;
  conflict: boolean;
  untracked: boolean;
  ignored: boolean;
  submodule: boolean;
  renameScore: number | null;
  headOid: string | null;
  indexOid: string | null;
};

export type ParsedGitStatus = {
  branch: ParsedGitBranch;
  entries: ParsedGitStatusEntry[];
};

const CONFLICT_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

export function parsePorcelainV2(input: Buffer | string): ParsedGitStatus {
  const records = (typeof input === "string" ? input : input.toString("utf8")).split("\0");
  const branch: ParsedGitBranch = {
    oid: null,
    head: null,
    upstream: null,
    ahead: 0,
    behind: 0,
  };
  const entries: ParsedGitStatusEntry[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;

    if (record.startsWith("# ")) {
      parseBranchHeader(record.slice(2), branch);
      continue;
    }
    if (record.startsWith("? ")) {
      entries.push({
        path: assertGitPath(record.slice(2)),
        previousPath: null,
        indexStatus: ".",
        worktreeStatus: "?",
        conflict: false,
        untracked: true,
        ignored: false,
        submodule: false,
        renameScore: null,
        headOid: null,
        indexOid: null,
      });
      continue;
    }
    if (record.startsWith("! ")) {
      entries.push({
        path: assertGitPath(record.slice(2)),
        previousPath: null,
        indexStatus: ".",
        worktreeStatus: "!",
        conflict: false,
        untracked: false,
        ignored: true,
        submodule: false,
        renameScore: null,
        headOid: null,
        indexOid: null,
      });
      continue;
    }
    if (record.startsWith("1 ")) {
      const fields = splitFields(record, 8);
      if (fields.length !== 9) throw new Error("Invalid porcelain v2 ordinary record");
      const xy = parseXy(fields[1]);
      entries.push({
        path: assertGitPath(fields[8]!),
        previousPath: null,
        indexStatus: xy[0],
        worktreeStatus: xy[1],
        conflict: CONFLICT_CODES.has(xy),
        untracked: false,
        ignored: false,
        submodule: isSubmodule(fields[2]),
        renameScore: null,
        headOid: fields[6] ?? null,
        indexOid: fields[7] ?? null,
      });
      continue;
    }
    if (record.startsWith("2 ")) {
      const fields = splitFields(record, 9);
      if (fields.length !== 10) throw new Error("Invalid porcelain v2 rename record");
      const previousPath = records[index + 1];
      if (previousPath === undefined) throw new Error("Rename record has no original path");
      index += 1;
      const xy = parseXy(fields[1]);
      const score = fields[8]?.match(/^[RC](\d{1,3})$/)?.[1];
      entries.push({
        path: assertGitPath(fields[9]!),
        previousPath: assertGitPath(previousPath),
        indexStatus: xy[0],
        worktreeStatus: xy[1],
        conflict: CONFLICT_CODES.has(xy),
        untracked: false,
        ignored: false,
        submodule: isSubmodule(fields[2]),
        renameScore: score ? Math.min(100, Number(score)) : null,
        headOid: fields[6] ?? null,
        indexOid: fields[7] ?? null,
      });
      continue;
    }
    if (record.startsWith("u ")) {
      const fields = splitFields(record, 10);
      if (fields.length !== 11) throw new Error("Invalid porcelain v2 unmerged record");
      const xy = parseXy(fields[1]);
      entries.push({
        path: assertGitPath(fields[10]!),
        previousPath: null,
        indexStatus: xy[0],
        worktreeStatus: xy[1],
        conflict: true,
        untracked: false,
        ignored: false,
        submodule: isSubmodule(fields[2]),
        renameScore: null,
        headOid: fields[7] ?? null,
        indexOid: fields[9] ?? null,
      });
      continue;
    }

    throw new Error(`Unsupported porcelain v2 record: ${record[0] ?? "empty"}`);
  }

  return { branch, entries: entries.filter((entry) => !entry.ignored) };
}

function parseBranchHeader(value: string, branch: ParsedGitBranch): void {
  const separator = value.indexOf(" ");
  const key = separator === -1 ? value : value.slice(0, separator);
  const content = separator === -1 ? "" : value.slice(separator + 1);
  if (key === "branch.oid") branch.oid = content === "(initial)" ? null : content;
  else if (key === "branch.head") branch.head = content === "(detached)" ? null : content;
  else if (key === "branch.upstream") branch.upstream = content || null;
  else if (key === "branch.ab") {
    const match = content.match(/^\+(\d+)\s+-(\d+)$/);
    if (match) {
      branch.ahead = Number(match[1]);
      branch.behind = Number(match[2]);
    }
  }
}

function splitFields(value: string, separatorCount: number): string[] {
  const fields: string[] = [];
  let start = 0;
  for (let index = 0; index < separatorCount; index += 1) {
    const separator = value.indexOf(" ", start);
    if (separator === -1) return [];
    fields.push(value.slice(start, separator));
    start = separator + 1;
  }
  fields.push(value.slice(start));
  return fields;
}

function parseXy(value: string | undefined): string {
  if (!value || !/^[.MADRCUT]{2}$/.test(value)) {
    throw new Error("Invalid porcelain v2 XY status");
  }
  return value;
}

function isSubmodule(value: string | undefined): boolean {
  return Boolean(value && value.length === 4 && value[0] === "S");
}

function assertGitPath(value: string): string {
  if (!value || value.includes("\0")) throw new Error("Invalid Git path");
  return value;
}
