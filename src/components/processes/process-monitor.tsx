import { useEffect, useRef } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import { useProcessManager } from "@/hooks/use-process-manager";
import { useAgentStore } from "@/stores/agent-store";
import { useProcessStore } from "@/stores/process-store";
import { Button } from "@/components/ui/button";
import type { ProcessEvent } from "@/types";

interface ProcessMonitorProps {
  open: boolean;
  onClose: () => void;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatElapsed(startedAt: string | null): string {
  if (!startedAt) return "—";
  const elapsed = Date.now() - new Date(startedAt).getTime();
  if (elapsed < 60_000) return `${Math.round(elapsed / 1000)}s`;
  return `${Math.round(elapsed / 60_000)}m ${Math.round((elapsed % 60_000) / 1000)}s`;
}

export function ProcessMonitor({ open, onClose }: ProcessMonitorProps) {
  const { runningProcesses, queuedProcesses, kill, pause } = useProcessManager();
  const configs = useAgentStore((s) => s.configs);

  // Subscribe to Rust process events for each running process while the
  // monitor is open.  On unmount (or close) all subscriptions are removed.
  const subscriptionIds = useRef<string[]>([]);

  useEffect(() => {
    if (!open) return;

    const processStore = useProcessStore.getState();
    const currentIds = runningProcesses.map((p) => p.id);
    let alive = true;

    async function subscribe(processId: string): Promise<void> {
      const channel = new Channel<ProcessEvent>();
      channel.onmessage = (ev) => {
        switch (ev.type) {
          case "status_changed":
            processStore.updateProcess(ev.process_id, { status: ev.to as import("@/types").ProcessStatus });
            break;
          case "completed":
            processStore.updateProcess(ev.process_id, {
              status: "completed",
              tokenUsage: { inputTokens: ev.input_tokens, outputTokens: ev.output_tokens },
            });
            break;
          case "failed":
            processStore.updateProcess(ev.process_id, { status: "failed", error: ev.error });
            break;
          case "stopped":
            processStore.updateProcess(ev.process_id, { status: "cancelled" });
            break;
          default:
            break;
        }
      };
      try {
        const subId = await invoke<string>("proc_subscribe", { processId, onEvent: channel });
        if (alive) {
          subscriptionIds.current.push(subId);
        } else {
          // Component unmounted before the await resolved — clean up immediately.
          invoke("proc_unsubscribe", { subscriptionId: subId }).catch(() => {});
        }
      } catch {
        // proc_subscribe may fail if the process already finished — non-fatal.
      }
    }

    for (const id of currentIds) {
      void subscribe(id);
    }

    return () => {
      alive = false;
      const ids = subscriptionIds.current.splice(0);
      for (const subId of ids) {
        invoke("proc_unsubscribe", { subscriptionId: subId }).catch(() => {});
      }
    };
  // Re-subscribe when the set of running process IDs changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, runningProcesses.map((p) => p.id).join(",")]);

  if (!open) return null;

  function agentName(agentId: string): string {
    return configs.find((c) => c.id === agentId)?.name ?? agentId;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-lg rounded-xl border border-border bg-card p-6 shadow-lg max-h-[80vh] overflow-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-center flex-1">Process Monitor</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-lg">&times;</button>
        </div>

        <div className="flex items-center justify-center gap-4 mb-4 text-sm text-muted-foreground">
          <span>Running: {runningProcesses.length}</span>
          <span>Queued: {queuedProcesses.length}</span>
        </div>

        {runningProcesses.length > 0 && (
          <div className="mb-4">
            <h3 className="text-xs font-medium text-muted-foreground uppercase mb-2 text-center">Running</h3>
            <div className="flex flex-col gap-2">
              {runningProcesses.map((p) => (
                <div key={p.id} className="rounded-lg border border-border p-3">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm font-medium text-center">{agentName(p.agentId)}</span>
                    <span className="text-xs text-muted-foreground capitalize text-center">{p.priority}</span>
                  </div>
                  <div className="flex items-center justify-center gap-3 text-xs text-muted-foreground mb-2">
                    <span>Tokens: {formatTokens(p.tokenUsage.inputTokens + p.tokenUsage.outputTokens)}/{formatTokens(p.tokenBudget.maxTokensPerSession)}</span>
                    <span>Running: {formatElapsed(p.startedAt)}</span>
                  </div>
                  <div className="flex items-center justify-center gap-2">
                    <Button variant="ghost" size="sm" onClick={() => pause(p.id)}>Pause</Button>
                    <Button variant="ghost" size="sm" onClick={() => kill(p.id)}>Kill</Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {queuedProcesses.length > 0 && (
          <div>
            <h3 className="text-xs font-medium text-muted-foreground uppercase mb-2 text-center">Queued</h3>
            <div className="flex flex-col gap-2">
              {queuedProcesses.map((p) => (
                <div key={p.id} className="rounded-lg border border-border p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-center">#{p.queuePosition}: {agentName(p.agentId)}</span>
                    <span className="text-xs text-muted-foreground capitalize text-center">{p.priority}</span>
                  </div>
                  <div className="flex items-center justify-center gap-2 mt-2">
                    <Button variant="ghost" size="sm" onClick={() => kill(p.id)}>Cancel</Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {runningProcesses.length === 0 && queuedProcesses.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-4">No active processes.</p>
        )}
      </div>
    </div>
  );
}
