import { describe, expect, it } from "vitest";
import { AppUpdateService, compareSemver } from "../../src/main/updates/app-update-service";

describe("Semver Comparison", () => {
  it("correctly compares versions with or without v prefix", () => {
    expect(compareSemver("v0.5.1", "0.5.0")).toBe(1);
    expect(compareSemver("0.5.0", "v0.5.1")).toBe(-1);
    expect(compareSemver("v0.5.0", "0.5.0")).toBe(0);
    expect(compareSemver("1.0.0", "0.9.9")).toBe(1);
    expect(compareSemver("0.10.0", "0.9.9")).toBe(1);
    expect(compareSemver("0.5.0-beta", "0.5.0")).toBe(0);
  });
});

describe("AppUpdateService", () => {
  it("detects when a newer release is available and extracts exe asset", async () => {
    const mockFetch = async () => {
      return new Response(
        JSON.stringify({
          tag_name: "v0.5.1",
          name: "GeminUI v0.5.1",
          body: "## Neuerungen\n- Auto Update Funktion",
          html_url: "https://github.com/bonbonn1912/gem-ui-ini/releases/tag/v0.5.1",
          published_at: "2026-08-21T12:00:00Z",
          assets: [
            {
              name: "geminui-0.5.1-full.nupkg",
              browser_download_url: "https://github.com/bonbonn1912/gem-ui-ini/releases/download/v0.5.1/geminui-0.5.1-full.nupkg",
            },
            {
              name: "geminUI-0.5.1-windows-x64-Setup.exe",
              browser_download_url: "https://github.com/bonbonn1912/gem-ui-ini/releases/download/v0.5.1/geminUI-0.5.1-windows-x64-Setup.exe",
            },
          ],
        }),
        { status: 200 },
      );
    };

    const service = new AppUpdateService({
      currentVersion: "0.5.0",
      platform: "win32",
      fetchFn: mockFetch as any,
    });

    const info = await service.checkForUpdates();
    expect(info.currentVersion).toBe("0.5.0");
    expect(info.latestVersion).toBe("0.5.1");
    expect(info.updateAvailable).toBe(true);
    expect(info.releaseName).toBe("GeminUI v0.5.1");
    expect(info.downloadUrl).toBe(
      "https://github.com/bonbonn1912/gem-ui-ini/releases/download/v0.5.1/geminUI-0.5.1-windows-x64-Setup.exe",
    );
    expect(info.error).toBeNull();
  });

  it("reports no update when current version is up to date", async () => {
    const mockFetch = async () => {
      return new Response(
        JSON.stringify({
          tag_name: "v0.5.0",
          name: "v0.5.0",
          body: "Initial Release",
          html_url: "https://github.com/bonbonn1912/gem-ui-ini/releases/tag/v0.5.0",
          published_at: "2026-08-21T10:00:00Z",
          assets: [],
        }),
        { status: 200 },
      );
    };

    const service = new AppUpdateService({
      currentVersion: "0.5.0",
      fetchFn: mockFetch as any,
    });

    const info = await service.checkForUpdates();
    expect(info.updateAvailable).toBe(false);
    expect(info.latestVersion).toBe("0.5.0");
    expect(info.error).toBeNull();
  });

  it("handles 404 when no releases are published yet", async () => {
    const mockFetch = async () => new Response("Not Found", { status: 404 });

    const service = new AppUpdateService({
      currentVersion: "0.5.0",
      fetchFn: mockFetch as any,
    });

    const info = await service.checkForUpdates();
    expect(info.updateAvailable).toBe(false);
    expect(info.latestVersion).toBe("0.5.0");
    expect(info.error).toBeNull();
  });

  it("handles network errors gracefully", async () => {
    const mockFetch = async () => {
      throw new Error("DNS resolution failed");
    };

    const service = new AppUpdateService({
      currentVersion: "0.5.0",
      fetchFn: mockFetch as any,
    });

    const info = await service.checkForUpdates();
    expect(info.updateAvailable).toBe(false);
    expect(info.error).toContain("DNS resolution failed");
  });

  it("selects macOS arm64 and x64 assets according to platform and architecture", async () => {
    const assets = [
      {
        name: "geminui-0.5.1-windows-x64-Setup.exe",
        browser_download_url: "https://example.com/windows.exe",
      },
      {
        name: "GeminUI-darwin-arm64-0.5.1.zip",
        browser_download_url: "https://example.com/macos-arm64.zip",
      },
      {
        name: "GeminUI-darwin-x64-0.5.1.zip",
        browser_download_url: "https://example.com/macos-x64.zip",
      },
    ];

    const mockFetch = async () =>
      new Response(
        JSON.stringify({
          tag_name: "v0.5.1",
          assets,
        }),
      );

    // Test macOS Apple Silicon (arm64)
    const macArmService = new AppUpdateService({
      currentVersion: "0.5.0",
      platform: "darwin",
      arch: "arm64",
      fetchFn: mockFetch as any,
    });
    const armInfo = await macArmService.checkForUpdates();
    expect(armInfo.downloadUrl).toBe("https://example.com/macos-arm64.zip");

    // Test macOS Intel (x64)
    const macX64Service = new AppUpdateService({
      currentVersion: "0.5.0",
      platform: "darwin",
      arch: "x64",
      fetchFn: mockFetch as any,
    });
    const x64Info = await macX64Service.checkForUpdates();
    expect(x64Info.downloadUrl).toBe("https://example.com/macos-x64.zip");

    // Test Windows (x64)
    const winService = new AppUpdateService({
      currentVersion: "0.5.0",
      platform: "win32",
      arch: "x64",
      fetchFn: mockFetch as any,
    });
    const winInfo = await winService.checkForUpdates();
    expect(winInfo.downloadUrl).toBe("https://example.com/windows.exe");
  });

  it("downloads update binary with progress reporting", async () => {
    const chunk1 = new Uint8Array([1, 2, 3, 4]);
    const chunk2 = new Uint8Array([5, 6, 7, 8]);
    let readCount = 0;

    const mockStream = new ReadableStream({
      pull(controller) {
        if (readCount === 0) {
          controller.enqueue(chunk1);
          readCount++;
        } else if (readCount === 1) {
          controller.enqueue(chunk2);
          readCount++;
        } else {
          controller.close();
        }
      },
    });

    const mockFetch = async () =>
      new Response(mockStream, {
        status: 200,
        headers: { "content-length": "8" },
      });

    const service = new AppUpdateService({
      currentVersion: "0.5.0",
      fetchFn: mockFetch as any,
    });

    const progressReports: any[] = [];
    const result = await service.downloadUpdate(
      "https://github.com/bonbonn1912/gem-ui-ini/releases/download/v0.5.1/test-update.exe",
      (p) => progressReports.push(p),
    );

    expect(result.filePath).toBeDefined();
    expect(progressReports.length).toBeGreaterThanOrEqual(1);
    expect(progressReports[progressReports.length - 1].percent).toBe(100);
  });
});
