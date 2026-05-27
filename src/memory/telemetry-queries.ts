import { dbSelect } from "@/kernel/ipc-bridge";
import type { LLMRequestLog, LLMCallLog, ToolExecutionLog } from "@/types";

export interface DashboardStats {
  totalRequests: number;
  successCount: number;
  errorCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  avgLatencyMs: number;
  activeAgentIds: string[];
  requestsPerMinute: number;
  tokensPerMinute: number;
  errorRate: number;
}

interface StatsRow {
  total_requests: number;
  success_count: number;
  error_count: number;
  total_input_tokens: number;
  total_output_tokens: number;
  avg_latency_ms: number;
  min_created_at: string;
  max_created_at: string;
}

interface AgentIdRow {
  agent_id: string;
}

export async function getDashboardStats(
  since: string,
  until?: string,
): Promise<DashboardStats> {
  const untilClause = until ? "AND created_at <= ?" : "";
  const params: unknown[] = [since];
  if (until) params.push(until);

  const rows = await dbSelect<StatsRow>(
    `SELECT
      COUNT(*) as total_requests,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_count,
      SUM(input_tokens) as total_input_tokens,
      SUM(output_tokens) as total_output_tokens,
      AVG(latency_ms) as avg_latency_ms,
      MIN(created_at) as min_created_at,
      MAX(created_at) as max_created_at
     FROM llm_requests
     WHERE created_at >= ? ${untilClause}`,
    params,
  );

  const row = rows[0];
  const totalRequests = row?.total_requests ?? 0;
  const totalInputTokens = row?.total_input_tokens ?? 0;
  const totalOutputTokens = row?.total_output_tokens ?? 0;
  const minCreated = row?.min_created_at;
  const maxCreated = row?.max_created_at;

  let rangeMinutes = 1;
  if (minCreated && maxCreated) {
    const diff = new Date(maxCreated).getTime() - new Date(minCreated).getTime();
    rangeMinutes = Math.max(1, diff / 60000);
  }

  const agentRows = await dbSelect<AgentIdRow>(
    `SELECT DISTINCT agent_id FROM llm_requests WHERE created_at >= ? ${untilClause} AND agent_id IS NOT NULL`,
    params,
  );

  const errorCount = row?.error_count ?? 0;

  return {
    totalRequests,
    successCount: row?.success_count ?? 0,
    errorCount,
    totalInputTokens,
    totalOutputTokens,
    avgLatencyMs: row?.avg_latency_ms ?? 0,
    activeAgentIds: agentRows.map((r) => r.agent_id),
    requestsPerMinute: totalRequests / rangeMinutes,
    tokensPerMinute: (totalInputTokens + totalOutputTokens) / rangeMinutes,
    errorRate: totalRequests > 0 ? errorCount / totalRequests : 0,
  };
}

export interface TimeSeriesBucket {
  bucketStart: string;
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  errorCount: number;
  avgLatencyMs: number;
}

interface BucketRow {
  bucket_start: string;
  request_count: number;
  input_tokens: number;
  output_tokens: number;
  error_count: number;
  avg_latency_ms: number;
}

export async function getTimeSeries(
  since: string,
  until: string,
  bucketMinutes: number,
): Promise<TimeSeriesBucket[]> {
  const rows = await dbSelect<BucketRow>(
    `SELECT
      strftime('%Y-%m-%dT%H:', created_at) ||
        printf('%02d', (CAST(strftime('%M', created_at) AS INTEGER) / ${bucketMinutes}) * ${bucketMinutes})
        || ':00Z' AS bucket_start,
      COUNT(*) as request_count,
      SUM(input_tokens) as input_tokens,
      SUM(output_tokens) as output_tokens,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_count,
      AVG(latency_ms) as avg_latency_ms
     FROM llm_requests
     WHERE created_at >= ? AND created_at <= ?
     GROUP BY bucket_start
     ORDER BY bucket_start ASC`,
    [since, until],
  );

  return rows.map((r) => ({
    bucketStart: r.bucket_start,
    requestCount: r.request_count,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    errorCount: r.error_count,
    avgLatencyMs: r.avg_latency_ms,
  }));
}

export interface AgentStats {
  agentId: string | null;
  agentName: string;
  requestCount: number;
  totalTokens: number;
  avgLatencyMs: number;
  errorCount: number;
}

