import { expect, test, _electron as electron } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("built app boots with an isolated renderer", async ({}, testInfo) => {
  const userDataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "gem-ui-e2e-"),
  );
  const application = await electron.launch({
    args: [path.resolve("."), `--user-data-dir=${userDataDirectory}`],
  });

  try {
    const page = await application.firstWindow();
    await expect(page).toHaveTitle("GeminUI");
    await expect(page.locator("body")).toContainText("GeminUI");
    await expect(
      page.getByRole("button", { name: /Projekt anlegen|Gemini auswählen/ }).first(),
    ).toBeVisible();

    const isolation = await page.evaluate(() => ({
      hasNodeProcess: typeof (globalThis as { process?: unknown }).process !== "undefined",
      hasRequire: typeof (globalThis as { require?: unknown }).require !== "undefined",
      hasBridge: typeof window.gemUi === "object",
      leaksRawIpc:
        "ipcRenderer" in (window.gemUi as unknown as Record<string, unknown>),
    }));
    expect(isolation).toEqual({
      hasNodeProcess: false,
      hasRequire: false,
      hasBridge: true,
      leaksRawIpc: false,
    });

    await page.screenshot({
      path: testInfo.outputPath("geminui-smoke.png"),
      fullPage: true,
    });
  } finally {
    await application.close();
    await rm(userDataDirectory, { recursive: true, force: true });
  }
});
