import type {
  CallContext,
  WorkflowStep,
  WorkflowDefinition,
  WorkflowRun,
  AgentTaskConfig,
  ConditionConfig,
  ParallelConfig,
  HumanInputConfig,
  TransformConfig,
  ToolCallConfig,
  SubWorkflowConfig,
} from "@/types";
import type { WorkflowExecutor } from "./workflow-executor";
import { resolveTemplate } from "./variable-resolver";
import { processManager } from "./process-manager";
import { eventBus } from "./event-bus";
import { isoNow } from "@/lib/utils";

interface StepOutput {
  output: unknown;
  tokenUsage?: { inputTokens: number; outputTokens: number };
}

export async function runStep(
  step: WorkflowStep,
  variables: Record<string, unknown>,
  run: WorkflowRun,
  workflow: WorkflowDefinition,
  depth: number,
  executor: WorkflowExecutor,
): Promise<StepOutput> {
  switch (step.config.type) {
    case "agent_task":
      return runAgentTask(step.config, variables, run, step.id);
    case "condition":
      return runCondition(step.config, variables);
    case "parallel":
      return runParallel(step.config, variables, run, workflow, depth, executor);
    case "human_input":
      return runHumanInput(step.config, step.id, run, executor);
    case "transform":
      return runTransform(step.config, variables);
    case "tool_call":
      return runToolCall(step.config, variables, run);
    case "sub_workflow":
      return runSubWorkflow(step.config, variables, run, depth, executor);
    default:
      throw new Error(`Unknown step type: ${(step.config as any).type}`);
  }
}

async function runAgentTask(
  config: AgentTaskConfig,
  variables: Record<string, unknown>,
  run: WorkflowRun,
  stepId: string,
): Promise<StepOutput> {
  const { listAgentConfigs } = await import("@/memory/agent-store-sql");
  const { createInstance } = await import("@/agents/agent-factory");
  const { createProvider } = await import("@/providers");
  const { executeAgentTurn } = await import("@/agents/agent-runtime");
  const { createConversation } = await import("@/memory/conversation-store");
  const { trackWorkflowConversation } = await import("@/memory/workflow-store");
  const { useSettingsStore } = await import("@/stores/settings-store");
  const { nanoid } = await import("nanoid");

  const resolvedPrompt = resolveTemplate(config.prompt, variables);

  const allConfigs = await listAgentConfigs();
  const agentConfig = allConfigs.find((c) => c.id === config.agentId);
  if (!agentConfig) throw new Error(`Agent ${config.agentId} not found`);

  const providers = useSettingsStore.getState().providers;
  const providerCfg = providers.find((p) => p.id === agentConfig.providerId);
  if (!providerCfg) throw new Error("Provider not found");

  const provider = createProvider(providerCfg);

  const convId = nanoid();
  await createConversation({
    id: convId,
    agentId: agentConfig.id,
    title: `Workflow: ${resolvedPrompt.slice(0, 40)}`,
    createdAt: isoNow(),
    updatedAt: isoNow(),
  });
  await trackWorkflowConversation(convId, run.id, run.workflowId);

  const { process, controller } = await processManager.spawn({
    agentId: agentConfig.id,
    conversationId: convId,
    priority: "background",
    parentWorkflowRunId: run.id,
  });

  let tokenUsage = { inputTokens: 0, outputTokens: 0 };

  const instance = createInstance(agentConfig);
  // Lite live activity: emit coarse heartbeat events (status + tool-call names)
  // so the trace view can show "something is happening" for a running step.
  // No per-token text (that's the "Full" variant) — keeps the bus quiet.
  const emitActivity = (kind: string, text: string) =>
    eventBus.emit(
      "workflow:step_activity",
      { runId: run.id, stepId, kind, text },
      "step-runners",
    );
  const callbacks = {
    onMessageStart: () => emitActivity("status", "Thinking…"),
    onTextDelta: () => {},
    onToolCallStart: (_id: string, name: string) => emitActivity("tool", name),
    onToolCallDelta: () => {},
    onToolCallEnd: () => {},
    onMessageEnd: (usage: { inputTokens: number; outputTokens: number }) => {
      tokenUsage = usage;
      emitActivity("status", "Round complete");
    },
    onError: () => {},
  };

  try {
    const result = await executeAgentTurn(
      agentConfig,
      instance,
      [{ type: "text", text: resolvedPrompt }],
      provider,
      convId,
      callbacks,
      undefined, // fallbackProviders
      undefined, // skillPrompts
      undefined, // memoryContext
      undefined, // delegationDepth
      undefined, // memorySources
      undefined, // abortSignal
      { runId: run.id, stepId }, // telemetryContext → links this turn to the run/step
    );

    const responseText = result.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");

    // An agent that ends its turn with no text output is a step FAILURE, not
    // a success. Overloaded/free models frequently return an empty completion
    // after a tool result (the model stalls). Without this guard the step is
    // marked "completed" with empty output and the whole run looks successful
    // while nothing was produced — exactly the misleading "complete but no
    // files" case. Fail loudly so it shows in the trace and can be resumed.
    if (responseText.trim().length === 0) {
      throw new Error(
        "Agent produced an empty response (no text output) — the model likely " +
          "stalled or returned an empty completion after a tool result. Use a " +
          "more capable/reliable model for this agent.",
      );
    }

    processManager.recordTokenUsage(process.id, tokenUsage.inputTokens, tokenUsage.outputTokens);
    await processManager.markCompleted(process.id);

    return { output: responseText, tokenUsage };
  } catch (err) {
    if (controller.signal.aborted) {
      await processManager.markFailed(process.id, "Preempted");
      throw new Error("Agent task preempted");
    }
    await processManager.markFailed(process.id, (err as Error).message);
    throw err;
  }
}