interface AgentBreakdownRow {
  agent_id: string | null;
  agent_name: string;
  request_count: number;
  total_tokens: number;
  avg_latency_ms: number;
  error_count: number;
}

export async function getAgentBreakdown(
  since: string,
  until?: string,
): Promise<AgentStats[]> {
  const untilClause = until ? "AND lr.created_at <= ?" : "";
  const params: unknown[] = [since];
  if (until) params.push(until);

  const rows = await dbSelect<AgentBreakdownRow>(
    `SELECT
      lr.agent_id,
      COALESCE(a.name, '(deleted)') AS agent_name,
      COUNT(*) as request_count,
      SUM(lr.input_tokens + lr.output_tokens) as total_tokens,
      AVG(lr.latency_ms) as avg_latency_ms,
      SUM(CASE WHEN lr.status = 'error' THEN 1 ELSE 0 END) as error_count
     FROM llm_requests lr
     LEFT JOIN agents a ON lr.agent_id = a.id
     WHERE lr.created_at >= ? ${untilClause}
     GROUP BY lr.agent_id
     ORDER BY request_count DESC`,
    params,
  );

  return rows.map((r) => ({
    agentId: r.agent_id,
    agentName: r.agent_name,
    requestCount: r.request_count,
    totalTokens: r.total_tokens,
    avgLatencyMs: r.avg_latency_ms,
    errorCount: r.error_count,
  }));
}

export async function getRequestLog(
  filters: {
    agentId?: string;
    providerId?: string;
    status?: "success" | "error";
    since?: string;
    until?: string;
  },
  limit: number,
  offset: number,
): Promise<{ rows: LLMRequestLog[]; total: number }> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.agentId) { conditions.push("lr.agent_id = ?"); params.push(filters.agentId); }
  if (filters.providerId) { conditions.push("lr.provider_id = ?"); params.push(filters.providerId); }
  if (filters.status) { conditions.push("lr.status = ?"); params.push(filters.status); }
  if (filters.since) { conditions.push("lr.created_at >= ?"); params.push(filters.since); }
  if (filters.until) { conditions.push("lr.created_at <= ?"); params.push(filters.until); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  interface CountRow { total: number }
  const countRows = await dbSelect<CountRow>(
    `SELECT COUNT(*) as total FROM llm_requests lr ${where}`,
    params,
  );
  const total = countRows[0]?.total ?? 0;

  // Join agent name and (when the turn belongs to a workflow run) the workflow
  // name. Columns are lr.-qualified because agents/workflows also have created_at.
  const rows = await dbSelect<Record<string, unknown>>(
    `SELECT lr.*, a.name AS agent_name,
            json_extract(w.definition_json, '$.name') AS workflow_name
       FROM llm_requests lr
       LEFT JOIN agents a ON lr.agent_id = a.id
       LEFT JOIN workflow_runs wr ON lr.run_id = wr.id
       LEFT JOIN workflows w ON wr.workflow_id = w.id
       ${where}
       ORDER BY lr.created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  return {
    rows: rows.map(mapRequestRow),
    total,
  };
}

export async function exportTelemetry(
  since: string,
  until: string,
  format: "json" | "csv",
): Promise<string> {
  const rows = await dbSelect<Record<string, unknown>>(
    `SELECT * FROM llm_requests WHERE created_at >= ? AND created_at <= ? ORDER BY created_at ASC`,
    [since, until],
  );
  const data = rows.map(mapRequestRow);

  if (format === "json") {
    return JSON.stringify(data, null, 2);
  }

  if (data.length === 0) return "";
  const headers = Object.keys(data[0] as unknown as Record<string, unknown>);
  const csvLines = [
    headers.join(","),
    ...data.map((row) =>
      headers.map((h) => {
        const val = (row as unknown as Record<string, unknown>)[h];
        const str = val === null || val === undefined ? "" : String(val);
        return str.includes(",") || str.includes('"') || str.includes("\n")
          ? `"${str.replace(/"/g, '""')}"`
          : str;
      }).join(","),
    ),
  ];
  return csvLines.join("\n");
}

// ── Failure breakdown (LLD 3.1) ──────────────────────────────────────────────

export interface FailureStat {
  reason: string;
  /** "error" = turn failed (error_code); "finish" = round hit an abnormal stop. */
  source: "error" | "finish";
  count: number;
}

