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
  #refreshPromise: Promise<AppCapabilities> | null = null;

  constructor(settings: SettingsRepository, appVersion: string) {
    this.#settings = settings;
    this.#appVersion = appVersion;
  }

  refresh(candidate?: string, gitCandidate?: string): Promise<AppCapabilities> {
    if (this.#refreshPromise) return this.#refreshPromise;
    this.#refreshPromise = this.#refresh(candidate, gitCandidate).finally(() => {
      this.#refreshPromise = null;
    });
    return this.#refreshPromise;
  }

  async choose(candidate: string): Promise<AppCapabilities> {
    const capabilities = await this.refresh(candidate);
    if (!this.#probe?.ok) {
      throw new Error(this.#probe?.message ?? "Gemini CLI ist nicht kompatibel.");
    }
    this.#settings.setGeminiBinaryPath(this.#probe.binaryPath);
    return capabilities;
  }

  async chooseGit(candidate: string): Promise<AppCapabilities> {
    const capabilities = await this.refresh(undefined, candidate);
    if (!this.#gitProbe?.ok) {
      throw new Error(
        this.#gitProbe?.message ?? "Die ausgewählte Git-Binary ist nicht kompatibel.",
      );
    }
    this.#settings.setGitBinaryPath(this.#gitProbe.binaryPath);
    return capabilities;
  }

  snapshot(): AppCapabilities {
    return toCapabilities(this.#probe, this.#gitProbe, this.#appVersion);
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
  } {
    if (!this.#probe?.ok) {
      this.requireBinaryPath();
      throw new Error("Gemini CLI wurde nicht gefunden.");
    }
    return {
      binaryPath: this.#probe.executablePath,
      binaryArgs: this.#probe.executableArgs,
    };
  }

  get probe(): GeminiBinaryProbeResult | null {
    return this.#probe;
  }

  get gitBinaryPath(): string | null {
    return this.#gitProbe?.ok ? this.#gitProbe.binaryPath : null;
  }

  async #refresh(candidate?: string, gitCandidate?: string): Promise<AppCapabilities> {
    const configured = this.#settings.getGeminiSettings()?.binaryPath;
    const configuredGit = this.#settings.getGitSettings()?.binaryPath;
    const [geminiProbe, gitProbe] = await Promise.all([
      probeGeminiBinary({
        candidate: candidate ?? configured ?? "gemini",
      }),
      probeGitBinary({ candidate: gitCandidate ?? configuredGit ?? undefined }),
    ]);
    this.#probe = geminiProbe;
    this.#gitProbe = gitProbe;
    return this.snapshot();
  }
}

function toCapabilities(
  probe: GeminiBinaryProbeResult | null,
  gitProbe: GitBinaryProbeResult | null,
  appVersion: string,
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
      binaryPath: available ? probe.binaryPath : null,
      version: available ? probe.version : null,
      acp: available && probe.features.acp,
      sessionLoad: available && probe.features.resume,
      images: available && probe.features.acp,
      modes: available && probe.features.approvalMode,
      // The concrete choices are negotiated per ACP session via configOptions.
      models: available && probe.features.acp,
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