function runCondition(
  config: ConditionConfig,
  variables: Record<string, unknown>,
): StepOutput {
  const resolved = resolveTemplate(config.expression, variables);
  const result = evalExpression(resolved, variables);
  return {
    output: {
      result: Boolean(result),
      selectedStepId: result ? config.ifTrueStepId : config.ifFalseStepId,
    },
  };
}

function evalExpression(expression: string, context: Record<string, unknown>): unknown {
  const forbidden = /\b(import|require|eval|Function|constructor|__proto__|prototype)\b/;
  if (forbidden.test(expression)) {
    throw new Error(`Expression contains forbidden keyword: ${expression}`);
  }

  const fn = new Function(
    ...Object.keys(context),
    `"use strict"; return (${expression});`
  );
  return fn(...Object.values(context));
}

async function runHumanInput(
  config: HumanInputConfig,
  stepId: string,
  run: WorkflowRun,
  executor: WorkflowExecutor,
): Promise<StepOutput> {
  const { saveHumanInputRequest } = await import("@/memory/workflow-store");
  const { nanoid } = await import("nanoid");
  const { useWorkflowStore } = await import("@/stores/workflow-store");

  const requestId = nanoid();
  const timeoutAt = config.timeoutMs
    ? new Date(Date.now() + config.timeoutMs).toISOString()
    : null;

  await saveHumanInputRequest({
    id: requestId,
    runId: run.id,
    stepId,
    prompt: config.prompt,
    inputType: config.inputType,
    choicesJson: config.choices ? JSON.stringify(config.choices) : null,
    response: null,
    respondedAt: null,
    timeoutAt,
    createdAt: isoNow(),
  });

  eventBus.emit("workflow:human_input_required", {
    runId: run.id,
    stepId,
    requestId,
    prompt: config.prompt,
    inputType: config.inputType,
    choices: config.choices,
  }, "workflow-executor");

  let timer: ReturnType<typeof setTimeout> | null = null;

  const timeoutPromise = config.timeoutMs
    ? new Promise<void>((_, reject) => {
        timer = setTimeout(() => {
          if (config.defaultValue !== undefined) {
            // Will use default below
          } else {
            reject(new Error("Human input timeout"));
          }
        }, config.timeoutMs);
      })
    : null;

  const waitPromise = executor.waitForHumanInput(run.id);

  if (timeoutPromise) {
    await Promise.race([waitPromise, timeoutPromise]).catch((err) => {
      if (err.message === "Human input timeout" && config.defaultValue !== undefined) {
        // Swallow — we'll use the default
      } else {
        throw err;
      }
    });
  } else {
    await waitPromise;
  }

  if (timer) clearTimeout(timer);

  const store = useWorkflowStore.getState();
  const currentRun = store.runs.find((r) => r.id === run.id);
  const response = currentRun?.variables[`${stepId}_input`] ?? config.defaultValue ?? null;

  return { output: response };
}

