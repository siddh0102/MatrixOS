export class MatrixOSError extends Error {
  readonly code: string;
  readonly recoverable: boolean;

  constructor(
    message: string,
    code: string = "UNKNOWN",
    recoverable: boolean = false,
  ) {
    super(message);
    this.name = "MatrixOSError";
    this.code = code;
    this.recoverable = recoverable;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ProviderError extends MatrixOSError {
  constructor(
    message: string,
    code: string = "PROVIDER_ERROR",
    recoverable: boolean = false,
  ) {
    super(message, code, recoverable);
    this.name = "ProviderError";
  }
}

export class DatabaseError extends MatrixOSError {
  constructor(
    message: string,
    code: string = "DATABASE_ERROR",
    recoverable: boolean = false,
  ) {
    super(message, code, recoverable);
    this.name = "DatabaseError";
  }
}

export class ToolError extends MatrixOSError {
  constructor(
    message: string,
    code: string = "TOOL_ERROR",
    recoverable: boolean = false,
  ) {
    super(message, code, recoverable);
    this.name = "ToolError";
  }
}

/**
 * Catch-all for typed Rust errors that don't fit ProviderError or
 * ToolError. Mirrors the Rust `RustError` envelope
 * (`code`, `message`, `retryable`).
 */
export class BackendError extends MatrixOSError {
  constructor(
    message: string,
    code: string = "UNKNOWN",
    recoverable: boolean = false,
  ) {
    super(message, code, recoverable);
    this.name = "BackendError";
  }
}

/**
 * Shape of the error payload Tauri delivers when a Rust command returns
 * `Err(RustError)`. Matches `src-tauri/src/providers/error.rs`.
 */
export interface RustErrorPayload {
  readonly code?: string;
  readonly message?: string;
  readonly retryable?: boolean;
  readonly details?: Record<string, unknown>;
}

/**
 * Map a `RustError` payload coming back from `invoke()` to one of the
 * typed JS error classes. Provider/transport-shaped codes become
 * `ProviderError`; tool/sandbox/MCP-shaped codes become `ToolError`;
 * everything else becomes `BackendError`. The Rust `retryable` field is
 * preserved as `recoverable` (same concept, existing JS naming).
 */
export function rustErrorToTyped(err: unknown): MatrixOSError {
  // If it's already one of ours (e.g. thrown by the proxy itself), pass through.
  if (err instanceof MatrixOSError) return err;

  const payload: RustErrorPayload =
    err && typeof err === "object" ? (err as RustErrorPayload) : {};
  const code = payload.code ?? "UNKNOWN";
  const msg = payload.message ?? (typeof err === "string" ? err : String(err));
  const retryable = payload.retryable ?? false;

  if (
    code.startsWith("AUTH_") ||
    code.startsWith("PROVIDER_HTTP_") ||
    code === "RATE_LIMITED" ||
    code === "CANCELLED" ||
    code === "REQUEST_ID_COLLISION" ||
    code === "NETWORK_ERROR" ||
    code === "PARSE_ERROR" ||
    code === "PROVIDER_NOT_FOUND"
  ) {
    return new ProviderError(msg, code, retryable);
  }
  if (
    code.startsWith("SANDBOX_") ||
    code.startsWith("FS_") ||
    code.startsWith("USER_PATH_") ||
    code.startsWith("WEB_") ||
    code === "SSRF_BLOCKED" ||
    code.startsWith("MCP_")
  ) {
    return new ToolError(msg, code, retryable);
  }
  return new BackendError(msg, code, retryable);
}
