import type { BuiltInToolHandler, Tool, ToolExecution } from "@/types";
import type { SandboxConfig } from "@/types";
import type { CallContext } from "@/types/provider";
import { nanoid } from "nanoid";
import { isoNow } from "@/lib/utils";
import { DEFAULT_TOOL_TIMEOUT_MS, TELEMETRY_BLOB_CAP } from "@/lib/constants";
import { eventBus } from "@/orchestration/event-bus";
import { validatePath } from "@/tools/sandbox";
import { appendAudit } from "@/memory/audit-store";
import { saveToolExecution } from "@/memory/telemetry-store";

const PATH_ARG_NAMES = ["path", "filePath", "directory", "target", "file"];

/** Best-effort message from any thrown/rejected value — including RustError
 *  objects from IPC (which are not Error instances). */
function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object") {
    const o = err as Record<string, unknown>;
    const msg = typeof o.message === "string" ? o.message : "";
    const code = typeof o.code === "string" ? o.code : "";
    const joined = [code, msg].filter(Boolean).join(": ");
    if (joined) return joined;
    try { return JSON.stringify(err); } catch { return String(err); }
  }
  return String(err);
}

const builtInHandlers = new Map<string, BuiltInToolHandler>();

export function registerBuiltInHandler(
  toolName: string,
  handler: BuiltInToolHandler,
): void {
  builtInHandlers.set(toolName, handler);
}

export async function executeTool(
  tool: Tool,
  toolCallId: string,
  args: Record<string, unknown>,
  callContext: CallContext,
  sandboxConfig?: SandboxConfig,
  timeoutMs: number = DEFAULT_TOOL_TIMEOUT_MS,
  // Ties the tool record to its turn/run so the dashboard can resolve the agent
  // and workflow. requestId = the calling turn's telemetryId.
  linkage?: { requestId?: string; runId?: string; stepId?: string },
): Promise<ToolExecution> {
  const execution: ToolExecution = {
    id: nanoid(),
    toolId: tool.id,
    toolCallId,
    args,
    result: null,
    error: null,
    status: "executing",
    startedAt: isoNow(),
    completedAt: null,
    durationMs: null,
  };

  eventBus.emit(
    "tool:execution_started",
    { executionId: execution.id, toolName: tool.name },
    "tool-executor",
  );

  const start = Date.now();
  let sandboxDecision: string | null = null;

  try {
    // Sandbox check for built-in filesystem tools
    if (sandboxConfig?.enabled && tool.serverId === "built-in" && tool.tags.includes("filesystem")) {
      for (const [key, value] of Object.entries(args)) {
        if (PATH_ARG_NAMES.includes(key) && typeof value === "string") {
          try {
            validatePath(value, sandboxConfig.allowedPaths);
          } catch (e) {
            sandboxDecision = "denied";
            throw e;
          }
        }
      }
      sandboxDecision = "allowed";
    }

    if (tool.serverId === "built-in") {
      const handler = builtInHandlers.get(tool.name);
      if (!handler) {
        throw new Error(`No handler registered for built-in tool: ${tool.name}`);
      }

      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("Tool execution timed out")),
          timeoutMs,
        ),
      );

      execution.result = await Promise.race([
        handler(args, { callContext }),
        timeoutPromise,
      ]);
      execution.status = "completed";
    } else {
      const { mcpManager } = await import("./mcp-manager");
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("Tool execution timed out")),
          timeoutMs,
        ),
      );
      execution.result = await Promise.race([
        mcpManager.executeToolOnServer(tool.serverId, tool.name, args),
        timeoutPromise,
      ]);
      execution.status = "completed";
    }
  } catch (err) {
    // Rejected IPC errors are plain objects (RustError: {code, message}), not
    // Error instances — String(err) would log "[object Object]" and hide the
    // cause. Pull message/code out explicitly.
    const message = toErrorMessage(err);
    execution.error = message;
    execution.status = message.includes("timed out") ? "timed_out" : "failed";
  }

  execution.completedAt = isoNow();
  (execution as { durationMs: number }).durationMs = Date.now() - start;

  const eventType =
    execution.status === "completed"
      ? ("tool:execution_completed" as const)
      : ("tool:execution_failed" as const);

  eventBus.emit(
    eventType,
    { executionId: execution.id, toolName: tool.name, status: execution.status },
    "tool-executor",
  );

  appendAudit({
    eventType: execution.status === "completed" ? "tool.executed" : "tool.failed",
    actor: "system",
    targetType: "tool",
    targetId: tool.name,
    details: {
      toolCallId,
      serverId: tool.serverId,
      durationMs: execution.durationMs,
    },
  }).catch(() => {});

  // Full record (args/result/sandbox decision) → tool_executions. The audit row
  // above keeps only ids/duration; this is the inspectable detail. Capped so a
  // large write_file/read can't bloat the DB. Fire-and-forget.
  saveToolExecution({
    id: execution.id,
    toolName: tool.name,
    serverId: tool.serverId,
    argsJson: JSON.stringify(args).slice(0, TELEMETRY_BLOB_CAP),
    resultJson:
      execution.result == null
        ? null
        : JSON.stringify(execution.result).slice(0, TELEMETRY_BLOB_CAP),
    error: execution.error,
    status: execution.status,
    durationMs: execution.durationMs,
    sandboxDecision,
    createdAt: execution.completedAt ?? isoNow(),
  }, linkage).catch(() => {});

  return execution;
}