async function runParallel(
  config: ParallelConfig,
  variables: Record<string, unknown>,
  run: WorkflowRun,
  workflow: WorkflowDefinition,
  depth: number,
  executor: WorkflowExecutor,
): Promise<StepOutput> {
  const branchSteps = config.branchStepIds
    .map((id) => workflow.steps.find((s) => s.id === id))
    .filter(Boolean) as WorkflowStep[];

  const concurrency = config.maxConcurrency ?? branchSteps.length;

  const results: Array<{ stepId: string; output: unknown }> = [];
  const batches: WorkflowStep[][] = [];
  for (let i = 0; i < branchSteps.length; i += concurrency) {
    batches.push(branchSteps.slice(i, i + concurrency));
  }

  for (const batch of batches) {
    const batchPromises = batch.map(async (step) => {
      const result = await runStep(step, variables, run, workflow, depth, executor);
      run.variables = { ...run.variables, [step.id]: result.output };
      run.stepResults[step.id] = {
        stepId: step.id,
        status: "completed",
        output: result.output,
        error: null,
        startedAt: isoNow(),
        completedAt: isoNow(),
        durationMs: null,
        tokenUsage: result.tokenUsage,
      };
      return { stepId: step.id, output: result.output };
    });

    if (config.waitPolicy === "any") {
      const first = await Promise.race(batchPromises);
      results.push(first);
      break;
    } else {
      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
    }
  }

  return {
    output: Object.fromEntries(results.map((r) => [r.stepId, r.output])),
  };
}

function runTransform(
  config: TransformConfig,
  variables: Record<string, unknown>,
): StepOutput {
  const resolved = resolveTemplate(config.expression, variables);
  const result = evalExpression(resolved, variables);
  return { output: result };
}

async function runToolCall(
  config: ToolCallConfig,
  variables: Record<string, unknown>,
  run: WorkflowRun,
): Promise<StepOutput> {
  const { toolRegistry } = await import("@/tools/tool-registry");
  const { executeTool } = await import("@/tools/tool-executor");
  const { nanoid } = await import("nanoid");

  const tool = toolRegistry.getByName(config.toolName);
  if (!tool) throw new Error(`Tool not found: ${config.toolName}`);

  const resolvedArgs: Record<string, unknown> = {};
  for (const [key, template] of Object.entries(config.arguments)) {
    resolvedArgs[key] = resolveTemplate(template, variables);
  }

  const sandboxConfig = config.sandboxConfig ?? { enabled: false, allowedPaths: [] };

  // Carry the step's sandbox in the call context so the Rust fs policy
  // honors it. Without this, the Workflow context resolves to a deny-all
  // default and built-in filesystem tools (read_file/write_file/…) fail
  // even on valid, existing paths.
  const callContext: CallContext = {
    type: "Workflow",
    workflowRunId: run.id,
    sandbox: {
      enabled: sandboxConfig.enabled,
      allowedPaths: sandboxConfig.allowedPaths,
    },
  };

  const execution = await executeTool(tool, nanoid(), resolvedArgs, callContext, sandboxConfig, undefined, { runId: run.id });
  if (execution.status === "failed") {
    // Surface execution.error (the real cause), not just result (often null).
    throw new Error(
      `Tool ${config.toolName} failed: ${execution.error ?? JSON.stringify(execution.result)}`,
    );
  }

  return { output: execution.result };
}

async function runSubWorkflow(
  config: SubWorkflowConfig,
  variables: Record<string, unknown>,
  _run: WorkflowRun,
  depth: number,
  executor: WorkflowExecutor,
): Promise<StepOutput> {
  const { getWorkflow } = await import("@/memory/workflow-store");

  const subWorkflow = await getWorkflow(config.workflowId);
  if (!subWorkflow) throw new Error(`Sub-workflow ${config.workflowId} not found`);

  const inputVars: Record<string, unknown> = {};
  for (const [targetVar, sourceExpr] of Object.entries(config.inputMapping)) {
    inputVars[targetVar] = resolveTemplate(sourceExpr, variables);
  }

  const subRun = await executor.execute(subWorkflow, "sub_workflow", inputVars, depth + 1);

  if (subRun.status === "failed") {
    throw new Error(`Sub-workflow failed: ${subRun.error}`);
  }

  const output: Record<string, unknown> = {};
  for (const [targetVar, sourceExpr] of Object.entries(config.outputMapping)) {
    output[targetVar] = resolveTemplate(sourceExpr, subRun.variables);
  }

  return { output };
}
