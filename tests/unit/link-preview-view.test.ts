import { afterEach, describe, expect, it, vi } from "vitest";

type MockPreviewView = {
  loadURL: ReturnType<typeof vi.fn>;
  setBounds: ReturnType<typeof vi.fn>;
  webContents: {
    close: ReturnType<typeof vi.fn>;
    isDestroyed: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    setWindowOpenHandler: ReturnType<typeof vi.fn>;
    loadURL: ReturnType<typeof vi.fn>;
  };
};
const views = vi.hoisted(() => [] as MockPreviewView[]);
const loadState = vi.hoisted(() => ({ next: undefined as ((url: string) => Promise<void>) | undefined }));

vi.mock("electron", () => ({
  WebContentsView: class {
    setBounds = vi.fn();
    webContents = {
      close: vi.fn(),
      isDestroyed: vi.fn(() => false),
      on: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      loadURL: vi.fn((url: string) => loadState.next?.(url) ?? Promise.resolve()),
    };
    constructor() { views.push(this as never); }
  },
}));
vi.mock("../../src/main/security/main-window", () => ({ openExternalHttps: vi.fn() }));

import { LinkPreviewViewHost } from "../../src/main/links/link-preview-view";

afterEach(() => { views.length = 0; loadState.next = undefined; });

function createHost() {
  const children = new Set<object>();
  const mainWindow = {
    contentView: {
      addChildView: (view: object) => children.add(view),
      removeChildView: (view: object) => children.delete(view),
    },
    on: vi.fn(),
    removeListener: vi.fn(),
  };
  const session = { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(), on: vi.fn(), removeListener: vi.fn() };
  const attachments = { getLinkPreviewTarget: vi.fn() };
  return {
    host: new LinkPreviewViewHost(mainWindow as never, attachments as never, session as never),
    children,
  };
}

describe("LinkPreviewViewHost resource lifecycle", () => {
  it("closes WebContents when closing the preview", async () => {
    const { host, children } = createHost();
    const opened = host.open({ url: "https://example.com" });
    await vi.waitFor(() => expect(views).toHaveLength(1));
    views[0]!.webContents.loadURL.mockResolvedValue(undefined);
    await opened;
    host.close();
    expect(children.size).toBe(0);
    expect(views[0]!.webContents.close).toHaveBeenCalledOnce();
  });

  it("does not let a stale load failure close the newer preview", async () => {
    const { host, children } = createHost();
    let rejectFirst!: (error: Error) => void;
    loadState.next = (url) => url.includes("first")
      ? new Promise((_resolve, reject) => { rejectFirst = reject; })
      : Promise.resolve();
    const first = host.open({ url: "https://first.example" });
    await vi.waitFor(() => expect(views).toHaveLength(1));
    const second = host.open({ url: "https://second.example" });
    await vi.waitFor(() => expect(views).toHaveLength(2));
    await second;
    rejectFirst(new Error("first failed"));
    await expect(first).rejects.toThrow("first failed");
    expect(children.size).toBe(1);
    expect(views[1]!.webContents.close).not.toHaveBeenCalled();
  });
});
