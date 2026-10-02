import type { AppCapabilities } from "../shared/contracts";
import {
  probeGeminiBinary,
  type GeminiBinaryProbeResult,
} from "./gemini";
import { probeGitBinary, type GitBinaryProbeResult } from "./git";
import type { SettingsRepository } from "./storage";

export class GeminiCapabilityService {
  readonly #settings: SettingsRepository;
  readonly #appVersion: string;
  #probe: GeminiBinaryProbeResult | null = null;
  #gitProbe: GitBinaryProbeResult | null = null;
  readonly #geminiRequests = new Map<string, Promise<GeminiBinaryProbeResult>>();
  readonly #gitRequests = new Map<string, Promise<GitBinaryProbeResult>>();
  #geminiGeneration = 0;
  #gitGeneration = 0;
  #checking = true;

  constructor(settings: SettingsRepository, appVersion: string) {
    this.#settings = settings;
    this.#appVersion = appVersion;
  }

  async refresh(candidate?: string, gitCandidate?: string): Promise<AppCapabilities> {
    await Promise.all([this.#refreshGemini(candidate), this.#refreshGit(gitCandidate)]);
    return this.snapshot();
  }

  async choose(candidate: string): Promise<AppCapabilities> {
    await this.#refreshGemini(candidate, true);
    return this.snapshot();
  }

  async chooseGit(candidate: string): Promise<AppCapabilities> {
    await this.#refreshGit(candidate, true);
    return this.snapshot();
  }

  getResourceProfile(): { profile: "economy" | "balanced" | "performance" } {
    const value = this.#settings.get("resources.profile")?.value;
    return { profile: value === "economy" || value === "performance" ? value : "balanced" };
  }

  setResourceProfile(profile: "economy" | "balanced" | "performance") {
    this.#settings.set("resources.profile", profile);
    return { profile };
  }

  snapshot(): AppCapabilities {
    return toCapabilities(this.#probe, this.#gitProbe, this.#appVersion, this.#checking);
  }

  requireBinaryPath(): string {
    if (!this.#probe?.ok) {
      throw new Error(
        this.#probe?.message ??
          "Gemini CLI wurde nicht gefunden. Bitte wähle die Gemini-Binary aus.",
      );
    }
    return this.#probe.binaryPath;
  }

  requireLaunchCommand(): {
    readonly binaryPath: string;
    readonly binaryArgs: readonly string[];
    readonly acpFlag: "--acp" | "--experimental-acp";
  } {
    if (!this.#probe?.ok) {
      this.requireBinaryPath();
      throw new Error("Gemini CLI wurde nicht gefunden.");
    }
    return {
      binaryPath: this.#probe.executablePath,
      binaryArgs: this.#probe.executableArgs,
      acpFlag: this.#probe.features.acpFlag ?? "--acp",
    };
  }

  get probe(): GeminiBinaryProbeResult | null {
    return this.#probe;
  }

  get gitBinaryPath(): string | null {
    return this.#gitProbe?.ok ? this.#gitProbe.binaryPath : null;
  }

  requireGitBinaryPath(): string {
    if (!this.#gitProbe?.ok) {
      throw new Error(
        this.#gitProbe?.message ?? "Git wurde nicht gefunden. Bitte wähle die Git-Binary aus.",
      );
    }
    return this.#gitProbe.binaryPath;
  }

  async #refreshGemini(candidate?: string, persist = false): Promise<void> {
    const key = candidate ?? this.#settings.getGeminiSettings()?.binaryPath ?? "gemini";
    const generation = ++this.#geminiGeneration;
    this.#checking = true;
    let request = this.#geminiRequests.get(key);
    if (!request) {
      request = probeGeminiBinary({ candidate: key, timeoutMs: 30_000, force: persist });
      this.#geminiRequests.set(key, request);
      const pending = request;
      void pending.finally(() => {
        if (this.#geminiRequests.get(key) === pending) this.#geminiRequests.delete(key);
      }).catch(() => undefined);
    }
    try {
      const result = await request;
      if (generation !== this.#geminiGeneration) return;
      this.#probe = result;
      if (persist) {
        if (!result.ok) throw new Error(result.message);
        this.#settings.setGeminiBinaryPath(result.binaryPath);
      }
    } finally {
      if (generation === this.#geminiGeneration) this.#checking = false;
    }
  }

  async #refreshGit(candidate?: string, persist = false): Promise<void> {
    const key = candidate ?? this.#settings.getGitSettings()?.binaryPath ?? "git";
    const generation = ++this.#gitGeneration;
    let request = this.#gitRequests.get(key);
    if (!request) {
      request = probeGitBinary({ candidate: key });
      this.#gitRequests.set(key, request);
      const pending = request;
      void pending.finally(() => {
        if (this.#gitRequests.get(key) === pending) this.#gitRequests.delete(key);
      }).catch(() => undefined);
    }
    const result = await request;
    if (generation !== this.#gitGeneration) return;
    this.#gitProbe = result;
    if (persist) {
      if (!result.ok) throw new Error(result.message);
      this.#settings.setGitBinaryPath(result.binaryPath);
    }
  }
}

function toCapabilities(
  probe: GeminiBinaryProbeResult | null,
  gitProbe: GitBinaryProbeResult | null,
  appVersion: string,
  checking: boolean,
): AppCapabilities {
  const supportedPlatform =
    process.platform === "darwin" ||
    process.platform === "linux" ||
    process.platform === "win32"
      ? process.platform
      : "linux";
  const available = probe?.ok === true;

  const gitAvailable = gitProbe?.ok === true;
  return {
    appVersion,
    platform: supportedPlatform,
    gemini: {
      available,
      probeState: checking ? "checking" : available ? "ready" : "unavailable",
      negotiated: false,
      binaryPath: available ? probe.binaryPath : null,
      version: available ? probe.version : null,
      acp: available && probe.features.acp,
      sessionLoad: false,
      images: false,
      modes: false,
      // The concrete choices are negotiated per ACP session via configOptions.
      models: false,
      maxAdditionalRoots:
        available && probe.features.includeDirectories ? 5 : 0,
    },
    git: {
      available: gitAvailable,
      binaryPath: gitAvailable ? gitProbe.binaryPath : null,
      version: gitAvailable ? gitProbe.version : null,
    },
  };
}
