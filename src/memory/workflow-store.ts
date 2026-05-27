import type { WorkflowDefinition, WorkflowRun } from "@/types";
import { dbExecute, dbSelect } from "@/kernel/ipc-bridge";

const ALLOWED_RUN_COLUMNS = new Set([
  "status", "completed_at", "error", "duration_ms", "variables_json", "step_results_json",
]);

export async function listWorkflows(): Promise<WorkflowDefinition[]> {
  const rows = await dbSelect<{ definition_json: string }>(
    "SELECT definition_json FROM workflows ORDER BY updated_at DESC",
  );
  return rows.map(rowToWorkflow);
}

export async function getWorkflow(id: string): Promise<WorkflowDefinition | null> {
  const rows = await dbSelect<{ definition_json: string }>(
    "SELECT definition_json FROM workflows WHERE id = ?",
    [id],
  );
  return rows.length > 0 ? rowToWorkflow(rows[0]) : null;
}

export async function saveWorkflow(workflow: WorkflowDefinition): Promise<void> {
  await dbExecute(
    `INSERT OR REPLACE INTO workflows (id, definition_json, created_at, updated_at)
     VALUES (?, ?, ?, ?)`,
    [
      workflow.id,
      JSON.stringify(workflow),
      workflow.createdAt,
      workflow.updatedAt,
    ],
  );
}

export async function deleteWorkflow(id: string): Promise<void> {
  await dbExecute("DELETE FROM workflows WHERE id = ?", [id]);
}

export async function saveWorkflowRun(run: WorkflowRun): Promise<void> {
  await dbExecute(
    `INSERT INTO workflow_runs (id, workflow_id, workflow_version, status, triggered_by, variables_json, step_results_json, started_at, completed_at, error, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      run.id,
      run.workflowId,
      run.workflowVersion,
      run.status,
      run.triggeredBy,
      JSON.stringify(run.variables),
      JSON.stringify(run.stepResults),
      run.startedAt,
      run.completedAt,
      run.error,
      run.durationMs,
    ],
  );
}

export async function updateWorkflowRun(id: string, updates: Record<string, unknown>): Promise<void> {
  const setClauses: string[] = [];
  const values: unknown[] = [];

  for (const [key, value] of Object.entries(updates)) {
    if (!ALLOWED_RUN_COLUMNS.has(key)) {
      throw new Error(`Invalid column for workflow_runs update: ${key}`);
    }
    setClauses.push(`${key} = ?`);
    values.push(value);
  }

  if (setClauses.length === 0) return;
  values.push(id);

  await dbExecute(
    `UPDATE workflow_runs SET ${setClauses.join(", ")} WHERE id = ?`,
    values,
  );
}

export async function listWorkflowRuns(workflowId: string, limit = 50): Promise<WorkflowRun[]> {
  const rows = await dbSelect<any>(
    "SELECT * FROM workflow_runs WHERE workflow_id = ? ORDER BY started_at DESC LIMIT ?",
    [workflowId, limit],
  );
  return rows.map(rowToRun);
}

export async function getWorkflowRun(id: string): Promise<WorkflowRun | null> {
  const rows = await dbSelect<any>(
    "SELECT * FROM workflow_runs WHERE id = ?",
    [id],
  );
  return rows.length > 0 ? rowToRun(rows[0]) : null;
}

export async function saveHumanInputRequest(request: {
  id: string;
  runId: string;
  stepId: string;
  prompt: string;
  inputType: string;
  choicesJson: string | null;
  response: string | null;
  respondedAt: string | null;
  timeoutAt: string | null;
  createdAt: string;
}): Promise<void> {
  await dbExecute(
    `INSERT INTO workflow_human_inputs (id, run_id, step_id, prompt, input_type, choices_json, response, responded_at, timeout_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      request.id,
      request.runId,
      request.stepId,
      request.prompt,
      request.inputType,
      request.choicesJson,
      request.response,
      request.respondedAt,
      request.timeoutAt,
      request.createdAt,
    ],
  );
}

export async function getPendingHumanInputs(runId: string): Promise<any[]> {
  return dbSelect(
    "SELECT * FROM workflow_human_inputs WHERE run_id = ? AND responded_at IS NULL",
    [runId],
  );
}

export async function trackWorkflowConversation(conversationId: string, runId: string, stepId: string): Promise<void> {
  await dbExecute(
    `INSERT INTO workflow_conversations (conversation_id, workflow_run_id, step_id, created_at)
     VALUES (?, ?, ?, datetime('now'))`,
    [conversationId, runId, stepId],
  );
}

