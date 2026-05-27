import type {
  WorkflowDefinition,
  WorkflowRun,
  WorkflowStep,
  WorkflowEdge,
  StepRunResult,
  ConditionConfig,
  ParallelConfig,
  TransformConfig,
} from "@/types";
import { nanoid } from "nanoid";
import { isoNow } from "@/lib/utils";
import { eventBus } from "@/orchestration/event-bus";
import { useWorkflowStore } from "@/stores/workflow-store";
import { saveWorkflowRun, updateWorkflowRun } from "@/memory/workflow-store";
import { runStep } from "./step-runners";

const MAX_SUB_WORKFLOW_DEPTH = 3;

export class WorkflowExecutor {
  private activeRuns: Map<string, {
    controller: AbortController;
    pausePromise: Promise<void> | null;
    pauseResolve: (() => void) | null;
  }> = new Map();

  async execute(
    workflow: WorkflowDefinition,
    triggeredBy: "manual" | "event" | "scheduled" | "sub_workflow",
    initialVariables?: Record<string, unknown>,
    depth?: number,
    onStarted?: (run: WorkflowRun) => void,
    /**
     * Resume support: pre-seeded step results from a prior (failed/cancelled)
     * run. Seeded steps are NOT re-executed — the DAG loop treats them as
     * already done. Only steps absent here (the failed step + everything
     * downstream) run. Callers must also pass the prior run's `variables` as
     * `initialVariables` so seeded steps' outputs are available downstream.
     */
    resumeState?: { stepResults: Record<string, StepRunResult> },
  ): Promise<WorkflowRun> {
    if ((depth ?? 0) >= MAX_SUB_WORKFLOW_DEPTH) {
      throw new Error("Maximum sub-workflow depth exceeded");
    }

    this.validateDAG(workflow);

    const run: WorkflowRun = {
      id: nanoid(),
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      status: "running",
      triggeredBy,
      variables: {
        ...Object.fromEntries(
          workflow.variables.map((v) => [v.name, v.defaultValue ?? null])
        ),
        ...initialVariables,
      },
      stepResults: resumeState ? { ...resumeState.stepResults } : {},
      startedAt: isoNow(),
      completedAt: null,
      error: null,
      durationMs: null,
    };

    const controller = new AbortController();
    this.activeRuns.set(run.id, { controller, pausePromise: null, pauseResolve: null });

    await saveWorkflowRun(run);
    useWorkflowStore.getState().addRun(run);
    eventBus.emit("workflow:run_started", { runId: run.id, workflowId: workflow.id }, "workflow-executor");
    // Tell the caller we're started before we begin the (long) DAG run,
    // so the UI can navigate to a live trace view immediately.
    onStarted?.(run);

    try {
      await this.executeDAG(workflow, run, depth ?? 0);

      if (run.status === "running") {
        run.status = "completed";
      }
    } catch (err) {
      if (run.status === "running") {
        run.status = "failed";
        run.error = err instanceof Error ? err.message : String(err);
      }
    } finally {
      this.activeRuns.delete(run.id);
      run.completedAt = isoNow();
      run.durationMs = new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime();

      await updateWorkflowRun(run.id, {
        status: run.status,
        completed_at: run.completedAt,
        error: run.error,
        duration_ms: run.durationMs,
        variables_json: JSON.stringify(run.variables),
        step_results_json: JSON.stringify(run.stepResults),
      });

      useWorkflowStore.getState().updateRun(run.id, {
        status: run.status,
        completedAt: run.completedAt,
        error: run.error,
        durationMs: run.durationMs,
      });

      const eventType = run.status === "completed" ? "workflow:run_completed" : "workflow:run_failed";
      eventBus.emit(eventType, { runId: run.id, workflowId: workflow.id, error: run.error }, "workflow-executor");
    }

    return run;
  }

  cancel(runId: string): void {
    const active = this.activeRuns.get(runId);
    if (active) {
      active.controller.abort();
      if (active.pauseResolve) {
        active.pauseResolve();
      }
    }
  }

  provideHumanInput(runId: string, stepId: string, value: unknown): void {
    const active = this.activeRuns.get(runId);
    if (!active) return;

    const store = useWorkflowStore.getState();
    const run = store.runs.find((r) => r.id === runId);
    if (run) {
      const newVars = { ...run.variables, [`${stepId}_input`]: value };
      store.updateRun(runId, { variables: newVars });
    }

    if (active.pauseResolve) {
      active.pauseResolve();
      active.pauseResolve = null;
      active.pausePromise = null;
    }
  }

  waitForHumanInput(runId: string): Promise<void> {
    const active = this.activeRuns.get(runId);
    if (!active) return Promise.reject(new Error("Run not found"));

    const promise = new Promise<void>((resolve) => {
      active.pauseResolve = resolve;
    });
    active.pausePromise = promise;
    return promise;
  }

