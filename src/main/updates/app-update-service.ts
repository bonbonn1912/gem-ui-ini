import { app, shell } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { AppUpdateDownloadProgress, AppUpdateInfo } from "../../shared/contracts";

export function compareSemver(v1: string, v2: string): number {
  const clean = (v: string) =>
    v.replace(/^[vV]/, "").trim().split(/[-+]/)[0]!.split(".").map((n) => parseInt(n, 10) || 0);

  const parts1 = clean(v1);
  const parts2 = clean(v2);
  const maxLen = Math.max(parts1.length, parts2.length);

  for (let i = 0; i < maxLen; i++) {
    const p1 = parts1[i] ?? 0;
    const p2 = parts2[i] ?? 0;
    if (p1 > p2) return 1;
    if (p1 < p2) return -1;
  }
  return 0;
}

export function selectBestReleaseAsset(
  assets: Array<{ name: string; browser_download_url: string }> | undefined,
  platform: string = process.platform,
  arch: string = process.arch,
): string | null {
  if (!assets || assets.length === 0) return null;

  if (platform === "win32") {
    // Windows: prefer Setup.exe or any .exe
    const setupExe = assets.find(
      (a) => a.name.toLowerCase().includes("setup") && a.name.toLowerCase().endsWith(".exe"),
    );
    if (setupExe) return setupExe.browser_download_url;

    const anyExe = assets.find((a) => a.name.toLowerCase().endsWith(".exe"));
    if (anyExe) return anyExe.browser_download_url;
  } else if (platform === "darwin") {
    // macOS: prefer .dmg or .zip matching CPU architecture (arm64 for Apple Silicon, x64 for Intel)
    const isArm = arch === "arm64";
    const primaryArch = isArm ? "arm64" : "x64";
    const secondaryArch = isArm ? "aarch64" : "x86_64";

    // 1. DMG matching architecture
    const archDmg = assets.find(
      (a) =>
        a.name.toLowerCase().endsWith(".dmg") &&
        (a.name.toLowerCase().includes(primaryArch) || a.name.toLowerCase().includes(secondaryArch)),
    );
    if (archDmg) return archDmg.browser_download_url;

    // 2. ZIP matching architecture
    const archZip = assets.find(
      (a) =>
        a.name.toLowerCase().endsWith(".zip") &&
        (a.name.toLowerCase().includes(primaryArch) || a.name.toLowerCase().includes(secondaryArch)),
    );
    if (archZip) return archZip.browser_download_url;

    // 3. Any DMG
    const anyDmg = assets.find((a) => a.name.toLowerCase().endsWith(".dmg"));
    if (anyDmg) return anyDmg.browser_download_url;

    // 4. Any macOS zip
    const macZip = assets.find(
      (a) =>
        a.name.toLowerCase().endsWith(".zip") &&
        (a.name.toLowerCase().includes("darwin") || a.name.toLowerCase().includes("mac")),
    );
    if (macZip) return macZip.browser_download_url;
  } else if (platform === "linux") {
    const deb = assets.find((a) => a.name.toLowerCase().endsWith(".deb"));
    if (deb) return deb.browser_download_url;
    const appImage = assets.find((a) => a.name.toLowerCase().endsWith(".appimage"));
    if (appImage) return appImage.browser_download_url;
    const rpm = assets.find((a) => a.name.toLowerCase().endsWith(".rpm"));
    if (rpm) return rpm.browser_download_url;
  }

  // Fallback: first asset or null
  return assets[0]?.browser_download_url ?? null;
}

export type AppUpdateServiceOptions = {
  repositoryOwner?: string;
  repositoryName?: string;
  currentVersion?: string;
  platform?: string;
  arch?: string;
  fetchFn?: typeof fetch;
};

export class AppUpdateService {
  readonly #owner: string;
  readonly #repo: string;
  readonly #currentVersion: string;
  readonly #platform: string;
  readonly #arch: string;
  readonly #fetch: typeof fetch;

  constructor(options?: AppUpdateServiceOptions) {
    this.#owner = options?.repositoryOwner ?? "bonbonn1912";
    this.#repo = options?.repositoryName ?? "gem-ui-ini";
    this.#currentVersion = options?.currentVersion ?? (app?.getVersion ? app.getVersion() : "0.5.0");
    this.#platform = options?.platform ?? process.platform;
    this.#arch = options?.arch ?? process.arch;
    this.#fetch = options?.fetchFn ?? fetch;
  }

