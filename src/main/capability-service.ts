import type { AppCapabilities } from "../shared/contracts";
import {
  probeGeminiBinary,
  type GeminiBinaryProbeResult,
} from "./gemini";
import type { SettingsRepository } from "./storage";

export class GeminiCapabilityService {
  readonly #settings: SettingsRepository;
  readonly #appVersion: string;
  #probe: GeminiBinaryProbeResult | null = null;
  #refreshPromise: Promise<AppCapabilities> | null = null;

  constructor(settings: SettingsRepository, appVersion: string) {
    this.#settings = settings;
    this.#appVersion = appVersion;
  }

  refresh(candidate?: string): Promise<AppCapabilities> {
    if (this.#refreshPromise) return this.#refreshPromise;
    this.#refreshPromise = this.#refresh(candidate).finally(() => {
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

  snapshot(): AppCapabilities {
    return toCapabilities(this.#probe, this.#appVersion);
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

  async #refresh(candidate?: string): Promise<AppCapabilities> {
    const configured = this.#settings.getGeminiSettings()?.binaryPath;
    this.#probe = await probeGeminiBinary({
      candidate: candidate ?? configured ?? "gemini",
    });
    return this.snapshot();
  }
}

function toCapabilities(
  probe: GeminiBinaryProbeResult | null,
  appVersion: string,
): AppCapabilities {
  const supportedPlatform =
    process.platform === "darwin" ||
    process.platform === "linux" ||
    process.platform === "win32"
      ? process.platform
      : "linux";
  const available = probe?.ok === true;

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
  };
}
