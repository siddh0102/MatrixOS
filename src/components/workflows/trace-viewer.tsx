import { useEffect, useMemo, useState } from "react";
import type {
  WorkflowRun,
  StepRunResult,
  WorkflowDefinition,
  AgentTaskConfig,
  AppEvent,
} from "@/types";
import { eventBus } from "@/orchestration/event-bus";
import { listAgentConfigs } from "@/memory/agent-store-sql";
import { getRunCalls, type TurnRow } from "@/memory/telemetry-queries";
import type { LLMCallLog } from "@/types";

interface TraceViewerProps {
  run: WorkflowRun;
  /** Definition for the run, used to map each step to its agent so the
   *  delegation fan-out can be drawn under delegating agent_task steps. */
  workflow?: WorkflowDefinition;
}

interface AgentMeta {
  name: string;
  delegationEnabled: boolean;
  allowedAgentIds: string[];
}

type DelegStatus = "running" | "completed" | "failed";
// delegatorId → (targetAgentId → status)
type DelegationState = Map<string, Map<string, { status: DelegStatus; error?: string }>>;

function formatDuration(ms: number | null): string {
  if (ms == null) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function statusIcon(status: string): string {
  switch (status) {
    case "completed": return "✓";
    case "failed": return "✗";
    case "skipped": return "—";
    case "running": return "○";
    default: return "○";
  }
}

function statusColor(status: string): string {
  switch (status) {
    case "completed": return "text-green-600";
    case "failed": return "text-destructive";
    case "skipped": return "text-muted-foreground";
    case "running": return "text-yellow-600";
    default: return "text-muted-foreground";
  }
}

export function TraceViewer({ run, workflow }: TraceViewerProps) {
  const results = Object.values(run.stepResults) as StepRunResult[];

  // Agent metadata for the delegation fan-out.
  const [agentMeta, setAgentMeta] = useState<Map<string, AgentMeta>>(new Map());
  useEffect(() => {
    let cancelled = false;
    listAgentConfigs()
      .then((configs) => {
        if (cancelled) return;
        const m = new Map<string, AgentMeta>();
        for (const c of configs) {
          m.set(c.id, {
            name: c.name,
            delegationEnabled: !!c.delegationConfig?.enabled,
            allowedAgentIds: c.delegationConfig?.allowedAgentIds ?? [],
          });
        }
        setAgentMeta(m);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Live delegation status. Reset when the viewed run changes so a historical
  // run doesn't inherit another run's live state.
  const [delegation, setDelegation] = useState<DelegationState>(new Map());
  useEffect(() => {
    setDelegation(new Map());
    const update = (
      delegatorId: string,
      targetAgentId: string,
      status: DelegStatus,
      error?: string,
    ) => {
      setDelegation((prev) => {
        const next = new Map(prev);
        const inner = new Map(next.get(delegatorId) ?? []);
        inner.set(targetAgentId, { status, error });
        next.set(delegatorId, inner);
        return next;
      });
    };
    const subStart = eventBus.on(
      "agent:delegation_started",
      (e: AppEvent<{ delegatorId: string; targetAgentId: string }>) =>
        update(e.payload.delegatorId, e.payload.targetAgentId, "running"),
    );
    const subDone = eventBus.on(
      "agent:delegation_completed",
      (e: AppEvent<{ delegatorId: string; targetAgentId: string; ok: boolean; error?: string }>) =>
        update(
          e.payload.delegatorId,
          e.payload.targetAgentId,
          e.payload.ok ? "completed" : "failed",
          e.payload.error,
        ),
    );
    return () => { subStart.unsubscribe(); subDone.unsubscribe(); };
  }, [run.id]);

  // stepId → agentId (only for agent_task steps).
  const stepAgent = useMemo(() => {
    const m = new Map<string, string>();
    for (const step of workflow?.steps ?? []) {
      if (step.config.type === "agent_task") {
        m.set(step.id, (step.config as AgentTaskConfig).agentId);
      }
    }
    return m;
  }, [workflow]);

  // Per-call telemetry for the run (LLD 3.2). Loaded once per run; persisted
  // rows so it survives reload (unlike the live delegation state above).
  const [runCalls, setRunCalls] = useState<{ turns: TurnRow[]; calls: LLMCallLog[] }>({
    turns: [],
    calls: [],
  });
  useEffect(() => {
    let cancelled = false;
    getRunCalls(run.id)
      .then((rc) => {
        if (cancelled) return;
        setRunCalls(rc);
        // Rebuild delegation status from PERSISTED turns so the fan-out tags
        // survive navigating away and back (live events are missed while the
        // view is unmounted). A delegated child turn carries parent_request_id
        // (-> the delegator's turn id -> the delegator agent) + its own status.
        const turnAgent = new Map(rc.turns.map((t) => [t.id, t.agentId]));
        setDelegation((prev) => {
          const next = new Map(prev);
          for (const t of rc.turns) {
            if (!t.parentRequestId || !t.agentId) continue;
            const delegator = turnAgent.get(t.parentRequestId);
            if (!delegator) continue;
            const inner = new Map(next.get(delegator) ?? []);
            // Don't clobber a live status already present (live wins).
            if (!inner.has(t.agentId)) {
              inner.set(t.agentId, { status: t.status === "error" ? "failed" : "completed" });
            }
            next.set(delegator, inner);
          }
          return next;
        });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [run.id]);

  // Lite live activity log per step (heartbeat: status + tool-call names).
  // In-memory, reset on run change. Shows "something is happening" on a running
  // step; completed steps still show their final output below.
  const [activity, setActivity] = useState<Map<string, string[]>>(new Map());
  useEffect(() => {
    setActivity(new Map());
    const sub = eventBus.on(
      "workflow:step_activity",
      (e: AppEvent<{ runId: string; stepId: string; kind: string; text: string }>) => {
        if (e.payload.runId !== run.id) return;
        setActivity((prev) => {
          const next = new Map(prev);
          const arr = [...(next.get(e.payload.stepId) ?? [])];
          arr.push(e.payload.kind === "tool" ? `→ ${e.payload.text}` : e.payload.text);
          if (arr.length > 50) arr.shift();
          next.set(e.payload.stepId, arr);
          return next;
        });
      },
    );
    return () => sub.unsubscribe();
  }, [run.id]);

  const spanMaps = useMemo(() => {
    const callsByRequest = new Map<string, LLMCallLog[]>();
    for (const c of runCalls.calls) {
      const arr = callsByRequest.get(c.requestId) ?? [];
      arr.push(c);
      callsByRequest.set(c.requestId, arr);
    }
    const childrenByParent = new Map<string, TurnRow[]>();
    const turnsByStep = new Map<string, TurnRow[]>();
    for (const t of runCalls.turns) {
      if (t.stepId) {
        const arr = turnsByStep.get(t.stepId) ?? [];
        arr.push(t);
        turnsByStep.set(t.stepId, arr);
      }
      if (t.parentRequestId) {
        const arr = childrenByParent.get(t.parentRequestId) ?? [];
        arr.push(t);
        childrenByParent.set(t.parentRequestId, arr);
      }
    }
    return { callsByRequest, childrenByParent, turnsByStep };
  }, [runCalls]);

  if (results.length === 0) {
    return <p className="text-sm text-muted-foreground text-center py-4">No step results yet.</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      {results.map((result) => {
        const agentId = stepAgent.get(result.stepId);
        const meta = agentId ? agentMeta.get(agentId) : undefined;
        const fanout =
          meta?.delegationEnabled && meta.allowedAgentIds.length > 0 ? (
            <DelegationFanout
              allowedAgentIds={meta.allowedAgentIds}
              statuses={agentId ? delegation.get(agentId) : undefined}
              agentMeta={agentMeta}
            />
          ) : null;
        const stepTurns = spanMaps.turnsByStep.get(result.stepId) ?? [];
        const spans =
          stepTurns.length > 0 ? (
            <details className="mt-2">
              <summary className="text-xs text-muted-foreground cursor-pointer text-center">
                Show LLM calls
              </summary>
              <div className="mt-1 flex flex-col gap-1">
                {stepTurns.map((t) => (
                  <TurnSpans
                    key={t.id}
                    turn={t}
                    maps={spanMaps}
                    agentMeta={agentMeta}
                  />
                ))}
              </div>
            </details>
          ) : null;
        return (
          <StepTrace
            key={result.stepId}
            result={result}
            fanout={fanout}
            spans={spans}
            activity={activity.get(result.stepId)}
          />
        );
      })}
    </div>
  );
}

function StepTrace({
  result,
  fanout,
  spans,
  activity,
}: {
  result: StepRunResult;
  fanout?: React.ReactNode;
  spans?: React.ReactNode;
  activity?: string[];
}) {
  const isRunning = result.status === "running";
  return (
    <div
      className={`rounded-lg border p-3 ${
        isRunning
          ? "border-yellow-600/50 bg-yellow-600/5"
          : "border-border"
      }`}
    >
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <span
            className={`font-mono text-sm ${statusColor(result.status)} ${
              isRunning ? "animate-pulse" : ""
            }`}
          >
            {statusIcon(result.status)}
          </span>
          <span className="text-sm font-medium text-center">{result.stepId}</span>
          {isRunning && (
            <span className="rounded-full bg-yellow-600/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-yellow-700">
              In progress
            </span>
          )}
        </div>
        <span className="text-xs text-muted-foreground text-center">
          {formatDuration(result.durationMs)}
        </span>
      </div>

      {result.tokenUsage && (
        <p className="text-xs text-muted-foreground text-center">
          Tokens: {formatTokens(result.tokenUsage.inputTokens)} in / {formatTokens(result.tokenUsage.outputTokens)} out
        </p>
      )}

      {result.error && (
        <p className="text-xs text-destructive mt-1 text-center">{result.error}</p>
      )}

      {activity && activity.length > 0 && (
        <div className="mt-2 rounded border border-border bg-muted/30 p-2">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1 flex items-center justify-center gap-1">
            Activity {isRunning && <span className="animate-pulse text-yellow-600">●</span>}
          </p>
          <div className="flex flex-col gap-0.5 max-h-32 overflow-auto font-mono text-[11px] text-muted-foreground">
            {activity.slice(-12).map((line, i) => (
              <div key={i}>{line}</div>
            ))}
          </div>
        </div>
      )}

      {result.output != null && result.status === "completed" && (
        <details className="mt-2">
          <summary className="text-xs text-muted-foreground cursor-pointer text-center">Show output</summary>
          <pre className="mt-1 text-xs bg-muted rounded p-2 overflow-auto max-h-32">
            {typeof result.output === "string" ? result.output : JSON.stringify(result.output, null, 2)}
          </pre>
        </details>
      )}

      {spans}

      {fanout}
    </div>
  );
}

/**
 * Per-call spans for one turn (LLD 3.2): one row per LLM round, then any
 * delegated child turns nested beneath (via parent_request_id), recursively.
 */
function TurnSpans({
  turn,
  maps,
  agentMeta,
  depth = 0,
}: {
  turn: TurnRow;
  maps: {
    callsByRequest: Map<string, LLMCallLog[]>;
    childrenByParent: Map<string, TurnRow[]>;
  };
  agentMeta: Map<string, AgentMeta>;
  depth?: number;
}) {
  const calls = maps.callsByRequest.get(turn.id) ?? [];
  const children = maps.childrenByParent.get(turn.id) ?? [];
  const name = turn.agentId ? agentMeta.get(turn.agentId)?.name ?? turn.agentId : null;
  return (
    <div className={depth > 0 ? "ml-3 border-l border-dashed border-purple-300 dark:border-purple-700 pl-2" : ""}>
      {depth > 0 && name && (
        <p className="text-[10px] uppercase tracking-wide text-purple-500/80">↳ {name}</p>
      )}
      {calls.map((c) => <CallRow key={c.id} call={c} />)}
      {children.map((ch) => (
        <TurnSpans key={ch.id} turn={ch} maps={maps} agentMeta={agentMeta} depth={depth + 1} />
      ))}
    </div>
  );
}

function CallRow({ call }: { call: LLMCallLog }) {
  const bad = call.finishReason != null && call.finishReason !== "stop" && call.finishReason !== "tool_calls";
  return (
    <div className="flex items-center gap-2 text-[11px] font-mono">
      <span className="text-muted-foreground">#{call.turnIndex}</span>
      <span className="text-muted-foreground">ttft {formatDuration(call.ttftMs)}</span>
      <span>{formatDuration(call.latencyMs)}</span>
      <span className="text-muted-foreground">
        {formatTokens(call.inputTokens ?? 0)}↑ {formatTokens(call.outputTokens ?? 0)}↓
      </span>
      {call.finishReason && (
        <span className={bad ? "text-destructive" : "text-green-600"}>{call.finishReason}</span>
      )}
    </div>
  );
}

/**
 * Read-only fan-out of the sub-agents a delegating step reaches, mirroring the
 * editor's delegation overlay. Shows live per-sub-agent status when the run is
 * active (idle → delegating… → done/failed).
 */
function DelegationFanout({
  allowedAgentIds,
  statuses,
  agentMeta,
}: {
  allowedAgentIds: string[];
  statuses?: Map<string, { status: DelegStatus; error?: string }>;
  agentMeta: Map<string, AgentMeta>;
}) {
  return (
    <div className="mt-2 ml-4 border-l-2 border-dashed border-purple-300 dark:border-purple-700 pl-3 flex flex-col gap-1">
      <p className="text-[10px] uppercase tracking-wide text-purple-500/80">Delegates to</p>
      {allowedAgentIds.map((id) => {
        const s = statuses?.get(id);
        const name = agentMeta.get(id)?.name ?? id;
        const { icon, color, label, pulse } = delegRowStyle(s?.status);
        return (
          <div key={id} className="flex items-center gap-2">
            <span className={`font-mono text-xs ${color} ${pulse ? "animate-pulse" : ""}`}>{icon}</span>
            <span className="text-xs text-center">{name}</span>
            {label && (
              <span className={`text-[10px] ${color}`}>{label}</span>
            )}
            {s?.status === "failed" && s.error && (
              <span className="text-[10px] text-destructive truncate max-w-[200px]" title={s.error}>
                — {s.error}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function delegRowStyle(status?: DelegStatus): {
  icon: string;
  color: string;
  label: string;
  pulse: boolean;
} {
  switch (status) {
    case "running":
      return { icon: "○", color: "text-yellow-600", label: "delegating…", pulse: true };
    case "completed":
      return { icon: "✓", color: "text-green-600", label: "", pulse: false };
    case "failed":
      return { icon: "✗", color: "text-destructive", label: "", pulse: false };
    default:
      return { icon: "○", color: "text-muted-foreground", label: "", pulse: false };
  }
}
