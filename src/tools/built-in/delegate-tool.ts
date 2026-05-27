import type { AgentConfig, LLMToolDefinition, MessageContent } from "@/types";
import type { StreamCallbacks } from "@/agents/agent-runtime";
import { eventBus } from "@/orchestration/event-bus";

export const DELEGATE_TOOL_DEFINITION: LLMToolDefinition = {
  name: "delegate_to_agent",
  description:
    "Delegate a task to another specialized agent and receive their response. Use when the task requires capabilities from a different agent.",
  inputSchema: {
    type: "object",
    properties: {
      agentId: {
        type: "string",
        description: "The ID of the agent to delegate to",
      },
      task: {
        type: "string",
        description: "The task or question to send to the delegated agent",
      },
      context: {
        type: "string",
        description: "Optional context to provide to the delegated agent",
      },
    },
    required: ["agentId", "task"],
  },
};

export async function executeDelegation(
  args: { agentId: string; task: string; context?: string },
  callerConfig: AgentConfig,
  depth: number,
  // The caller turn's telemetryId. Threaded onto the delegated turn's
  // llm_requests row as parent_request_id so the trace can nest delegated
  // turns under their orchestrator (migration 020).
  parentRequestId?: string,
  // The orchestrator step's run/step ids. When present, the sub-agent's tool
  // calls + status are emitted as workflow:step_activity so the trace shows
  // sub-agent streaming under the orchestrator step.
  activityCtx?: { runId?: string | null; stepId?: string | null },
): Promise<string> {
  const dc = callerConfig.delegationConfig;
  if (!dc.enabled) {
    throw new Error("This agent is not configured for delegation");
  }
  if (!dc.allowedAgentIds.includes(args.agentId)) {
    throw new Error(`Agent ${args.agentId} is not in the allowed delegation list`);
  }
  if (depth >= dc.maxDelegationDepth) {
    throw new Error("Maximum delegation depth exceeded");
  }

  const { executeAgentTurn } = await import("@/agents/agent-runtime");
  const { listAgentConfigs } = await import("@/memory/agent-store-sql");
  const { createInstance } = await import("@/agents/agent-factory");
  const { createConversation, deleteConversation } = await import("@/memory/conversation-store");
  const { createProvider } = await import("@/providers");
  const { nanoid } = await import("nanoid");
  const { isoNow } = await import("@/lib/utils");
  const { useSettingsStore } = await import("@/stores/settings-store");

  const allConfigs = await listAgentConfigs();
  const targetConfig = allConfigs.find((c) => c.id === args.agentId);
  if (!targetConfig) throw new Error(`Target agent ${args.agentId} not found`);

  const providers = useSettingsStore.getState().providers;
  const providerCfg = providers.find((p) => p.id === targetConfig.providerId);
  if (!providerCfg) throw new Error(`Provider not found for agent ${args.agentId}`);

  const provider = createProvider(providerCfg);

  const tempConvId = nanoid();
  const now = isoNow();
  await createConversation({
    id: tempConvId,
    agentId: args.agentId,
    title: "Delegation",
    createdAt: now,
    updatedAt: now,
  });

  const taskText = args.context
    ? `Context: ${args.context}\n\nTask: ${args.task}`
    : args.task;
  const content: MessageContent[] = [{ type: "text", text: taskText }];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), dc.maxDelegationTimeoutMs);

  // Capture a structured artifact handoff. The sub-agent calls
  // `report_artifact({path, kind, status})` after write_file; we read the path
  // from the typed tool args here rather than regex-parsing a trailing prose
  // anchor. Last call wins.
  let reported: { path: string; kind: string; status: string; summary: string | null } | null = null;
  // Lite activity: forward the sub-agent's heartbeat to the orchestrator step
  // so the trace shows sub-agent streaming. No-op when not run from a workflow.
  const emitAct = (kind: string, text: string) => {
    if (!activityCtx?.stepId) return;
    eventBus.emit(
      "workflow:step_activity",
      { runId: activityCtx.runId, stepId: activityCtx.stepId, kind, text },
      "delegate-tool",
    );
  };
  const callbacks: StreamCallbacks = {
    onMessageStart: () => {},
    onTextDelta: () => {},
    onToolCallStart: (_id, name) => emitAct("tool", `${targetConfig.name} · ${name}`),
    onToolCallDelta: () => {},
    onToolCallEnd: (_id, name, a) => {
      if (name === "report_artifact" && a && typeof a.path === "string" && a.path.trim()) {
        reported = {
          path: a.path.trim(),
          kind: typeof a.kind === "string" ? a.kind : "",
          status: typeof a.status === "string" ? a.status : "ok",
          summary: typeof a.summary === "string" ? a.summary : null,
        };
      }
    },
    onMessageEnd: () => {},
    onError: () => {},
  };

  // Surface delegation as live events so the run-history trace can show which
  // sub-agent the orchestrator is delegating to right now. Keyed by the
  // delegator + target agent ids (no run id is threaded this deep — fine for
  // the single-active-run case the trace renders).
  eventBus.emit(
    "agent:delegation_started",
    { delegatorId: callerConfig.id, targetAgentId: args.agentId, targetName: targetConfig.name },
    "delegate-tool",
  );
  emitAct("status", `Delegating to ${targetConfig.name}…`);

  try {
    const tempInstance = createInstance(targetConfig);
    const result = await executeAgentTurn(
      targetConfig,
      tempInstance,
      content,
      provider,
      tempConvId,
      callbacks,
      undefined,
      undefined,
      undefined,
      depth + 1,
      undefined,
      controller.signal,
      { parentRequestId },
    );

    const responseText = result.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");

    eventBus.emit(
      "agent:delegation_completed",
      { delegatorId: callerConfig.id, targetAgentId: args.agentId, ok: true },
      "delegate-tool",
    );
    emitAct("status", `${targetConfig.name} finished`);

    // Prepend a deterministic, machine-built ARTIFACT header when the sub-agent
    // reported via report_artifact. The path comes from typed tool args, not
    // model prose — so it survives truncation (it's at the head) and can't be
    // lost to a missing/garbled anchor line. The orchestrator parses this.
    const r = reported as { path: string; kind: string; status: string; summary: string | null } | null;
    const header = r ? `[ARTIFACT] kind=${r.kind} status=${r.status} path=${r.path}` : null;
    const full = header ? `${header}\n\n${responseText}` : responseText;

    const maxChars = dc.maxDelegationTokens * 4;
    if (full.length <= maxChars) return full;
    // Preserve head + tail on truncation: the ARTIFACT header sits at the head
    // (so the path always survives), and any trailing summary stays in the tail.
    const tailLen = 2000;
    const head = full.slice(0, Math.max(0, maxChars - tailLen));
    const tail = full.slice(-tailLen);
    return `${head}\n…[truncated]…\n${tail}`;
  } catch (err) {
    eventBus.emit(
      "agent:delegation_completed",
      {
        delegatorId: callerConfig.id,
        targetAgentId: args.agentId,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      },
      "delegate-tool",
    );
    emitAct("status", `${targetConfig.name} failed`);
    throw err;
  } finally {
    clearTimeout(timeout);
    await deleteConversation(tempConvId).catch(() => {});
  }
}
