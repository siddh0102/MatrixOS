import { useEffect, useMemo, useState } from "react";
import { useParams, useNavigate, useSearch } from "@tanstack/react-router";
import { useWorkflow } from "@/hooks/use-workflow";
import { useWorkflowStore } from "@/stores/workflow-store";
import { TraceViewer } from "./trace-viewer";
import type { WorkflowRun } from "@/types";

export function RunHistoryPage() {
  const { id } = useParams({ from: "/workflows/$id/history" });
  const search = useSearch({ from: "/workflows/$id/history" }) as { runId?: string };
  const navigate = useNavigate();
  const { loadRunHistory, cancelRun, resumeRun } = useWorkflow();
  const [resuming, setResuming] = useState(false);
  // Subscribe to the raw arrays (stable refs unless the store actually
  // mutates them). Derive the filtered list via useMemo — never inside
  // the Zustand selector, otherwise each render produces a new reference
  // and the subscriber thinks the state changed.
  const allWorkflows = useWorkflowStore((s) => s.workflows);
  const allRuns = useWorkflowStore((s) => s.runs);
  const workflow = useMemo(
    () => allWorkflows.find((w) => w.id === id),
    [allWorkflows, id],
  );
  const runs = useMemo(
    () => allRuns.filter((r) => r.workflowId === id),
    [allRuns, id],
  );
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  useEffect(() => {
    loadRunHistory(id);
  }, [id, loadRunHistory]);

  // Auto-select: prefer ?runId= from the URL, else the most-recent run.
  useEffect(() => {
    if (selectedRunId !== null) return;
    if (search.runId && runs.some((r) => r.id === search.runId)) {
      setSelectedRunId(search.runId);
    } else if (runs.length > 0) {
      setSelectedRunId(runs[0].id);
    }
  }, [runs, search.runId, selectedRunId]);

  // Resolve the selected run from the live runs array so its step
  // results update as the executor writes to the store.
  const selectedRun: WorkflowRun | null = useMemo(
    () => runs.find((r) => r.id === selectedRunId) ?? null,
    [runs, selectedRunId],
  );

  if (!workflow) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-muted-foreground">Workflow not found</p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-auto p-6 gap-4">
      <div className="flex items-center gap-3">
        <button
          onClick={() => navigate({ to: "/workflows/$id", params: { id } })}
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          &larr; Back to Editor
        </button>
        <h1 className="text-lg font-semibold text-center">Run History — {workflow.name}</h1>
      </div>

      {runs.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-8">No runs yet.</p>
      ) : (
        <div className="flex gap-4 flex-1 overflow-hidden">
          <div className="w-80 flex flex-col gap-1 overflow-auto border-r border-border pr-4">
            {runs.map((run) => (
              <button
                key={run.id}
                onClick={() => setSelectedRunId(run.id)}
                className={`rounded-lg border p-3 text-left transition-colors ${
                  selectedRunId === run.id ? "border-primary bg-primary/5" : "border-border hover:bg-accent"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className={`text-xs font-medium ${
                    run.status === "completed" ? "text-green-600" :
                    run.status === "failed" ? "text-destructive" :
                    run.status === "running" ? "text-yellow-600" :
                    "text-muted-foreground"
                  }`}>
                    {run.status}
                  </span>
                  <span className="text-xs text-muted-foreground text-center">{run.triggeredBy}</span>
                </div>
                <p className="text-xs text-muted-foreground mt-1 text-center">
                  {new Date(run.startedAt).toLocaleString()}
                </p>
                {run.durationMs != null && (
                  <p className="text-xs text-muted-foreground text-center">
                    Duration: {run.durationMs >= 1000 ? `${(run.durationMs / 1000).toFixed(1)}s` : `${run.durationMs}ms`}
                  </p>
                )}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-auto">
            {selectedRun ? (
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-medium text-center">Trace</h2>
                  {selectedRun.status === "running" && (
                    <button
                      onClick={() => cancelRun(selectedRun.id)}
                      className="text-xs text-destructive hover:underline"
                    >
                      Cancel
                    </button>
                  )}
                  {(selectedRun.status === "failed" || selectedRun.status === "cancelled") && (
                    <button
                      disabled={resuming}
                      onClick={async () => {
                        setResuming(true);
                        try {
                          await resumeRun(selectedRun.id, (newRun) =>
                            setSelectedRunId(newRun.id),
                          );
                        } finally {
                          setResuming(false);
                        }
                      }}
                      className="text-xs text-primary hover:underline disabled:opacity-50"
                      title="Start a new run that reuses completed steps and re-runs from the failed step onward"
                    >
                      {resuming ? "Resuming…" : "Resume from failed step"}
                    </button>
                  )}
                </div>
                {selectedRun.error && (
                  <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3">
                    <p className="text-xs text-destructive text-center">{selectedRun.error}</p>
                  </div>
                )}
                <TraceViewer run={selectedRun} workflow={workflow} />
              </div>
            ) : (
              <p className="text-sm text-muted-foreground text-center py-8">Select a run to view its trace.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