  async checkForUpdates(): Promise<AppUpdateInfo> {
    const currentVersion = this.#currentVersion;
    const url = `https://api.github.com/repos/${this.#owner}/${this.#repo}/releases/latest`;

    try {
      const response = await this.#fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "GeminUI-Desktop-App",
        },
        signal: AbortSignal.timeout(10000),
      });

      if (response.status === 404) {
        // No releases published yet
        return {
          currentVersion,
          latestVersion: currentVersion,
          updateAvailable: false,
          releaseName: null,
          releaseNotes: null,
          publishedAt: null,
          htmlUrl: null,
          downloadUrl: null,
          error: null,
        };
      }

      if (!response.ok) {
        let errorMsg = `GitHub API Fehler (${response.status})`;
        if (response.status === 403) {
          errorMsg = "GitHub API Rate Limit erreicht. Bitte später erneut versuchen.";
        }
        return {
          currentVersion,
          latestVersion: null,
          updateAvailable: false,
          error: errorMsg,
        };
      }

      const release = (await response.json()) as {
        tag_name?: string;
        name?: string;
        body?: string;
        html_url?: string;
        published_at?: string;
        assets?: Array<{
          name: string;
          browser_download_url: string;
        }>;
      };

      const rawTag = release.tag_name || "";
      const cleanLatest = rawTag.replace(/^[vV]/, "").trim();

      if (!cleanLatest) {
        return {
          currentVersion,
          latestVersion: null,
          updateAvailable: false,
          error: "Keine gültige Versionsnummer im neuesten Release gefunden.",
        };
      }

      const isNewer = compareSemver(cleanLatest, currentVersion) > 0;
      const downloadUrl = selectBestReleaseAsset(release.assets, this.#platform, this.#arch) ?? release.html_url ?? null;

      return {
        currentVersion,
        latestVersion: cleanLatest,
        updateAvailable: isNewer,
        releaseName: release.name || rawTag || `Version ${cleanLatest}`,
        releaseNotes: release.body ? release.body.slice(0, 4000) : null,
        publishedAt: release.published_at ? new Date(release.published_at).toISOString() : null,
        htmlUrl: release.html_url ?? null,
        downloadUrl,
        error: null,
      };
    } catch (err: unknown) {
      return {
        currentVersion,
        latestVersion: null,
        updateAvailable: false,
        error: (err as Error).message || "Verbindung zu GitHub fehlgeschlagen.",
      };
    }
  }

  async downloadUpdate(
    downloadUrl: string,
    onProgress?: (progress: AppUpdateDownloadProgress) => void,
    signal?: AbortSignal,
  ): Promise<{ filePath: string }> {
    const parsed = new URL(downloadUrl);
    if (parsed.protocol !== "https:") {
      throw new Error("Updates können nur über sichere HTTPS-Verbindungen heruntergeladen werden.");
    }

    const rawFileName = path.basename(parsed.pathname) || "geminui-update.exe";
    const tempDir = app?.getPath ? app.getPath("temp") : os.tmpdir();
    const destinationPath = path.join(tempDir, `geminui-update-${Date.now()}-${rawFileName}`);

    const response = await this.#fetch(downloadUrl, {
      method: "GET",
      headers: {
        "User-Agent": "GeminUI-Desktop-App",
      },
      signal,
    });

    if (!response.ok || !response.body) {
      throw new Error(`Download fehlgeschlagen mit Status ${response.status}: ${response.statusText}`);
    }

    const contentLengthHeader = response.headers.get("content-length");
    const totalBytes = contentLengthHeader ? parseInt(contentLengthHeader, 10) : 0;
    let receivedBytes = 0;

    const fileStream = fs.createWriteStream(destinationPath);
    const reader = response.body.getReader();

    try {
      while (true) {
        if (signal?.aborted) {
          throw new Error("Download abgebrochen.");
        }
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          receivedBytes += value.length;
          fileStream.write(Buffer.from(value));
          if (onProgress) {
            const percent = totalBytes > 0 ? Math.min(100, Math.round((receivedBytes / totalBytes) * 100)) : 0;
            onProgress({
              receivedBytes,
              totalBytes: totalBytes > 0 ? totalBytes : receivedBytes,
              percent,
            });
          }
        }
      }
      await new Promise<void>((resolve, reject) => {
        fileStream.end((err: Error | null | undefined) => {
          if (err) reject(err);
          else resolve();
        });
      });
    } catch (err) {
      fileStream.close();
      try {
        if (fs.existsSync(destinationPath)) {
          fs.unlinkSync(destinationPath);
        }
      } catch {
        // ignore
      }
      throw err;
    }

    return { filePath: destinationPath };
  }

  async installUpdate(filePath: string): Promise<void> {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Installationsdatei nicht gefunden: ${filePath}`);
    }

    if (this.#platform === "win32") {
      const child = spawn(filePath, ["--updated"], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      if (app?.quit) {
        setTimeout(() => {
          app.quit();
        }, 300);
      }
    } else if (this.#platform === "darwin") {
      await shell.openPath(filePath);
      if (app?.quit) {
        setTimeout(() => {
          app.quit();
        }, 500);
      }
    } else {
      await shell.openPath(filePath);
      if (app?.quit) {
        setTimeout(() => {
          app.quit();
        }, 500);
      }
    }
  }
}
