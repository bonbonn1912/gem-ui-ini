import { GitLabReviewStateSchema, GitLabDiscussionSchema, GitLabMergeRequestSummarySchema } from "./gitlab.ts";
import { mapGitLabDiscussions } from "./discussion-mapper.ts";

const SHA = "a".repeat(40);
const author = { id: 1, username: "alice", name: "Alice", avatar_url: null };

function rawNote(id, lineRangeType, extra = {}) {
  const start = { line_code: "abc_1_1", old_line: null, new_line: 10 };
  const end = { line_code: "abc_2_2", old_line: null, new_line: 12 };
  if (lineRangeType !== "__missing__") { start.type = lineRangeType; end.type = lineRangeType; }
  return {
    id, type: "DiffNote", body: "hi", author,
    created_at: "2026-08-20T10:00:00Z", updated_at: "2026-08-20T10:00:00Z",
    system: false, resolvable: true, resolved: false, resolved_by: null,
    position: {
      position_type: "text", base_sha: SHA, start_sha: SHA, head_sha: SHA,
      old_path: "src/a.ts", new_path: "src/a.ts", old_line: null, new_line: 12,
      line_range: { start, end },
    },
    ...extra,
  };
}

const cases = [
  ["type=expanded", rawNote(1, "expanded")],
  ["type=null", rawNote(2, null)],
  ["type missing", rawNote(3, "__missing__")],
  ["type=new", rawNote(4, "new")],
  ["type=unknown-future", rawNote(5, "meta")],
  ["unknown note type", rawNote(6, "expanded", { type: "SomeFutureNote" })],
  ["relative avatar", rawNote(7, "old", { author: { ...author, avatar_url: "/uploads/avatar.png" } })],
  ["missing shas", { ...rawNote(8, "expanded"), position: { position_type: "text", old_path: "src/a.ts", new_path: "src/a.ts", old_line: null, new_line: 3 } }],
];

let failed = 0;
for (const [label, note] of cases) {
  const mapped = mapGitLabDiscussions([{ id: "d" + note.id, individual_note: false, notes: [note] }], SHA);
  const res = GitLabDiscussionSchema.safeParse(mapped[0]);
  const side = mapped[0]?.notes[0]?.position?.lineRange?.start;
  console.log(
    (res.success ? "PASS " : "FAIL ") + label.padEnd(22),
    "-> lineRange.start.type=" + JSON.stringify(side?.type),
    "newLine=" + JSON.stringify(side?.newLine),
    "noteType=" + JSON.stringify(mapped[0]?.notes[0]?.type),
    "avatar=" + JSON.stringify(mapped[0]?.notes[0]?.author.avatarUrl),
  );
  if (!res.success) { failed++; console.log(JSON.stringify(res.error.issues, null, 1)); }
}

// MR state tolerance
for (const st of ["opened", "merged", "some_future_state"]) {
  const mr = {
    targetProjectId: 1, targetProjectPath: "g/p", iid: 2, title: "t",
    webUrl: "https://gitlab.example.com/g/p/-/merge_requests/2", state: st, draft: false,
    sourceBranch: "a", targetBranch: "b", sourceProjectId: 1, headSha: SHA, baseSha: SHA, startSha: SHA,
    author: { id: 1, username: "alice", name: "Alice", avatarUrl: null },
    unresolvedCount: 0, updatedAt: "2026-08-20T10:00:00Z",
  };
  const r = GitLabMergeRequestSummarySchema.safeParse(mr);
  console.log((r.success ? "PASS " : "FAIL ") + "mr state=" + st);
  if (!r.success) { failed++; console.log(JSON.stringify(r.error.issues, null, 1)); }
}

// negative control: strict object still rejects junk
const bad = GitLabDiscussionSchema.safeParse({ id: "x", individualNote: false, notes: [], resolvable: false, resolved: false, extra: 1 });
console.log((bad.success ? "FAIL " : "PASS ") + "strictness still enforced");
if (bad.success) failed++;

console.log(failed === 0 ? "\nALL OK" : `\n${failed} FAILURES`);
process.exit(failed === 0 ? 0 : 1);
