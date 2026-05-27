import { Dialog } from "@/components/ui/dialog";
import type { ToolExecutionLog } from "@/types";

function formatMs(ms: number | null) {
  if (ms == null) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

function prettyJson(json: string | null): string {
  if (!json) return "";
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}

interface ToolDetailDialogProps {
  exec: ToolExecutionLog;
  onClose: () => void;
}

export function ToolDetailDialog({ exec, onClose }: ToolDetailDialogProps) {
  return (
    <Dialog open onClose={onClose} title="Tool Call Detail" className="max-w-2xl w-full">
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
          <div className="flex gap-2">
            <span className="text-muted-foreground">Tool:</span>
            <span className="font-mono text-xs">{exec.toolName}</span>
          </div>
          <div className="flex gap-2">
            <span className="text-muted-foreground">Server:</span>
            <span className="font-mono text-xs">{exec.serverId ?? "—"}</span>
          </div>
          <div className="flex gap-2">
            <span className="text-muted-foreground">Status:</span>
            <span className={exec.status === "completed" ? "text-green-600 dark:text-green-400" : "text-destructive"}>
              {exec.status === "completed" ? "✓ Completed" : `✗ ${exec.status ?? "unknown"}`}
            </span>
          </div>
          <div className="flex gap-2">
            <span className="text-muted-foreground">Duration:</span>
            <span>{formatMs(exec.durationMs)}</span>
          </div>
          <div className="flex gap-2">
            <span className="text-muted-foreground">Sandbox:</span>
            <span className={exec.sandboxDecision === "denied" ? "text-destructive" : ""}>
              {exec.sandboxDecision ?? "—"}
            </span>
          </div>
          <div className="flex gap-2">
            <span className="text-muted-foreground">Agent:</span>
            <span>{exec.agentName ?? "—"}</span>
          </div>
          <div className="flex gap-2">
            <span className="text-muted-foreground">Workflow:</span>
            <span>{exec.workflowName ?? "—"}</span>
          </div>
          <div className="flex gap-2 col-span-2">
            <span className="text-muted-foreground">Time:</span>
            <span className="text-xs">{new Date(exec.createdAt).toLocaleString()}</span>
          </div>
        </div>

        {exec.error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive whitespace-pre-wrap break-words">
            {exec.error}
          </div>
        )}

        <div>
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">Arguments</p>
          <pre className="max-h-60 overflow-auto rounded-lg border border-border bg-muted/30 p-3 text-xs whitespace-pre-wrap break-words">
            {prettyJson(exec.argsJson) || "(none)"}
          </pre>
        </div>

        <div>
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">Result</p>
          <pre className="max-h-60 overflow-auto rounded-lg border border-border bg-muted/30 p-3 text-xs whitespace-pre-wrap break-words">
            {prettyJson(exec.resultJson) || "(none)"}
          </pre>
        </div>
      </div>
    </Dialog>
  );
}
