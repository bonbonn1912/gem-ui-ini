import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { onCleanup } from "solid-js";

export type NativeFileDropOptions = {
  disabled?: boolean;
  onActiveChange?: (active: boolean) => void;
  onDrop: (files: File[]) => void;
};

type DropZone = {
  element: HTMLElement;
  options: () => NativeFileDropOptions;
};

const zones = new Set<DropZone>();
let activeZone: DropZone | null = null;
let scaleFactor = 1;
let listenerStarted = false;

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);
}

function displayName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) || "Datei";
}

export function pathBackedFiles(paths: readonly string[]): File[] {
  return paths.map((path) => {
    const name = displayName(path);
    const extension = name.includes(".") ? name.split(".").at(-1)?.toLowerCase() ?? "" : "";
    const file = new File([], name, { type: MIME_BY_EXTENSION[extension] ?? "" });
    Object.defineProperty(file, "path", {
      configurable: false,
      enumerable: false,
      value: path,
      writable: false,
    });
    return file;
  });
}

function setActive(next: DropZone | null): void {
  if (activeZone === next) return;
  activeZone?.options().onActiveChange?.(false);
  activeZone = next;
  activeZone?.options().onActiveChange?.(true);
}

function zoneAtPhysicalPosition(position: { x: number; y: number }): DropZone | null {
  const target = document.elementFromPoint(position.x / scaleFactor, position.y / scaleFactor);
  if (!(target instanceof Element)) return null;

  // Walk outwards so a Todo or an attachment group wins over the composer or
  // panel that contains it.
  for (let element: Element | null = target; element; element = element.parentElement) {
    for (const zone of zones) {
      if (zone.element === element && !zone.options().disabled) return zone;
    }
  }
  return null;
}

function startListener(): void {
  if (listenerStarted || !isTauriRuntime()) return;
  listenerStarted = true;

  void getCurrentWindow().scaleFactor().then((value) => {
    if (Number.isFinite(value) && value > 0) scaleFactor = value;
  });
  void getCurrentWebview().onDragDropEvent((event) => {
    const payload = event.payload;
    if (payload.type === "leave") {
      setActive(null);
      return;
    }
    const target = zoneAtPhysicalPosition(payload.position);
    if (payload.type === "enter" || payload.type === "over") {
      setActive(target);
      return;
    }
    if (payload.type === "drop") {
      setActive(null);
      if (target && payload.paths.length > 0) {
        target.options().onDrop(pathBackedFiles(payload.paths));
      }
    }
  }).catch((error) => {
    listenerStarted = false;
    console.error("Native file-drop listener could not be started", error);
  });
}

/** Solid directive used as `use:nativeFileDrop={options}`. */
export function nativeFileDrop(
  element: HTMLElement,
  options: () => NativeFileDropOptions,
): void {
  const zone = { element, options };
  zones.add(zone);
  startListener();
  onCleanup(() => {
    if (activeZone === zone) setActive(null);
    zones.delete(zone);
  });
}

