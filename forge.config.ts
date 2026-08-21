import type { ForgeConfig } from "@electron-forge/shared-types";
import { MakerDeb } from "@electron-forge/maker-deb";
import { MakerRpm } from "@electron-forge/maker-rpm";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { AutoUnpackNativesPlugin } from "@electron-forge/plugin-auto-unpack-natives";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { VitePlugin } from "@electron-forge/plugin-vite";
import { FuseV1Options, FuseVersion } from "@electron/fuses";

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    name: "GeminUI",
    appBundleId: "dev.geminui.desktop",
    executableName: "geminui",
    icon: "resources/icons/geminui",
    // macOS protects common project locations (Documents, Desktop, Downloads,
    // network shares and removable media). These strings are embedded in the
    // packaged app so the system can attribute an explicit folder selection to
    // GeminUI and explain the access request to the user.
    extendInfo: {
      NSDocumentsFolderUsageDescription:
        "GeminUI benötigt Zugriff auf ausgewählte Projektordner in Dokumente, damit Gemini CLI Dateien lesen und bearbeiten kann.",
      NSDesktopFolderUsageDescription:
        "GeminUI benötigt Zugriff auf ausgewählte Projektordner auf dem Schreibtisch, damit Gemini CLI Dateien lesen und bearbeiten kann.",
      NSDownloadsFolderUsageDescription:
        "GeminUI benötigt Zugriff auf ausgewählte Projektordner in Downloads, damit Gemini CLI Dateien lesen und bearbeiten kann.",
      NSNetworkVolumesUsageDescription:
        "GeminUI benötigt Zugriff auf ausdrücklich ausgewählte Projektordner auf Netzlaufwerken.",
      NSRemovableVolumesUsageDescription:
        "GeminUI benötigt Zugriff auf ausdrücklich ausgewählte Projektordner auf externen Datenträgern.",
    },
    // The Vite plugin normally copies only `.vite/**` because JavaScript
    // dependencies are bundled. `better-sqlite3` must stay external so its
    // platform-specific `.node` binary can be loaded at runtime, therefore its
    // package has to be copied explicitly. Keep the directory ancestors so the
    // packager still descends into the selected module.
    ignore: (file) => {
      if (!file) return false;
      return !(
        file === "/.vite" ||
        file.startsWith("/.vite/") ||
        file === "/node_modules" ||
        file === "/node_modules/better-sqlite3" ||
        file.startsWith("/node_modules/better-sqlite3/")
      );
    },
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({
      name: "geminui",
      setupIcon: "resources/icons/geminui.ico",
    }),
    new MakerZIP({}, ["darwin"]),
    new MakerDeb({}),
    new MakerRpm({}),
  ],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      build: [
        {
          entry: "src/main/index.ts",
          config: "vite.main.config.ts",
          target: "main",
        },
        {
          entry: "src/preload/index.ts",
          config: "vite.preload.config.ts",
          target: "preload",
        },
        {
          entry: "src/main/context-attachments/extraction-worker.ts",
          config: "vite.worker.config.ts",
          target: "main",
        },
      ],
      renderer: [
        {
          name: "main_window",
          config: "vite.renderer.config.ts",
        },
      ],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
