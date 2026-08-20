const SENSITIVE_ASSIGNMENT =
  /\b([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*)\s*=\s*([^\s,;]+)/gi;
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;

export function redactDiagnosticText(
  value: string,
  secretValues: readonly string[] = [],
): string {
  let redacted = value
    .replace(SENSITIVE_ASSIGNMENT, "$1=[REDACTED]")
    .replace(BEARER_TOKEN, "Bearer [REDACTED]");

  for (const secret of secretValues) {
    if (secret.length >= 6) {
      redacted = redacted.split(secret).join("[REDACTED]");
    }
  }

  return redacted;
}

/** Keeps only the most recent bytes, so a noisy child cannot grow memory forever. */
export class BoundedTextBuffer {
  readonly maxBytes: number;
  private chunks: Buffer[] = [];
  private byteLength = 0;

  constructor(maxBytes = 64 * 1024) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new RangeError("maxBytes must be a positive safe integer");
    }
    this.maxBytes = maxBytes;
  }

  append(value: string | Uint8Array): void {
    let chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    if (chunk.byteLength >= this.maxBytes) {
      chunk = chunk.subarray(chunk.byteLength - this.maxBytes);
      this.chunks = [chunk];
      this.byteLength = chunk.byteLength;
      return;
    }

    this.chunks.push(chunk);
    this.byteLength += chunk.byteLength;
    this.trim();
  }

  clear(): void {
    this.chunks = [];
    this.byteLength = 0;
  }

  toString(secretValues: readonly string[] = []): string {
    return redactDiagnosticText(Buffer.concat(this.chunks).toString("utf8"), secretValues);
  }

  private trim(): void {
    let excess = this.byteLength - this.maxBytes;
    while (excess > 0 && this.chunks.length > 0) {
      const first = this.chunks[0];
      if (first.byteLength <= excess) {
        this.chunks.shift();
        this.byteLength -= first.byteLength;
        excess -= first.byteLength;
      } else {
        this.chunks[0] = first.subarray(excess);
        this.byteLength -= excess;
        excess = 0;
      }
    }
  }
}

export function environmentSecrets(environment: NodeJS.ProcessEnv): string[] {
  const result: string[] = [];
  for (const [name, value] of Object.entries(environment)) {
    if (
      value &&
      /(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(name)
    ) {
      result.push(value);
    }
  }
  return result;
}
