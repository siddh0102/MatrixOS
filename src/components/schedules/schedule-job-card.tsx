import type { ScheduledJob } from "@/types";
import { describeCron } from "@/scheduling/scheduler";

interface ScheduleJobCardProps {
  job: ScheduledJob;
  isRunning: boolean;
  agentName: string;
  onEdit: () => void;
  onToggle: () => void;
  onRunNow: () => void;
  onDelete: () => void;
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "Never";
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function ScheduleJobCard({
  job,
  isRunning,
  agentName,
  onEdit,
  onToggle,
  onRunNow,
  onDelete,
}: ScheduleJobCardProps) {
  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-foreground truncate">
              {job.prompt.length > 60 ? job.prompt.slice(0, 60) + "…" : job.prompt}
            </span>
            {isRunning && (
              <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
                Running
              </span>
            )}
            {!job.enabled && (
              <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                Paused
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-1">Agent: {agentName}</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        <div className="text-muted-foreground">
          Schedule:{" "}
          <span className="text-foreground font-mono">
            {describeCron(job.cronExpression)}
          </span>
        </div>
        <div className="text-muted-foreground">
          Timezone: <span className="text-foreground">{job.timezone}</span>
        </div>
        <div className="text-muted-foreground">
          Last run:{" "}
          <span className={`text-foreground ${job.lastRunStatus === "error" ? "text-destructive" : ""}`}>
            {formatDateTime(job.lastRunAt)}
            {job.lastRunStatus === "error" && " ✗"}
            {job.lastRunStatus === "success" && " ✓"}
          </span>
        </div>
        <div className="text-muted-foreground">
          Next run:{" "}
          <span className="text-foreground">{formatDateTime(job.nextRunAt)}</span>
        </div>
        {job.lastError && (
          <div className="col-span-2 text-destructive text-[11px] mt-1 truncate">
            Error: {job.lastError}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={onRunNow}
          disabled={isRunning}
          className="rounded px-2.5 py-1 text-xs font-medium bg-primary/10 text-primary hover:bg-primary/20 disabled:opacity-50 disabled:pointer-events-none transition-colors"
        >
          Run Now
        </button>
        <button
          onClick={onEdit}
          className="rounded px-2.5 py-1 text-xs font-medium border border-border hover:bg-muted transition-colors"
        >
          Edit
        </button>
        <button
          onClick={onToggle}
          className="rounded px-2.5 py-1 text-xs font-medium border border-border hover:bg-muted transition-colors"
        >
          {job.enabled ? "Pause" : "Resume"}
        </button>
        <button
          onClick={onDelete}
          className="ml-auto rounded px-2.5 py-1 text-xs font-medium text-muted-foreground hover:text-destructive transition-colors"
        >
          Delete
        </button>
      </div>
    </div>
  );
}
