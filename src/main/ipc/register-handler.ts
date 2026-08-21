import {
  ipcMain,
  type BrowserWindow,
  type IpcMainInvokeEvent,
} from "electron";
import type { ZodType } from "zod";
import {
  IpcRequestSchemas,
  IpcResponseSchemas,
  type IpcRequestChannel,
} from "../../shared/contracts";
import {
  assertTrustedIpcSender,
  toPublicError,
} from "../security/ipc-guard";

export function registerValidatedIpcHandler(
  channel: IpcRequestChannel,
  mainWindow: BrowserWindow,
  handler: (
    input: unknown,
    event: IpcMainInvokeEvent,
  ) => unknown | Promise<unknown>,
): () => void {
  const requestSchema = IpcRequestSchemas[channel] as ZodType;
  const responseSchema = IpcResponseSchemas[channel] as ZodType;

  ipcMain.handle(channel, async (event, payload: unknown = {}) => {
    try {
      assertTrustedIpcSender(event, mainWindow);
      const input = requestSchema.parse(payload);
      const output = await handler(input, event);
      return responseSchema.parse(output);
    } catch (error) {
      console.error(`[IPC Error on ${channel}]:`, error);
      throw toPublicError(error);
    }
  });

  return () => ipcMain.removeHandler(channel);
}