  private async executeDAG(
    workflow: WorkflowDefinition,
    run: WorkflowRun,
    depth: number,
  ): Promise<void> {
    const controller = this.activeRuns.get(run.id)!.controller;

    const topoOrder = this.topologicalSort(workflow);

    const parallelOwnedSteps = new Set<string>();
    for (const step of workflow.steps) {
      if (step.config.type === "parallel") {
        for (const branchId of (step.config as ParallelConfig).branchStepIds) {
          parallelOwnedSteps.add(branchId);
        }
      }
    }

    const unreachableSteps = new Set<string>();

    for (const stepId of topoOrder) {
      if (controller.signal.aborted) {
        run.status = "cancelled";
        break;
      }

      if (parallelOwnedSteps.has(stepId)) continue;

      if (unreachableSteps.has(stepId)) {
        run.stepResults[stepId] = {
          stepId,
          status: "skipped",
          output: null,
          error: "Unreachable (condition gated)",
          startedAt: isoNow(),
          completedAt: isoNow(),
          durationMs: 0,
        };
        this.propagateUnreachable(stepId, workflow.edges, unreachableSteps, parallelOwnedSteps);
        continue;
      }

      const step = workflow.steps.find((s) => s.id === stepId)!;

      // Resume: a step seeded from a prior run (completed/skipped) is not
      // re-executed. Its output is already in run.variables (seeded from the
      // prior run's variables). We still fall through to the control-flow
      // handling below so a seeded condition re-applies its branch pruning.
      const seeded = run.stepResults[step.id];
      const isSeededDone =
        !!seeded && (seeded.status === "completed" || seeded.status === "skipped");

      let stepResult: StepRunResult;
      if (isSeededDone) {
        stepResult = seeded;
      } else {
        const deps = this.getDependencies(step.id, workflow.edges);
        const allDepsMet = deps.every((depId) => {
          const result = run.stepResults[depId];
          return result && (result.status === "completed" || result.status === "skipped");
        });

        if (!allDepsMet) {
          run.stepResults[step.id] = {
            stepId: step.id,
            status: "skipped",
            output: null,
            error: "Dependencies not met",
            startedAt: isoNow(),
            completedAt: isoNow(),
            durationMs: 0,
          };
          this.propagateUnreachable(step.id, workflow.edges, unreachableSteps, parallelOwnedSteps);
          continue;
        }

        stepResult = await this.executeStep(step, run, workflow, depth);
        run.stepResults[step.id] = stepResult;

        useWorkflowStore.getState().updateRun(run.id, {
          stepResults: { ...run.stepResults },
          variables: { ...run.variables },
        });
        await updateWorkflowRun(run.id, { step_results_json: JSON.stringify(run.stepResults) });
      }

      if (step.config.type === "condition" && stepResult.status === "completed") {
        const condConfig = step.config as ConditionConfig;
        const output = stepResult.output as { result: boolean; selectedStepId: string };
        const rejectedStepId = output.result ? condConfig.ifFalseStepId : condConfig.ifTrueStepId;
        unreachableSteps.add(rejectedStepId);
        this.propagateUnreachable(rejectedStepId, workflow.edges, unreachableSteps, parallelOwnedSteps);
      }

      if (stepResult.status === "failed") {
        const strategy = step.errorStrategy ?? workflow.errorStrategy;
        if (strategy === "stop") {
          run.status = "failed";
          run.error = stepResult.error;
          break;
        }
        if (strategy === "skip") {
          this.propagateUnreachable(step.id, workflow.edges, unreachableSteps, parallelOwnedSteps);
        }
      }
    }
  }

  private propagateUnreachable(
    fromStepId: string,
    edges: WorkflowEdge[],
    unreachableSteps: Set<string>,
    parallelOwnedSteps: Set<string>,
  ): void {
    const downstream = edges
      .filter((e) => e.sourceStepId === fromStepId)
      .map((e) => e.targetStepId);

    for (const targetId of downstream) {
      if (parallelOwnedSteps.has(targetId)) continue;

      const allIncoming = edges.filter((e) => e.targetStepId === targetId);
      const hasReachableSource = allIncoming.some(
        (e) => e.sourceStepId !== fromStepId && !unreachableSteps.has(e.sourceStepId)
      );

      if (!hasReachableSource) {
        unreachableSteps.add(targetId);
        this.propagateUnreachable(targetId, edges, unreachableSteps, parallelOwnedSteps);
      }
    }
  }

