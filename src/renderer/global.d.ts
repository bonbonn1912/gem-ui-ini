import type { GemUiDesktopApi } from "./types";

declare global {
  interface Window {
    gemUi: GemUiDesktopApi;
  }
}

export {};

