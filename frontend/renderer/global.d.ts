import type { GemUiDesktopApi } from "./types";
import type { NativeFileDropOptions } from "./native-file-drop";

declare module "solid-js" {
  namespace JSX {
    interface Directives {
      nativeFileDrop: NativeFileDropOptions;
    }
  }
}

declare global {
  interface Window {
    gemUi: GemUiDesktopApi;
    /** Set by Tauri's IPC runtime. */
    __TAURI_INTERNALS__?: unknown;
  }
}

export {};
