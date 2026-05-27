import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useWorkflow } from "@/hooks/use-workflow";
import { WorkflowCard } from "./workflow-card";
import { WorkflowCreateDialog } from "./workflow-create-dialog";

export function WorkflowListPage() {
  const navigate = useNavigate();
  const { workflows, runs, createWorkflow, deleteWorkflow, runWorkflow } = useWorkflow();
  const [createOpen, setCreateOpen] = useState(false);

  function getLastRun(workflowId: string) {
    return runs.find((r) => r.workflowId === workflowId) ?? null;
  }

  async function handleCreate(name: string, description: string) {
    const wf = await createWorkflow(name, description);
    navigate({ to: "/workflows/$id", params: { id: wf.id } });
  }

  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Workflows</h1>
        <button
          onClick={() => setCreateOpen(true)}
          className="rounded-lg bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          + Create Workflow
        </button>
      </div>

      {workflows.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
          <svg className="h-10 w-10 text-muted-foreground/40" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
          </svg>
          <p className="text-sm text-muted-foreground">
            No workflows yet.{" "}
            <button
              onClick={() => setCreateOpen(true)}
              className="text-primary underline underline-offset-2 hover:no-underline"
            >
              Create one
            </button>
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {workflows.map((wf) => (
            <WorkflowCard
              key={wf.id}
              workflow={wf}
              lastRun={getLastRun(wf.id)}
              onOpen={() => navigate({ to: "/workflows/$id", params: { id: wf.id } })}
              onRunNow={() => {
                // Fire-and-forget — `runWorkflow` resolves only when the
                // run finishes. We navigate on the onStarted callback so
                // the user lands on the live trace immediately.
                runWorkflow(wf.id, undefined, (run) => {
                  navigate({
                    to: "/workflows/$id/history",
                    params: { id: wf.id },
                    search: { runId: run.id },
                  });
                }).catch(() => {
                  // Errors surface in the trace view; nothing to do here.
                });
              }}
              onHistory={() => navigate({ to: "/workflows/$id/history", params: { id: wf.id } })}
              onDelete={() => deleteWorkflow(wf.id)}
            />
          ))}
        </div>
      )}

      <WorkflowCreateDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreate={handleCreate}
      />
    </div>
  );
}
