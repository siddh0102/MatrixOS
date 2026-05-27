export interface LLMRequestLog {
  readonly id: string;
  readonly conversationId: string;
  readonly agentId: string | null;
  readonly providerId: string;
  readonly modelId: string;
  readonly promptJson: string;
  readonly responseText: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly toolRounds: number;
  readonly latencyMs: number;
  readonly status: "success" | "error";
  readonly errorCode: string | null;
  readonly createdAt: string;
  // Orchestration linkage (migration 020). Null on the chat path; populated by
  // the workflow/delegation path so the trace can join turns to runs/steps and
  // nest delegated turns under their orchestrator turn.
  readonly runId?: string | null;
  readonly stepId?: string | null;
  readonly parentRequestId?: string | null;
  // Resolved display names (joined at query time in getRequestLog).
  readonly agentName?: string | null;
  readonly workflowName?: string | null;
}

/**
 * One LLM round-trip within a turn (migration 020). A single executeAgentTurn
 * makes up to MAX_TOOL_TURNS rounds; llm_requests aggregates them into one
 * per-turn row, while llm_calls keeps the per-round detail needed for spans and
 * per-round failure/context inspection. requestId = the turn's LLMRequestLog.id.
 */
export interface LLMCallLog {
  readonly id: string;
  readonly requestId: string;
  readonly turnIndex: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly ttftMs: number | null;
  readonly latencyMs: number | null;
  readonly finishReason: string | null;
  readonly responseText: string | null;
  // Captured only for error/'length' rounds (the ones worth inspecting), capped.
  readonly promptJson: string | null;
  readonly createdAt: string;
}

/**
 * One tool invocation (migration 020). audit_log keeps only
 * {toolCallId, serverId, durationMs}; this retains the args/result/sandbox
 * decision that were otherwise discarded. args/result are capped at the store.
 */
export interface ToolExecutionLog {
  readonly id: string;
  readonly toolName: string;
  readonly serverId: string | null;
  readonly argsJson: string | null;
  readonly resultJson: string | null;
  readonly error: string | null;
  readonly status: string | null;
  readonly durationMs: number | null;
  readonly sandboxDecision: string | null;
  readonly createdAt: string;
  // Resolved display names (joined via request_id -> llm_requests at query time).
  readonly agentName?: string | null;
  readonly workflowName?: string | null;
}

/**
 * Alert rule (migration 020). `source='event'` rules subscribe the event bus
 * and fire when their `eventType` occurs (optionally gated by a predicate over
 * the event payload). `predicateJson` is "{}" for "fire on every occurrence",
 * or {field, op, value}.
 */
export interface AlertRule {
  readonly id: string;
  readonly name: string | null;
  readonly source: "event" | "telemetry";
  readonly eventType: string | null;
  readonly predicateJson: string;
  readonly action: "toast" | "notify";
  readonly enabled: boolean;
  readonly createdAt: string;
}