export async function getFailureBreakdown(
  since: string,
  until?: string,
): Promise<FailureStat[]> {
  const u = until ? "AND created_at <= ?" : "";
  const p = (): unknown[] => (until ? [since, until] : [since]);

  const errRows = await dbSelect<{ reason: string; count: number }>(
    `SELECT COALESCE(error_code, '(unknown)') AS reason, COUNT(*) AS count
       FROM llm_requests
      WHERE status = 'error' AND created_at >= ? ${u}
      GROUP BY error_code`,
    p(),
  );
  // Per-round abnormal terminations. 'stop'/'tool_calls' are the protocol's
  // normal completions; everything else (length, content_filter, …) is surfaced
  // generically so no single failure reason is hardcoded.
  const finRows = await dbSelect<{ reason: string; count: number }>(
    `SELECT finish_reason AS reason, COUNT(*) AS count
       FROM llm_calls
      WHERE finish_reason IS NOT NULL
        AND finish_reason NOT IN ('stop', 'tool_calls')
        AND created_at >= ? ${u}
      GROUP BY finish_reason`,
    p(),
  );

  return [
    ...errRows.map((r) => ({ reason: r.reason, source: "error" as const, count: r.count })),
    ...finRows.map((r) => ({ reason: r.reason, source: "finish" as const, count: r.count })),
  ].sort((a, b) => b.count - a.count);
}

// ── Cost breakdown (LLD 3.3) ─────────────────────────────────────────────────

