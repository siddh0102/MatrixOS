export type ProviderType =
  | "claude"
  | "ollama"
  | "openai-compatible"
  | "local";

export interface ModelConfig {
  readonly id: string;
  readonly name: string;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly supportsTools: boolean;
  readonly supportsStreaming: boolean;
  readonly supportsVision: boolean;
  readonly costPerInputToken: number;
  readonly costPerOutputToken: number;
  readonly supportsThinking?: boolean;
  readonly thinkingBudgetDefault?: number;
}

export interface RateLimitConfig {
  readonly requestsPerMinute: number;
  readonly tokensPerMinute: number;
}

export interface ProviderConfig {
  readonly id: string;
  readonly type: ProviderType;
  name: string;
  baseUrl: string | null;
  enabled: boolean;
  models: ModelConfig[];
  defaultModelId: string;
  rateLimit: RateLimitConfig;
  createdAt: string;
  updatedAt: string;
}

export interface LLMMessage {
  readonly role: "user" | "assistant" | "system";
  readonly content: LLMContentBlock[];
}

export type LLMContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; base64: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; toolCallId: string; content: string; isError: boolean };

export interface LLMToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

/**
 * Identifies which subsystem initiated an LLM call. Mirrors the Rust
 * `CallContext` enum (see `src-tauri/src/providers/types.rs`) using
 * `#[serde(tag = "type")]` with PascalCase variant tags and camelCase
 * fields. Used by the Rust backend for audit/attribution and (in later
 * phases) for agent-scoped rate limiting.
 */
export type CallContext =
  | { type: "Agent"; agentId: string; processId: string | null }
  | { type: "User" }
  | { type: "Scheduler"; jobId: string }
  | {
      type: "Workflow";
      workflowRunId: string;
      // Sandbox for this step's filesystem tool calls. Workflows have no
      // agent to resolve a policy from, so the step carries its own.
      sandbox?: { enabled: boolean; allowedPaths: string[] };
    };

export interface LLMRequest {
  readonly model: string;
  readonly systemPrompt: string;
  readonly messages: readonly LLMMessage[];
  readonly maxTokens: number;
  readonly temperature: number;
  readonly tools?: readonly LLMToolDefinition[];
  readonly signal?: AbortSignal;
  readonly thinking?: { enabled: boolean; budgetTokens?: number };
  /**
   * Attribution context passed to the Rust backend as a top-level IPC
   * argument (NOT inside the request body — the proxy strips this field
   * before forwarding the body to the provider). Defaults to
   * `{ type: "User" }` when omitted.
   */
  readonly callContext?: CallContext;
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface LLMResponse {
  readonly id: string;
  readonly model: string;
  readonly content: LLMContentBlock[];
  readonly stopReason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
  readonly usage: TokenUsage;
}

export type LLMStreamChunk =
  | { type: "message_start"; id?: string }
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "thinking_end" }
  | { type: "tool_use_start"; id: string; name: string }
  | { type: "tool_use_delta"; toolCallId: string; partialJson: string }
  | { type: "tool_use_end"; toolCallId: string }
  | {
      type: "message_end";
      usage: TokenUsage;
      // Per-round detail surfaced from Rust (migration 020). Optional: only the
      // openai_compatible provider populates them today; others omit.
      finishReason?: string;
      ttftMs?: number;
    };

export interface ILLMProvider {
  readonly type: ProviderType;
  readonly config: ProviderConfig;
  sendMessage(request: LLMRequest): Promise<LLMResponse>;
  streamMessage(
    request: LLMRequest,
  ): AsyncGenerator<LLMStreamChunk, void, undefined>;
  listModels(): Promise<ModelConfig[]>;
  validateConnection(): Promise<boolean>;
}

// ── Static model catalogs ──

export const CLAUDE_MODELS: ModelConfig[] = [
  {
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    supportsTools: true,
    supportsStreaming: true,
    supportsVision: true,
    supportsThinking: true,
    thinkingBudgetDefault: 10_000,
    costPerInputToken: 0.000015,
    costPerOutputToken: 0.000075,
  },
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    contextWindow: 200_000,
    maxOutputTokens: 16_000,
    supportsTools: true,
    supportsStreaming: true,
    supportsVision: true,
    supportsThinking: true,
    thinkingBudgetDefault: 10_000,
    costPerInputToken: 0.000003,
    costPerOutputToken: 0.000015,
  },
  {
    id: "claude-haiku-4-5-20251001",
    name: "Claude Haiku 4.5",
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    supportsTools: true,
    supportsStreaming: true,
    supportsVision: true,
    costPerInputToken: 0.0000008,
    costPerOutputToken: 0.000004,
  },
];

