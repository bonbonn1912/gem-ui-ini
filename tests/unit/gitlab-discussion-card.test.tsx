// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitLabDiscussionCard } from "../../src/renderer/features/gitlab/GitLabDiscussionCard";
import type { GitLabDiscussion, GitLabMergeRequestSummary } from "../../src/renderer/types";

describe("GitLabDiscussionCard branch awareness", () => {
  afterEach(() => {
    cleanup();
  });

  const mockMergeRequest: GitLabMergeRequestSummary = {
    targetProjectId: 123,
    targetProjectPath: "group/repo",
    iid: 42,
    title: "Fix login button styling",
    webUrl: "https://gitlab.com/group/repo/-/merge_requests/42",
    state: "opened",
    draft: false,
    sourceBranch: "feature/login-fix",
    targetBranch: "main",
    sourceProjectId: 123,
    headSha: "a".repeat(40),
    baseSha: "b".repeat(40),
    startSha: "c".repeat(40),
    author: { id: 1, username: "alice", name: "Alice" },
    unresolvedCount: 1,
    updatedAt: "2026-08-24T10:00:00.000Z",
  };

  const mockDiscussion: GitLabDiscussion = {
    id: "disc-123",
    individualNote: false,
    resolvable: true,
    resolved: false,
    repliable: true,
    notes: [
      {
        id: 1,
        type: "DiffNote",
        body: "Bitte hier den Randabstand anpassen.",
        author: { id: 2, username: "bob", name: "Bob" },
        system: false,
        resolvable: true,
        resolved: false,
        resolvedBy: null,
        createdAt: "2026-08-24T10:05:00.000Z",
        updatedAt: "2026-08-24T10:05:00.000Z",
        position: {
          positionType: "text",
          baseSha: "b".repeat(40),
          startSha: "c".repeat(40),
          headSha: "a".repeat(40),
          oldPath: "src/button.css",
          newPath: "src/button.css",
          oldLine: null,
          newLine: 15,
          lineRange: null,
          outdated: false,
        },
      },
    ],
  };

  it("enables send buttons when current branch matches MR source branch", async () => {
    const onSendToGemini = vi.fn().mockResolvedValue(undefined);

    render(
      <GitLabDiscussionCard
        discussion={mockDiscussion}
        mergeRequest={mockMergeRequest}
        isReadOnly={false}
        currentBranch="feature/login-fix"
        delivery="send"
        onSendToGemini={onSendToGemini}
        onResolve={vi.fn()}
        onReply={vi.fn()}
        onOpenExternal={vi.fn()}
      />,
    );

    const affectedLinesBtn = screen.getByRole("button", { name: /Betroffene Zeilen an Gemini/i });
    const wholeFileBtn = screen.getByRole("button", { name: /Ganze Datei an Gemini/i });

    expect(affectedLinesBtn).not.toBeDisabled();
    expect(wholeFileBtn).not.toBeDisabled();
    expect(affectedLinesBtn).toHaveAttribute(
      "title",
      "Betroffene Zeilen dieses Threads sofort als Prompt an Gemini senden",
    );
    expect(wholeFileBtn).toHaveAttribute(
      "title",
      "Vollständige Datei am Review-Stand sofort als Prompt an Gemini senden",
    );

    fireEvent.click(affectedLinesBtn);
    expect(onSendToGemini).toHaveBeenCalledWith("disc-123", "affected_lines");
  });

  it("matches branches case-insensitively and trimmed", () => {
    render(
      <GitLabDiscussionCard
        discussion={mockDiscussion}
        mergeRequest={mockMergeRequest}
        isReadOnly={false}
        currentBranch="  FEATURE/LOGIN-FIX  "
        delivery="draft"
        onSendToGemini={vi.fn()}
        onResolve={vi.fn()}
        onReply={vi.fn()}
        onOpenExternal={vi.fn()}
      />,
    );

    const affectedLinesBtn = screen.getByRole("button", { name: /Betroffene Zeilen in den Entwurf/i });
    expect(affectedLinesBtn).not.toBeDisabled();
    expect(affectedLinesBtn).toHaveAttribute(
      "title",
      "Betroffene Zeilen dieses Threads in das Eingabefeld übernehmen",
    );
  });

  it("disables send buttons and explains on hover when on a different branch", () => {
    const onSendToGemini = vi.fn();

    render(
      <GitLabDiscussionCard
        discussion={mockDiscussion}
        mergeRequest={mockMergeRequest}
        isReadOnly={false}
        currentBranch="main"
        delivery="send"
        onSendToGemini={onSendToGemini}
        onResolve={vi.fn()}
        onReply={vi.fn()}
        onOpenExternal={vi.fn()}
      />,
    );

    const affectedLinesBtn = screen.getByRole("button", { name: /Betroffene Zeilen an Gemini/i });
    const wholeFileBtn = screen.getByRole("button", { name: /Ganze Datei an Gemini/i });

    expect(affectedLinesBtn).toBeDisabled();
    expect(wholeFileBtn).toBeDisabled();

    const expectedExplanation =
      "Nur verfügbar auf dem Branch »feature/login-fix« (aktueller Branch: »main«)";
    expect(affectedLinesBtn).toHaveAttribute("title", expectedExplanation);
    expect(wholeFileBtn).toHaveAttribute("title", expectedExplanation);

    fireEvent.click(affectedLinesBtn);
    expect(onSendToGemini).not.toHaveBeenCalled();
  });

  it("disables send buttons and explains on hover when no branch is checked out", () => {
    const onSendToGemini = vi.fn();

    render(
      <GitLabDiscussionCard
        discussion={mockDiscussion}
        mergeRequest={mockMergeRequest}
        isReadOnly={false}
        currentBranch={null}
        delivery="send"
        onSendToGemini={onSendToGemini}
        onResolve={vi.fn()}
        onReply={vi.fn()}
        onOpenExternal={vi.fn()}
      />,
    );

    const affectedLinesBtn = screen.getByRole("button", { name: /Betroffene Zeilen an Gemini/i });
    const wholeFileBtn = screen.getByRole("button", { name: /Ganze Datei an Gemini/i });

    expect(affectedLinesBtn).toBeDisabled();
    expect(wholeFileBtn).toBeDisabled();

    const expectedExplanation =
      "Nur verfügbar auf dem Branch »feature/login-fix« (kein passender lokaler Branch ausgecheckt)";
    expect(affectedLinesBtn).toHaveAttribute("title", expectedExplanation);
    expect(wholeFileBtn).toHaveAttribute("title", expectedExplanation);

    fireEvent.click(affectedLinesBtn);
    expect(onSendToGemini).not.toHaveBeenCalled();
  });
});
