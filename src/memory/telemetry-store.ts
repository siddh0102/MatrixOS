import { dbSelect } from "@/kernel/ipc-bridge";
import type { LLMRequestLog, LLMCallLog, ToolExecutionLog } from "@/types";

export async function saveLLMRequest(log: LLMRequestLog): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("telemetry_append_llm_request", {
    row: {
      id: log.id,
      conversationId: log.conversationId,
      agentId: log.agentId,
      providerId: log.providerId,
      modelId: log.modelId,
      promptJson: log.promptJson,
      responseText: log.responseText,
      inputTokens: log.inputTokens,
      outputTokens: log.outputTokens,
      toolRounds: log.toolRounds,
      latencyMs: log.latencyMs,
      status: log.status,
      errorCode: log.errorCode,
      createdAt: log.createdAt,
      runId: log.runId ?? null,
      stepId: log.stepId ?? null,
      parentRequestId: log.parentRequestId ?? null,
    },
  });
}

/** Per-round LLM-call detail (migration 020). Fire-and-forget at the call site. */
export async function saveLLMCall(log: LLMCallLog): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("telemetry_append_llm_call", {
    row: {
      id: log.id,
      requestId: log.requestId,
      turnIndex: log.turnIndex,
      inputTokens: log.inputTokens,
      outputTokens: log.outputTokens,
      ttftMs: log.ttftMs,
      latencyMs: log.latencyMs,
      finishReason: log.finishReason,
      responseText: log.responseText,
      promptJson: log.promptJson,
      createdAt: log.createdAt,
    },
  });
}

/** Full tool-call record (migration 020). Fire-and-forget at the call site.
 *  `linkage` ties the row to its turn/run so agent + workflow can be resolved. */
export async function saveToolExecution(
  log: ToolExecutionLog,
  linkage?: { requestId?: string; runId?: string; stepId?: string },
): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("tool_exec_append", {
    row: {
      id: log.id,
      requestId: linkage?.requestId ?? null,
      runId: linkage?.runId ?? null,
      stepId: linkage?.stepId ?? null,
      toolName: log.toolName,
      serverId: log.serverId,
      argsJson: log.argsJson,
      resultJson: log.resultJson,
      error: log.error,
      status: log.status,
      durationMs: log.durationMs,
      sandboxDecision: log.sandboxDecision,
      createdAt: log.createdAt,
    },
  });
}

export async function getLLMRequest(
  id: string,
): Promise<LLMRequestLog | null> {
  const rows = await dbSelect<Record<string, unknown>>(
    "SELECT * FROM llm_requests WHERE id = ?",
    [id],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function listLLMRequests(
  conversationId: string,
): Promise<LLMRequestLog[]> {
  const rows = await dbSelect<Record<string, unknown>>(
    "SELECT * FROM llm_requests WHERE conversation_id = ? ORDER BY created_at ASC",
    [conversationId],
  );
  return rows.map(mapRow);
}

function mapRow(row: Record<string, unknown>): LLMRequestLog {
  return {
    id: row.id as string,
    conversationId: row.conversation_id as string,
    agentId: (row.agent_id as string) ?? null,
    providerId: row.provider_id as string,
    modelId: row.model_id as string,
    promptJson: row.prompt_json as string,
    responseText: (row.response_text as string) ?? null,
    inputTokens: row.input_tokens as number,
    outputTokens: row.output_tokens as number,
    toolRounds: row.tool_rounds as number,
    latencyMs: row.latency_ms as number,
    status: row.status as "success" | "error",
    errorCode: (row.error_code as string) ?? null,
    createdAt: row.created_at as string,
    runId: (row.run_id as string) ?? null,
    stepId: (row.step_id as string) ?? null,
    parentRequestId: (row.parent_request_id as string) ?? null,
  };
}
