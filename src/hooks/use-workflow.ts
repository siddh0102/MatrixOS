import { useCallback } from "react";
import { useWorkflowStore } from "@/stores/workflow-store";
import { workflowExecutor } from "@/orchestration/workflow-executor";
import { triggerManager } from "@/orchestration/workflow-triggers";
import {
  saveWorkflow,
  deleteWorkflow as deleteWorkflowDB,
  listWorkflowRuns,
  getWorkflowRun,
} from "@/memory/workflow-store";
import type { WorkflowDefinition, WorkflowRun, StepRunResult } from "@/types";
import { nanoid } from "nanoid";
import { isoNow } from "@/lib/utils";

export function useWorkflow() {
  const workflows = useWorkflowStore((s) => s.workflows);
  const runs = useWorkflowStore((s) => s.runs);

  const createWorkflow = useCallback(async (name: string, description: string): Promise<WorkflowDefinition> => {
    const workflow: WorkflowDefinition = {
      id: nanoid(),
      name,
      description,
      version: 1,
      steps: [],
      edges: [],
      variables: [],
      triggers: [{ id: nanoid(), type: "manual", enabled: true, config: { type: "manual" } }],
      errorStrategy: "stop",
      maxDurationMs: 300_000,
      createdAt: isoNow(),
      updatedAt: isoNow(),
    };
    await saveWorkflow(workflow);
    useWorkflowStore.getState().addWorkflow(workflow);
    return workflow;
  }, []);

  const updateWorkflow = useCallback(async (workflow: WorkflowDefinition): Promise<void> => {
    const updated = { ...workflow, updatedAt: isoNow() };
    await saveWorkflow(updated);
    useWorkflowStore.getState().updateWorkflow(workflow.id, updated);
    triggerManager.reloadTriggers(updated);
  }, []);

  const publishWorkflow = useCallback(async (workflow: WorkflowDefinition): Promise<void> => {
    const published = { ...workflow, version: workflow.version + 1, updatedAt: isoNow() };
    await saveWorkflow(published);
    useWorkflowStore.getState().updateWorkflow(workflow.id, published);
    triggerManager.reloadTriggers(published);
  }, []);

  const deleteWorkflow = useCallback(async (id: string): Promise<void> => {
    triggerManager.unregisterTriggers(id);
    await deleteWorkflowDB(id);
    useWorkflowStore.getState().removeWorkflow(id);
  }, []);

  const runWorkflow = useCallback(
    async (
      workflowId: string,
      variables?: Record<string, unknown>,
      onStarted?: (run: WorkflowRun) => void,
    ) => {
      const workflow = useWorkflowStore.getState().workflows.find((w) => w.id === workflowId);
      if (!workflow) throw new Error("Workflow not found");
      return workflowExecutor.execute(workflow, "manual", variables, undefined, onStarted);
    },
    [],
  );

  const cancelRun = useCallback((runId: string) => {
    workflowExecutor.cancel(runId);
  }, []);

  /**
   * Resume a failed/cancelled run from where it stopped. Starts a NEW run
   * that reuses the prior run's variables and its successfully-completed
   * (and skipped) step results, so only the failed step and everything
   * downstream re-execute. Uses the workflow's current definition.
   */
  const resumeRun = useCallback(
    async (failedRunId: string, onStarted?: (run: WorkflowRun) => void) => {
      const prior = await getWorkflowRun(failedRunId);
      if (!prior) throw new Error("Run not found");
      const workflow = useWorkflowStore
        .getState()
        .workflows.find((w) => w.id === prior.workflowId);
      if (!workflow) throw new Error("Workflow not found");

      // Seed only terminally-successful steps; failed/running/pending ones
      // are dropped so they re-run.
      const seededResults: Record<string, StepRunResult> = {};
      for (const [stepId, res] of Object.entries(prior.stepResults)) {
        if (res.status === "completed" || res.status === "skipped") {
          seededResults[stepId] = res;
        }
      }

      return workflowExecutor.execute(
        workflow,
        "manual",
        prior.variables,
        undefined,
        onStarted,
        { stepResults: seededResults },
      );
    },
    [],
  );

  const provideInput = useCallback((runId: string, stepId: string, value: unknown) => {
    workflowExecutor.provideHumanInput(runId, stepId, value);
  }, []);

  const loadRunHistory = useCallback(async (workflowId: string) => {
    const runs = await listWorkflowRuns(workflowId);
    useWorkflowStore.getState().setRuns(runs);
  }, []);

  return {
    workflows,
    runs,
    createWorkflow,
    updateWorkflow,
    publishWorkflow,
    deleteWorkflow,
    runWorkflow,
    cancelRun,
    resumeRun,
    provideInput,
    loadRunHistory,
  };
}
