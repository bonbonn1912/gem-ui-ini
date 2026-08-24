import { vi } from "vitest";

const validPngBuffer = Buffer.from([
  137, 80, 78, 71, 13, 10, 26, 10, // signature
  0, 0, 0, 13, 73, 72, 68, 82, // IHDR header
  0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, // data
  31, 21, 196, 137, // CRC
  0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130, // IEND
]);

vi.mock("electron", () => {
  class MockBrowserWindow {
    static getFocusedWindow = vi.fn().mockReturnValue(null);
    loadURL = vi.fn().mockResolvedValue(undefined);
    destroy = vi.fn();
    isDestroyed = vi.fn().mockReturnValue(false);
    setContentSize = vi.fn();
    setBounds = vi.fn();
    on = vi.fn();
    removeListener = vi.fn();
    contentView = {
      addChildView: vi.fn(),
      removeChildView: vi.fn(),
    };
    webContents = {
      printToPDF: vi.fn().mockResolvedValue(Buffer.from("%PDF-1.4 test")),
      capturePage: vi.fn().mockResolvedValue({
        toPNG: vi.fn().mockReturnValue(validPngBuffer),
      }),
      executeJavaScript: vi.fn().mockResolvedValue(1200),
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
      isDestroyed: vi.fn().mockReturnValue(false),
      loadURL: vi.fn().mockResolvedValue(undefined),
    };
  }

  class MockWebContentsView {
    setBounds = vi.fn();
    webContents = {
      loadURL: vi.fn().mockResolvedValue(undefined),
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
      isDestroyed: vi.fn().mockReturnValue(false),
    };
  }

  return {
    app: {
      getPath: vi.fn((name: string) => (name === "userData" ? "/tmp/geminui-test-userdata" : "/tmp")),
      getName: vi.fn(() => "geminui"),
      getVersion: vi.fn(() => "0.14.0"),
      isPackaged: false,
      quit: vi.fn(),
      on: vi.fn(),
    },
    safeStorage: {
      isEncryptionAvailable: vi.fn(() => false),
      encryptString: vi.fn((str: string) => Buffer.from(str)),
      decryptString: vi.fn((buf: Buffer) => buf.toString("utf8")),
    },
    BrowserWindow: MockBrowserWindow,
    WebContentsView: MockWebContentsView,
    dialog: {
      showOpenDialog: vi.fn(),
      showSaveDialog: vi.fn(),
      showMessageBox: vi.fn(),
      showErrorBox: vi.fn(),
    },
    ipcRenderer: {
      invoke: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn(),
      removeAllListeners: vi.fn(),
      send: vi.fn(),
    },
    ipcMain: {
      handle: vi.fn(),
      removeHandler: vi.fn(),
      on: vi.fn(),
    },
    shell: {
      openExternal: vi.fn(),
      openPath: vi.fn(),
      showItemInFolder: vi.fn(),
    },
    session: {
      fromPartition: vi.fn().mockReturnValue({
        setPermissionRequestHandler: vi.fn(),
        setPermissionCheckHandler: vi.fn(),
        on: vi.fn(),
        clearStorageData: vi.fn().mockResolvedValue(undefined),
      }),
      defaultSession: {
        setPermissionRequestHandler: vi.fn(),
        setPermissionCheckHandler: vi.fn(),
        on: vi.fn(),
        clearStorageData: vi.fn().mockResolvedValue(undefined),
      },
    },
  };
});