  private async executeStep(
    step: WorkflowStep,
    run: WorkflowRun,
    workflow: WorkflowDefinition,
    depth: number,
  ): Promise<StepRunResult> {
    const startedAt = isoNow();
    eventBus.emit("workflow:step_started", { runId: run.id, stepId: step.id, stepName: step.name }, "workflow-executor");

    // Publish a "running" marker immediately so any UI subscribed to
    // run.stepResults (run history page) shows live progress instead
    // of waiting until the step completes.
    run.stepResults[step.id] = {
      stepId: step.id,
      status: "running",
      output: null,
      error: null,
      startedAt,
      completedAt: null,
      durationMs: null,
    };
    useWorkflowStore.getState().updateRun(run.id, {
      stepResults: { ...run.stepResults },
    });
    // Persist the running marker immediately — not just to the in-memory
    // store. A long agent_task (e.g. the orchestrator pipeline) otherwise
    // leaves no DB trace until it finishes, so a mid-step reload makes the
    // step vanish from History and the reaper has nothing to reconcile.
    // Best-effort: a telemetry write must never fail the step itself.
    await updateWorkflowRun(run.id, {
      step_results_json: JSON.stringify(run.stepResults),
    }).catch(() => {});

    try {
      const timeout = step.timeoutMs ?? workflow.maxDurationMs;
      const controller = this.activeRuns.get(run.id)!.controller;

      const result = await Promise.race([
        runStep(step, { ...run.variables }, run, workflow, depth, this),
        new Promise<never>((_, reject) => {
          const timer = setTimeout(() => reject(new Error("Step timeout")), timeout);
          controller.signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("Workflow cancelled"));
          });
        }),
      ]);

      if (result.output !== undefined) {
        run.variables = { ...run.variables, [step.id]: result.output };
        // Transforms declare an `outputVariable` to expose their result
        // under a stable name (e.g. `cobol_path`). Without this alias,
        // downstream prompts using `${cobol_path}` resolve to "".
        if (step.config.type === "transform") {
          const outName = (step.config as TransformConfig).outputVariable;
          if (outName) {
            run.variables[outName] = result.output;
          }
        }
        // The human_input step exposes its value under `${stepId}_input`
        // (a workflow convention). Mirror it into the executor's
        // run.variables so transforms/conditions/prompts that reference
        // the `_input`-suffixed name resolve correctly.
        if (step.config.type === "human_input") {
          run.variables[`${step.id}_input`] = result.output;
        }
      }

      const completedAt = isoNow();
      const stepResult: StepRunResult = {
        stepId: step.id,
        status: "completed",
        output: result.output,
        error: null,
        startedAt,
        completedAt,
        durationMs: new Date(completedAt).getTime() - new Date(startedAt).getTime(),
        tokenUsage: result.tokenUsage,
      };

      eventBus.emit("workflow:step_completed", { runId: run.id, stepId: step.id }, "workflow-executor");
      return stepResult;
    } catch (err) {
      const completedAt = isoNow();
      const errorMsg = err instanceof Error ? err.message : String(err);

      const stepResult: StepRunResult = {
        stepId: step.id,
        status: "failed",
        output: null,
        error: errorMsg,
        startedAt,
        completedAt,
        durationMs: new Date(completedAt).getTime() - new Date(startedAt).getTime(),
      };

      eventBus.emit("workflow:step_failed", { runId: run.id, stepId: step.id, error: errorMsg }, "workflow-executor");
      return stepResult;
    }
  }

  private validateDAG(workflow: WorkflowDefinition): void {
    const adjacency = new Map<string, string[]>();
    for (const step of workflow.steps) {
      adjacency.set(step.id, []);
    }
    for (const edge of workflow.edges) {
      adjacency.get(edge.sourceStepId)?.push(edge.targetStepId);
    }

    const inDegree = new Map<string, number>();
    for (const step of workflow.steps) inDegree.set(step.id, 0);
    for (const edge of workflow.edges) {
      inDegree.set(edge.targetStepId, (inDegree.get(edge.targetStepId) ?? 0) + 1);
    }

    const queue = [...inDegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);
    let visited = 0;

    while (queue.length > 0) {
      const node = queue.shift()!;
      visited++;
      for (const neighbor of adjacency.get(node) ?? []) {
        const newDegree = (inDegree.get(neighbor) ?? 0) - 1;
        inDegree.set(neighbor, newDegree);
        if (newDegree === 0) queue.push(neighbor);
      }
    }

    if (visited !== workflow.steps.length) {
      throw new Error("Workflow contains a cycle — cannot execute");
    }
  }

  private topologicalSort(workflow: WorkflowDefinition): string[] {
    const adjacency = new Map<string, string[]>();
    for (const step of workflow.steps) adjacency.set(step.id, []);
    for (const edge of workflow.edges) {
      adjacency.get(edge.sourceStepId)?.push(edge.targetStepId);
    }

    const inDegree = new Map<string, number>();
    for (const step of workflow.steps) inDegree.set(step.id, 0);
    for (const edge of workflow.edges) {
      inDegree.set(edge.targetStepId, (inDegree.get(edge.targetStepId) ?? 0) + 1);
    }

    const queue = [...inDegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);
    const order: string[] = [];

    while (queue.length > 0) {
      const node = queue.shift()!;
      order.push(node);
      for (const neighbor of adjacency.get(node) ?? []) {
        const newDegree = (inDegree.get(neighbor) ?? 0) - 1;
        inDegree.set(neighbor, newDegree);
        if (newDegree === 0) queue.push(neighbor);
      }
    }

    return order;
  }

  private getDependencies(stepId: string, edges: WorkflowEdge[]): string[] {
    return edges.filter((e) => e.targetStepId === stepId).map((e) => e.sourceStepId);
  }
}

export const workflowExecutor = new WorkflowExecutor();
