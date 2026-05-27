import { useState } from "react";
import { useSchedule } from "@/hooks/use-schedule";
import { useAgentStore } from "@/stores/agent-store";
import { ScheduleJobCard } from "./schedule-job-card";
import { ScheduleEditorDialog } from "./schedule-editor-dialog";
import type { ScheduledJob } from "@/types";

export function SchedulesPage() {
  const { jobs, runningJobIds, createJob, deleteJob, toggleJob, runNow } = useSchedule();
  const configs = useAgentStore((s) => s.configs);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingJob, setEditingJob] = useState<ScheduledJob | null>(null);

  function agentName(agentId: string): string {
    return configs.find((c) => c.id === agentId)?.name ?? agentId;
  }

  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Scheduled Agents</h1>
        <button
          onClick={() => { setEditingJob(null); setEditorOpen(true); }}
          className="rounded-lg bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary-hover transition-colors"
        >
          + Create Schedule
        </button>
      </div>

      <div className="max-w-3xl">
        {jobs.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
            <svg className="h-10 w-10 text-muted-foreground/40" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p className="text-sm text-muted-foreground">
              No scheduled agents yet.{" "}
              <button
                onClick={() => { setEditingJob(null); setEditorOpen(true); }}
                className="text-primary underline underline-offset-2 hover:no-underline"
              >
                Create one
              </button>
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {jobs.map((job) => (
              <ScheduleJobCard
                key={job.id}
                job={job}
                isRunning={runningJobIds.includes(job.id)}
                agentName={agentName(job.agentId)}
                onEdit={() => { setEditingJob(job); setEditorOpen(true); }}
                onToggle={() => toggleJob(job.id, !job.enabled)}
                onRunNow={() => runNow(job.id)}
                onDelete={() => deleteJob(job.id)}
              />
            ))}
          </div>
        )}
      </div>

      <ScheduleEditorDialog
        open={editorOpen}
        onClose={() => { setEditorOpen(false); setEditingJob(null); }}
        job={editingJob}
        onSave={async (params) => { await createJob(params); }}
      />
    </div>
  );
}