export interface TokenCostRow {
  agentId: string | null;
  providerId: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Token sums grouped by (agent, provider, model). Cost = tokens × rate is
 * computed by the caller against ModelConfig rates — never stored, so a price
 * change is reflected immediately and no rate is hardcoded in a column.
 * Grouped by model so an agent that used several models costs correctly.
 */
export async function getTokenCostBreakdown(
  since: string,
  until?: string,
): Promise<TokenCostRow[]> {
  const u = until ? "AND created_at <= ?" : "";
  const params: unknown[] = until ? [since, until] : [since];
  const rows = await dbSelect<{
    agent_id: string | null;
    provider_id: string;
    model_id: string;
    input_tokens: number;
    output_tokens: number;
  }>(
    `SELECT agent_id, provider_id, model_id,
            SUM(input_tokens) AS input_tokens,
            SUM(output_tokens) AS output_tokens
       FROM llm_requests
      WHERE created_at >= ? ${u}
      GROUP BY agent_id, provider_id, model_id`,
    params,
  );
  return rows.map((r) => ({
    agentId: r.agent_id ?? null,
    providerId: r.provider_id,
    modelId: r.model_id,
    inputTokens: r.input_tokens ?? 0,
    outputTokens: r.output_tokens ?? 0,
  }));
}

// ── Tool-call inspector (LLD 3.4) ────────────────────────────────────────────

export async function getToolExecutions(
  filters: { search?: string; status?: string; since?: string; until?: string },
  limit: number,
  offset: number,
): Promise<{ rows: ToolExecutionLog[]; total: number }> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filters.search) { conditions.push("te.tool_name LIKE ?"); params.push(`%${filters.search}%`); }
  if (filters.status) { conditions.push("te.status = ?"); params.push(filters.status); }
  if (filters.since) { conditions.push("te.created_at >= ?"); params.push(filters.since); }
  if (filters.until) { conditions.push("te.created_at <= ?"); params.push(filters.until); }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const countRows = await dbSelect<{ total: number }>(
    `SELECT COUNT(*) as total FROM tool_executions te ${where}`,
    params,
  );
  const total = countRows[0]?.total ?? 0;

  // Resolve agent + workflow: tool calls made inside an agent turn carry
  // request_id (= the turn's llm_requests.id), giving agent_id and run_id;
  // workflow tool_call steps carry run_id directly (COALESCE covers both).
  const rows = await dbSelect<Record<string, unknown>>(
    `SELECT te.*, a.name AS agent_name,
            json_extract(w.definition_json, '$.name') AS workflow_name
       FROM tool_executions te
       LEFT JOIN llm_requests lr ON te.request_id = lr.id
       LEFT JOIN agents a ON lr.agent_id = a.id
       LEFT JOIN workflow_runs wr ON COALESCE(te.run_id, lr.run_id) = wr.id
       LEFT JOIN workflows w ON wr.workflow_id = w.id
       ${where}
       ORDER BY te.created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  return { rows: rows.map(mapToolExecRow), total };
}

function mapToolExecRow(row: Record<string, unknown>): ToolExecutionLog {
  return {
    id: row.id as string,
    toolName: row.tool_name as string,
    serverId: (row.server_id as string) ?? null,
    argsJson: (row.args_json as string) ?? null,
    resultJson: (row.result_json as string) ?? null,
    error: (row.error as string) ?? null,
    status: (row.status as string) ?? null,
    durationMs: (row.duration_ms as number) ?? null,
    sandboxDecision: (row.sandbox_decision as string) ?? null,
    createdAt: row.created_at as string,
    agentName: (row.agent_name as string) ?? null,
    workflowName: (row.workflow_name as string) ?? null,
  };
}

// ── Per-call spans for a run (LLD 3.2) ───────────────────────────────────────

export interface TurnRow {
  id: string;
  stepId: string | null;
  parentRequestId: string | null;
  agentId: string | null;
  modelId: string;
  status: string;
}

/**
 * All turns and their per-round calls for a workflow run. Root turns are linked
 * by run_id; delegated sub-agent turns carry only parent_request_id, so they are
 * pulled in by expanding the delegation tree (bounded by the acyclic graph).
 */
export async function getRunCalls(
  runId: string,
): Promise<{ turns: TurnRow[]; calls: LLMCallLog[] }> {
  const cols = "id, step_id, parent_request_id, agent_id, model_id, status";
  const turns: TurnRow[] = [];
  const seen = new Set<string>();
  let frontier: string[] = [];

  const roots = await dbSelect<Record<string, unknown>>(
    `SELECT ${cols} FROM llm_requests WHERE run_id = ?`,
    [runId],
  );
  for (const r of roots) {
    const t = mapTurnRow(r);
    turns.push(t);
    seen.add(t.id);
    frontier.push(t.id);
  }

  while (frontier.length > 0) {
    const ph = frontier.map(() => "?").join(",");
    const children = await dbSelect<Record<string, unknown>>(
      `SELECT ${cols} FROM llm_requests WHERE parent_request_id IN (${ph})`,
      frontier,
    );
    frontier = [];
    for (const r of children) {
      const t = mapTurnRow(r);
      if (!seen.has(t.id)) {
        turns.push(t);
        seen.add(t.id);
        frontier.push(t.id);
      }
    }
  }

  if (turns.length === 0) return { turns: [], calls: [] };

  const ids = turns.map((t) => t.id);
  const ph = ids.map(() => "?").join(",");
  const callRows = await dbSelect<Record<string, unknown>>(
    `SELECT * FROM llm_calls WHERE request_id IN (${ph}) ORDER BY turn_index ASC`,
    ids,
  );
  return { turns, calls: callRows.map(mapCallRow) };
}

/** Per-round calls for one turn (LLD 3.6 context inspector). */
export async function getCallsForRequest(requestId: string): Promise<LLMCallLog[]> {
  const rows = await dbSelect<Record<string, unknown>>(
    `SELECT * FROM llm_calls WHERE request_id = ? ORDER BY turn_index ASC`,
    [requestId],
  );
  return rows.map(mapCallRow);
}

function mapTurnRow(row: Record<string, unknown>): TurnRow {
  return {
    id: row.id as string,
    stepId: (row.step_id as string) ?? null,
    parentRequestId: (row.parent_request_id as string) ?? null,
    agentId: (row.agent_id as string) ?? null,
    modelId: row.model_id as string,
    status: row.status as string,
  };
}

function mapCallRow(row: Record<string, unknown>): LLMCallLog {
  return {
    id: row.id as string,
    requestId: row.request_id as string,
    turnIndex: row.turn_index as number,
    inputTokens: (row.input_tokens as number) ?? null,
    outputTokens: (row.output_tokens as number) ?? null,
    ttftMs: (row.ttft_ms as number) ?? null,
    latencyMs: (row.latency_ms as number) ?? null,
    finishReason: (row.finish_reason as string) ?? null,
    responseText: (row.response_text as string) ?? null,
    promptJson: (row.prompt_json as string) ?? null,
    createdAt: row.created_at as string,
  };
}

function mapRequestRow(row: Record<string, unknown>): LLMRequestLog {
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
    agentName: (row.agent_name as string) ?? null,
    workflowName: (row.workflow_name as string) ?? null,
  };
}
