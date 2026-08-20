import { Transform, type TransformCallback } from "node:stream";

/** Pass-through transform that terminates a protocol stream with an oversized line. */
export class NdjsonLineGuard extends Transform {
  private currentLineBytes = 0;

  constructor(readonly maxLineBytes = 32 * 1024 * 1024) {
    super();
    if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes <= 0) {
      throw new RangeError("maxLineBytes must be a positive safe integer");
    }
  }

  override _transform(
    chunk: Buffer,
    encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    for (const byte of bytes) {
      if (byte === 0x0a) {
        this.currentLineBytes = 0;
      } else {
        this.currentLineBytes += 1;
        if (this.currentLineBytes > this.maxLineBytes) {
          callback(
            new Error(
              `ACP protocol line exceeded ${this.maxLineBytes} bytes`,
            ),
          );
          return;
        }
      }
    }

    callback(null, bytes);
  }
}
