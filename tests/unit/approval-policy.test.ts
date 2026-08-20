import { describe, expect, it, vi } from "vitest";

import { applyProjectApprovalMode } from "../../src/main/app-controller";

const modes = {
  currentModeId: "default",
  availableModes: [
    { id: "default", name: "Default" },
    { id: "runtime-offered", name: "Runtime offered" },
  ],
};

describe("project approval-mode application", () => {
  it("applies a persisted mode automatically only when ACP advertised it", async () => {
    const setMode = vi.fn().mockResolvedValue(undefined);
    await expect(
      applyProjectApprovalMode({
        requestedModeId: "runtime-offered",
        modes,
        setMode,
      }),
    ).resolves.toEqual({
      currentModeId: "runtime-offered",
      state: "available",
    });
    expect(setMode).toHaveBeenCalledExactlyOnceWith("runtime-offered");
  });

  it("keeps Gemini's reported default and marks an unavailable stored id", async () => {
    const setMode = vi.fn().mockResolvedValue(undefined);
    await expect(
      applyProjectApprovalMode({
        requestedModeId: "stale-or-removed",
        modes,
        setMode,
      }),
    ).resolves.toEqual({
      currentModeId: "default",
      state: "unavailable",
    });
    expect(setMode).not.toHaveBeenCalled();
  });

  it("does not invent a mode when ACP exposes no modes", async () => {
    const setMode = vi.fn().mockResolvedValue(undefined);
    await expect(
      applyProjectApprovalMode({
        requestedModeId: "anything",
        modes: undefined,
        setMode,
      }),
    ).resolves.toEqual({
      currentModeId: null,
      state: "unavailable",
    });
    expect(setMode).not.toHaveBeenCalled();
  });
});
