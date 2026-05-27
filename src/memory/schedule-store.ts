import { dbExecute, dbSelect } from "@/kernel/ipc-bridge";
import type { ScheduledJob, ScheduleRunResult } from "@/types";
import { isoNow } from "@/lib/utils";

interface JobRow {
  id: string;
  agent_id: string;
  cron_expression: string;
  timezone: string;
  enabled: number;
  prompt: string;
  target_conversation_id: string | null;
  last_run_at: string | null;
  next_run_at: string | null;
  last_run_status: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface RunRow {
  id: string;
  job_id: string;
  conversation_id: string;
  message_id: string | null;
  status: string;
  error: string | null;
  input_tokens: number;
  output_tokens: number;
  started_at: string;
  completed_at: string;
}

function rowToJob(r: JobRow): ScheduledJob {
  return {
    id: r.id,
    agentId: r.agent_id,
    cronExpression: r.cron_expression,
    timezone: r.timezone,
    enabled: r.enabled === 1,
    prompt: r.prompt,
    targetConversationId: r.target_conversation_id,
    lastRunAt: r.last_run_at,
    nextRunAt: r.next_run_at,
    lastRunStatus: r.last_run_status as ScheduledJob["lastRunStatus"],
    lastError: r.last_error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToRunResult(r: RunRow): ScheduleRunResult {
  return {
    id: r.id,
    jobId: r.job_id,
    conversationId: r.conversation_id,
    messageId: r.message_id,
    status: r.status as "success" | "error",
    error: r.error ?? undefined,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    startedAt: r.started_at,
    completedAt: r.completed_at,
  };
}

export async function listScheduledJobs(): Promise<ScheduledJob[]> {
  const rows = await dbSelect<JobRow>(
    "SELECT * FROM scheduled_jobs ORDER BY created_at ASC",
  );
  return rows.map(rowToJob);
}

export async function getScheduledJob(id: string): Promise<ScheduledJob | null> {
  const rows = await dbSelect<JobRow>("SELECT * FROM scheduled_jobs WHERE id = ?", [id]);
  return rows[0] ? rowToJob(rows[0]) : null;
}

export async function saveScheduledJob(job: ScheduledJob): Promise<void> {
  await dbExecute(
    `INSERT OR REPLACE INTO scheduled_jobs
       (id, agent_id, cron_expression, timezone, enabled, prompt,
        target_conversation_id, last_run_at, next_run_at, last_run_status,
        last_error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      job.id,
      job.agentId,
      job.cronExpression,
      job.timezone,
      job.enabled ? 1 : 0,
      job.prompt,
      job.targetConversationId,
      job.lastRunAt,
      job.nextRunAt,
      job.lastRunStatus,
      job.lastError,
      job.createdAt,
      isoNow(),
    ],
  );
}

export async function deleteScheduledJob(id: string): Promise<void> {
  await dbExecute("DELETE FROM scheduled_jobs WHERE id = ?", [id]);
}

export async function getRunHistory(jobId: string, limit: number): Promise<ScheduleRunResult[]> {
  const rows = await dbSelect<RunRow>(
    `SELECT * FROM schedule_run_history WHERE job_id = ? ORDER BY started_at DESC LIMIT ?`,
    [jobId, limit],
  );
  return rows.map(rowToRunResult);
}
