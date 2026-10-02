import { describe, expect, it, vi } from "vitest";

import {
  applyProjectApprovalMode,
  restoreStoredSessionMode,
} from "../../src/main/app-controller";

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

describe("stored session-mode restore", () => {
  const yoloModes = {
    currentModeId: "default",
    availableModes: [
      { id: "default", name: "Default" },
      { id: "yolo", name: "YOLO" },
    ],
  };

  it("re-applies an explicitly chosen mode after create/load", async () => {
    const setMode = vi.fn().mockResolvedValue(undefined);
    await expect(
      restoreStoredSessionMode({
        storedModeId: "yolo",
        modes: yoloModes,
        setMode,
      }),
    ).resolves.toEqual({ restored: true, currentModeId: "yolo" });
    expect(setMode).toHaveBeenCalledExactlyOnceWith("yolo");
  });

  it("does nothing when the provider already runs the stored mode", async () => {
    const setMode = vi.fn().mockResolvedValue(undefined);
    await expect(
      restoreStoredSessionMode({
        storedModeId: "default",
        modes: yoloModes,
        setMode,
      }),
    ).resolves.toEqual({ restored: false, currentModeId: "default" });
    expect(setMode).not.toHaveBeenCalled();
  });

  it("keeps Gemini's default when the stored mode is no longer offered", async () => {
    const setMode = vi.fn().mockResolvedValue(undefined);
    await expect(
      restoreStoredSessionMode({
        storedModeId: "removed-mode",
        modes: yoloModes,
        setMode,
      }),
    ).resolves.toEqual({ restored: false, currentModeId: "default" });
    expect(setMode).not.toHaveBeenCalled();
  });

  it("does nothing for sessions without an explicit mode", async () => {
    const setMode = vi.fn().mockResolvedValue(undefined);
    await expect(
      restoreStoredSessionMode({
        storedModeId: null,
        modes: yoloModes,
        setMode,
      }),
    ).resolves.toEqual({ restored: false, currentModeId: "default" });
    expect(setMode).not.toHaveBeenCalled();
  });
});
