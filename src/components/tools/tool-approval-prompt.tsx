import { useEffect, useState } from "react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { eventBus } from "@/orchestration/event-bus";
import { approvalGate } from "@/tools/tool-approval";
import type { ApprovalRequest } from "@/types";

/**
 * Global listener for tool-approval requests. Without this component,
 * any agent whose `approvalConfig.mode` is `"always-ask"` will block on
 * every tool call until the 60-second default times out — the model
 * then sees `{"error":"Tool X was timed_out"}` and frequently
 * hallucinates a success message anyway.
 *
 * Subscribes to:
 *   - `tool:approval_requested` to enqueue a new request
 *   - `tool:approval_resolved`  to drain requests resolved elsewhere
 *     (timeout, override) so the modal doesn't show stale items.
 */
export function ToolApprovalPrompt() {
  const [queue, setQueue] = useState<ApprovalRequest[]>([]);

  useEffect(() => {
    const reqSub = eventBus.on<{ request: ApprovalRequest }>(
      "tool:approval_requested",
      (event) => {
        setQueue((q) => [...q, event.payload.request]);
      },
    );
    const resSub = eventBus.on<{ requestId: string }>(
      "tool:approval_resolved",
      (event) => {
        setQueue((q) => q.filter((r) => r.id !== event.payload.requestId));
      },
    );
    return () => {
      reqSub.unsubscribe();
      resSub.unsubscribe();
    };
  }, []);

  const current = queue[0] ?? null;
  if (!current) return null;

  function approve() {
    approvalGate.approve(current!.id);
    // Optimistic: resolved event will also fire and dedupe.
    setQueue((q) => q.filter((r) => r.id !== current!.id));
  }

  function reject() {
    approvalGate.reject(current!.id);
    setQueue((q) => q.filter((r) => r.id !== current!.id));
  }

  // Pretty-print args. Truncate long strings (e.g. write_file contents)
  // so the dialog stays scannable; the full value still goes to the tool.
  const argEntries = Object.entries(current.args).map(([k, v]) => {
    let display: string;
    if (typeof v === "string") {
      display = v.length > 400 ? `${v.slice(0, 400)}…  (${v.length} chars)` : v;
    } else {
      const json = JSON.stringify(v, null, 2);
      display = json.length > 600 ? `${json.slice(0, 600)}…` : json;
    }
    return { key: k, display };
  });

  return (
    <Dialog open onClose={reject} title="Tool call needs approval">
      <div className="flex flex-col gap-3">
        <div className="rounded-lg border border-border bg-muted/30 p-3">
          <p className="text-xs text-muted-foreground uppercase tracking-wide">
            Tool
          </p>
          <p className="font-mono text-sm">
            {current.serverName} / {current.toolName}
          </p>
        </div>

        <div className="rounded-lg border border-border bg-muted/30 p-3">
          <p className="mb-2 text-xs text-muted-foreground uppercase tracking-wide">
            Arguments
          </p>
          {argEntries.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">
              (no arguments)
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {argEntries.map(({ key, display }) => (
                <div key={key}>
                  <p className="font-mono text-xs text-muted-foreground">
                    {key}
                  </p>
                  <pre className="font-mono text-xs whitespace-pre-wrap break-all max-h-40 overflow-auto">
                    {display}
                  </pre>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={reject}>
            Reject
          </Button>
          <Button size="sm" onClick={approve}>
            Approve
          </Button>
        </div>

        {queue.length > 1 && (
          <p className="text-xs text-muted-foreground">
            {queue.length - 1} more pending after this.
          </p>
        )}
      </div>
    </Dialog>
  );
}
