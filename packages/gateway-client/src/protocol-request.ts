import type { ErrorShape } from "@openclaw/gateway-protocol";

export type GatewayProtocolRequestOptions = {
  timeoutMs?: number | null;
  expectFinal?: boolean;
  onSent?: () => void;
  onAccepted?: (payload: unknown) => void;
  signal?: AbortSignal;
};

export class GatewayProtocolRequestError extends Error {
  readonly code: string;
  readonly gatewayCode: string;
  readonly details?: unknown;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(error: Partial<ErrorShape>) {
    super(error.message ?? "request failed");
    this.name = "GatewayProtocolRequestError";
    this.code = error.code ?? "UNAVAILABLE";
    this.gatewayCode = this.code;
    this.details = error.details;
    this.retryable = error.retryable === true;
    this.retryAfterMs = error.retryAfterMs;
  }
}

/** A transport deadline is distinct from a Gateway's authoritative rejection. */
export class GatewayProtocolRequestTimeoutError extends Error {
  readonly method: string;
  readonly timeoutMs: number;
  readonly requestSent: boolean;

  constructor(
    params: { method: string; timeoutMs: number; requestSent: boolean },
    message = `gateway request timed out after ${params.timeoutMs}ms: ${params.method}`,
  ) {
    super(message);
    this.name = "GatewayProtocolRequestTimeoutError";
    this.method = params.method;
    this.timeoutMs = params.timeoutMs;
    this.requestSent = params.requestSent;
  }
}
