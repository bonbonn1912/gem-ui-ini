import type {
  RequestPermissionRequest as AcpPermissionRequest,
  RequestPermissionResponse as AcpPermissionResponse,
} from "@agentclientprotocol/sdk";

import { GeminiIntegrationError } from "./errors.js";
import { normalizeToolCall } from "./event-normalizer.js";
import type { PermissionRequest } from "./types.js";

export interface PermissionResolution {
  readonly permissionId: string;
  readonly optionId?: string;
  readonly outcome: "selected" | "cancelled";
}

export interface PermissionBrokerOptions {
  readonly appSessionId: string;
  readonly onRequested: (request: PermissionRequest) => void;
  readonly onResolved?: (resolution: PermissionResolution) => void;
}

interface PendingPermission {
  readonly request: PermissionRequest;
  readonly resolve: (response: AcpPermissionResponse) => void;
}

/** Bridges an ACP request/response into an explicit, never-auto-allow UI decision. */
export class PermissionBroker {
  private readonly pending = new Map<string, PendingPermission>();
  private sequence = 0;
  private disposed = false;

  constructor(private readonly options: PermissionBrokerOptions) {}

  get size(): number {
    return this.pending.size;
  }

  list(): PermissionRequest[] {
    return [...this.pending.values()].map(({ request }) => request);
  }

  request(input: AcpPermissionRequest): Promise<AcpPermissionResponse> {
    if (this.disposed) {
      return Promise.resolve({ outcome: { outcome: "cancelled" } });
    }

    const permissionId = `${input.sessionId}:${input.toolCall.toolCallId}:${++this.sequence}`;
    const request: PermissionRequest = {
      permissionId,
      appSessionId: this.options.appSessionId,
      providerSessionId: input.sessionId,
      toolCall: normalizeToolCall(input.toolCall),
      options: input.options.map((option) => ({
        optionId: option.optionId,
        name: option.name,
        kind: option.kind,
      })),
    };

    return new Promise((resolve) => {
      this.pending.set(permissionId, { request, resolve });
      this.options.onRequested(request);
    });
  }

  resolve(permissionId: string, optionId: string): void {
    const pending = this.pending.get(permissionId);
    if (!pending) {
      throw new GeminiIntegrationError(
        "invalid_permission_response",
        "The permission request is no longer pending",
        { details: { permissionId } },
      );
    }
    if (!pending.request.options.some((option) => option.optionId === optionId)) {
      throw new GeminiIntegrationError(
        "invalid_permission_response",
        "The optionId was not offered by the Gemini agent",
        { details: { permissionId, optionId } },
      );
    }

    this.pending.delete(permissionId);
    pending.resolve({ outcome: { outcome: "selected", optionId } });
    this.options.onResolved?.({ permissionId, optionId, outcome: "selected" });
  }

  cancel(permissionId: string): boolean {
    const pending = this.pending.get(permissionId);
    if (!pending) return false;
    this.pending.delete(permissionId);
    pending.resolve({ outcome: { outcome: "cancelled" } });
    this.options.onResolved?.({ permissionId, outcome: "cancelled" });
    return true;
  }

  cancelSession(providerSessionId: string): void {
    for (const [permissionId, pending] of this.pending) {
      if (pending.request.providerSessionId === providerSessionId) {
        this.cancel(permissionId);
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const permissionId of [...this.pending.keys()]) {
      this.cancel(permissionId);
    }
  }
}