/**
 * Bootstrap helper: mark any workflow_runs left in a non-terminal state
 * (running / pending / paused) as failed. The executor keeps its run
 * state in memory only — once the app exits, any such row is by
 * definition orphaned and cannot resume. Call once at startup so the
 * History view doesn't lie about runs that will never finish.
 */
export async function reapOrphanedRuns(): Promise<number> {
  const orphans = await dbSelect<{
    id: string;
    started_at: string;
    step_results_json: string | null;
  }>(
    "SELECT id, started_at, CAST(step_results_json AS TEXT) AS step_results_json FROM workflow_runs WHERE status IN ('running','pending','paused')",
  );
  if (orphans.length === 0) return 0;

  const ORPHAN_MSG =
    "Orphaned run — app restarted before completion. In-memory executor state did not persist.";
  const now = Date.now();
  for (const row of orphans) {
    const startedMs = new Date(row.started_at).getTime();
    const durationMs = Number.isFinite(startedMs) ? now - startedMs : null;

    // Reconcile any in-flight steps. The executor persists a step's
    // "running" marker to the DB the moment it starts, so after a crash/
    // reload that step would otherwise linger as "running" forever (or, if
    // unpersisted, vanish from the trace). Flip non-terminal steps to
    // failed so History tells the truth about which step was interrupted.
    let reconciledSteps: string | null = null;
    if (row.step_results_json) {
      try {
        const sr = JSON.parse(row.step_results_json) as Record<
          string,
          { status: string; error: string | null; completedAt: string | null }
        >;
        let changed = false;
        for (const stepId of Object.keys(sr)) {
          const s = sr[stepId];
          if (
            s &&
            (s.status === "running" || s.status === "pending" || s.status === "waiting_input")
          ) {
            s.status = "failed";
            s.error = ORPHAN_MSG;
            s.completedAt = new Date().toISOString();
            changed = true;
          }
        }
        if (changed) reconciledSteps = JSON.stringify(sr);
      } catch {
        // Unparseable step results — leave them; the run row is still reaped.
      }
    }

    if (reconciledSteps !== null) {
      await dbExecute(
        `UPDATE workflow_runs
           SET status = 'failed', completed_at = datetime('now'),
               error = ?, duration_ms = ?, step_results_json = ?
         WHERE id = ?`,
        [ORPHAN_MSG, durationMs, reconciledSteps, row.id],
      );
    } else {
      await dbExecute(
        `UPDATE workflow_runs
           SET status = 'failed', completed_at = datetime('now'),
               error = ?, duration_ms = ?
         WHERE id = ?`,
        [ORPHAN_MSG, durationMs, row.id],
      );
    }
  }
  return orphans.length;
}

export async function cleanWorkflowConversations(olderThanDays: number): Promise<void> {
  const cutoff = new Date(Date.now() - olderThanDays * 86400000).toISOString();
  const rows = await dbSelect<{ conversation_id: string }>(
    "SELECT conversation_id FROM workflow_conversations WHERE created_at < ?",
    [cutoff],
  );
  if (rows.length === 0) return;

  const ids = rows.map((r) => r.conversation_id);
  const placeholders = ids.map(() => "?").join(",");

  await dbExecute(
    `DELETE FROM conversations WHERE id IN (${placeholders})`,
    ids,
  );
  await dbExecute(
    "DELETE FROM workflow_conversations WHERE created_at < ?",
    [cutoff],
  );
}

function rowToWorkflow(row: { definition_json: unknown }): WorkflowDefinition {
  // Defensive: tauri-plugin-sql surfaces BLOB-stored columns as Uint8Array
  // (e.g. if a row was written via SQL `readfile()`). Coerce so a
  // mistakenly-BLOB definition still parses instead of crashing the page.
  const raw = row.definition_json;
  let text: string;
  if (typeof raw === "string") {
    text = raw;
  } else if (raw instanceof Uint8Array) {
    text = new TextDecoder().decode(raw);
  } else if (Array.isArray(raw)) {
    text = new TextDecoder().decode(new Uint8Array(raw as number[]));
  } else {
    throw new Error(`Workflow definition_json has unexpected type: ${typeof raw}`);
  }
  return JSON.parse(text);
}

function rowToRun(row: any): WorkflowRun {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    workflowVersion: row.workflow_version,
    status: row.status,
    triggeredBy: row.triggered_by,
    variables: JSON.parse(row.variables_json || "{}"),
    stepResults: JSON.parse(row.step_results_json || "{}"),
    startedAt: row.started_at,
    completedAt: row.completed_at,
    error: row.error,
    durationMs: row.duration_ms,
  };
}
