import { invoke, Channel } from "@tauri-apps/api/core";
import { nanoid } from "nanoid";

import { rustErrorToTyped } from "@/lib/errors";
import type {
  CallContext,
  ILLMProvider,
  LLMRequest,
  LLMResponse,
  LLMStreamChunk,
  ModelConfig,
  ProviderConfig,
  ProviderType,
} from "@/types/provider";

/**
 * Proxy that satisfies `ILLMProvider` by delegating every operation to
 * the Rust backend via Tauri `invoke()` commands. Replaces the legacy
 * per-provider JS adapters (Task 16, Phase A backend migration).
 *
 * Stream semantics follow Appendix H6 of the migration plan:
 *  - `channel.onmessage` is bound BEFORE `invoke` so no early chunk is
 *    dropped.
 *  - The yield loop drains the queue, checks `done`, then drains again
 *    to catch chunks that arrive between the drain and the done check.
 *  - `channel.onmessage` is detached in `finally` so any truly late
 *    chunk (after the generator has returned) cannot re-enter a closed
 *    state.
 *  - The `AbortSignal` listener is removed in `finally` for both
 *    `sendMessage` and `streamMessage` so long-lived signals (e.g. a
 *    workflow-scoped controller) do not accumulate handlers.
 */
export class RustProviderProxy implements ILLMProvider {
  readonly type: ProviderType;
  readonly config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
    this.type = config.type;
    // Push the provider config into the Rust registry so subsequent
    // commands can resolve provider_id → config. Non-fatal on failure —
    // the per-command invocations will surface the real error.
    void invoke("llm_upsert_config", { config }).catch((e) => {
      console.warn("llm_upsert_config failed", e);
    });
  }

  validateConnection = async (): Promise<boolean> => {
    return invoke<boolean>("llm_validate", {
      providerId: this.config.id,
    }).catch((e) => {
      throw rustErrorToTyped(e);
    });
  };

  listModels = async (): Promise<ModelConfig[]> => {
    return invoke<ModelConfig[]>("llm_list_models", {
      providerId: this.config.id,
    }).catch((e) => {
      throw rustErrorToTyped(e);
    });
  };

  async sendMessage(req: LLMRequest): Promise<LLMResponse> {
    const requestId = nanoid();
    const ctx: CallContext = req.callContext ?? { type: "User" };
    const body = stripForRust(req);

    const onAbort = (): void => {
      void invoke("llm_cancel", { requestId });
    };
    req.signal?.addEventListener("abort", onAbort);
    try {
      return await invoke<LLMResponse>("llm_send", {
        providerId: this.config.id,
        request: body,
        ctx,
        requestId,
      }).catch((e) => {
        throw rustErrorToTyped(e);
      });
    } finally {
      req.signal?.removeEventListener("abort", onAbort);
    }
  }

  async *streamMessage(
    req: LLMRequest,
  ): AsyncGenerator<LLMStreamChunk, void, undefined> {
    const traceEnabled = (() => {
      try { return localStorage.getItem("MATRIXOS_NO_TRACE") !== "1"; }
      catch { return true; }
    })();
    const t0 = performance.now();
    const trace = (label: string, extra?: Record<string, unknown>) => {
      if (!traceEnabled) return;
      const ms = (performance.now() - t0).toFixed(0).padStart(6);
      // eslint-disable-next-line no-console
      console.log(`[rpc +${ms}ms] ${label}`, extra ?? "");
    };

    const channel = new Channel<LLMStreamChunk>();
    const queue: LLMStreamChunk[] = [];
    let wake: (() => void) | null = null;
    let done = false;
    let pendingError: unknown = null;
    let chunkCount = 0;

    // Bind onmessage BEFORE invoke so no chunk is dropped on the wire.
    channel.onmessage = (c) => {
      chunkCount++;
      if (chunkCount === 1) trace("first chunk over IPC", { type: c.type });
      queue.push(c);
      wake?.();
      wake = null;
    };

    const requestId = nanoid();
    const ctx: CallContext = req.callContext ?? { type: "User" };
    const body = stripForRust(req);
    trace("invoke llm_stream", {
      providerId: this.config.id,
      messages: req.messages.length,
      systemPromptChars: req.systemPrompt?.length ?? 0,
      maxTokens: req.maxTokens,
      requestId,
    });

    const onAbort = (): void => {
      void invoke("llm_cancel", { requestId });
    };
    req.signal?.addEventListener("abort", onAbort);

    void invoke<void>("llm_stream", {
      providerId: this.config.id,
      request: body,
      ctx,
      requestId,
      onChunk: channel,
    })
      .catch((e) => {
        pendingError = rustErrorToTyped(e);
        trace("invoke rejected", { code: (pendingError as { code?: string } | null)?.code });
      })
      .finally(() => {
        trace("invoke settled", { chunks: chunkCount, hadError: pendingError !== null });
        done = true;
        wake?.();
        wake = null;
        req.signal?.removeEventListener("abort", onAbort);
        // Detach so any late chunk arriving after the generator is
        // closed does not push into a queue that will never be drained.
        channel.onmessage = () => {};
      });

    while (true) {
      while (queue.length) yield queue.shift()!;
      if (done) {
        // Final drain — catches chunks that arrived between the drain
        // above and the `done` check (Appendix H6).
        while (queue.length) yield queue.shift()!;
        if (pendingError) throw pendingError;
        return;
      }
      await new Promise<void>((r) => {
        wake = r;
      });
    }
  }
}

/**
 * Strip JS-only fields (`signal`, `callContext`) before forwarding the
 * request body to Rust. `callContext` is passed as the top-level `ctx`
 * IPC argument, not inside the request body.
 */
function stripForRust(
  req: LLMRequest,
): Omit<LLMRequest, "signal" | "callContext"> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { signal, callContext, ...rest } = req;
  return rest;
}
