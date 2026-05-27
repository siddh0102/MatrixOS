// src/scheduling/execute-job.ts
// Runs one scheduled job: looks up agent + provider, creates a conversation if
// needed, appends the prompt as a user message, and drives executeAgentTurn.

import type { ScheduledJob } from "@/types";
import { listAgentConfigs } from "@/memory/agent-store-sql";
import { createProvider } from "@/providers";
import { createInstance } from "@/agents/agent-factory";
import { executeAgentTurn } from "@/agents/agent-runtime";
import { useSettingsStore } from "@/stores/settings-store";
import { createConversation } from "@/memory/conversation-store";
import { nanoid } from "nanoid";
import { isoNow } from "@/lib/utils";
import type { StreamCallbacks } from "@/agents/agent-runtime";

export interface JobExecutionResult {
  conversationId: string;
  messageId: string | null;
  inputTokens: number;
  outputTokens: number;
}

export async function executeScheduledJob(
  job: ScheduledJob,
  _runId: string,
): Promise<JobExecutionResult> {
  // 1. Resolve agent config.
  const allConfigs = await listAgentConfigs();
  const agentConfig = allConfigs.find((c) => c.id === job.agentId);
  if (!agentConfig) {
    throw new Error(`AGENT_NOT_FOUND: ${job.agentId}`);
  }

  // 2. Resolve provider.
  const providers = useSettingsStore.getState().providers;
  const providerCfg = providers.find((p) => p.id === agentConfig.providerId);
  if (!providerCfg) {
    throw new Error(`PROVIDER_NOT_FOUND: ${agentConfig.providerId}`);
  }
  const provider = createProvider(providerCfg);

  // 3. Resolve or create conversation.
  let conversationId = job.targetConversationId;
  if (!conversationId) {
    const now = isoNow();
    const newConvId = nanoid();
    await createConversation({
      id: newConvId,
      agentId: job.agentId,
      title: `Scheduled: ${job.prompt.slice(0, 40)}`,
      createdAt: now,
      updatedAt: now,
    });
    conversationId = newConvId;
  }

  // 4. Create a transient agent instance (not stored in the process-store).
  const instance = createInstance(agentConfig);

  // 5. Collect usage from the no-op stream callbacks.
  let inputTokens = 0;
  let outputTokens = 0;
  const noop: StreamCallbacks = {
    onMessageStart: () => {},
    onTextDelta: () => {},
    onToolCallStart: () => {},
    onToolCallDelta: () => {},
    onToolCallEnd: () => {},
    onMessageEnd: (usage) => {
      inputTokens = usage.inputTokens;
      outputTokens = usage.outputTokens;
    },
    onError: () => {},
  };

  // 6. Run the agent turn.  executeAgentTurn saves the user message itself.
  const content: import("@/types").MessageContent[] = [
    { type: "text", text: job.prompt },
  ];

  const finalMessage = await executeAgentTurn(
    agentConfig,
    instance,
    content,
    provider,
    conversationId,
    noop,
  );

  return {
    conversationId,
    messageId: finalMessage?.id ?? null,
    inputTokens,
    outputTokens,
  };
}
