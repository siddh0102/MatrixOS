import type { AgentConfig, AgentInstance } from "@/types";
import { nanoid } from "nanoid";
import { isoNow } from "@/lib/utils";
import {
  DEFAULT_MAX_CONVERSATION_HISTORY,
  DEFAULT_MAX_TOKENS,
  DEFAULT_TEMPERATURE,
} from "@/lib/constants";
import { DEFAULT_MEMORY_CONFIG } from "@/memory/memory-defaults";

export function createDefaultConfig(
  overrides: Partial<AgentConfig> &
    Pick<AgentConfig, "name" | "providerId" | "modelId">,
): AgentConfig {
  const now = isoNow();
  return {
    id: nanoid(),
    name: overrides.name,
    description: overrides.description ?? "",
    category: overrides.category ?? "general",
    providerId: overrides.providerId,
    modelId: overrides.modelId,
    systemPrompt:
      overrides.systemPrompt ?? "You are a helpful AI assistant.",
    temperature: overrides.temperature ?? DEFAULT_TEMPERATURE,
    maxTokens: overrides.maxTokens ?? DEFAULT_MAX_TOKENS,
    maxConversationHistory:
      overrides.maxConversationHistory ?? DEFAULT_MAX_CONVERSATION_HISTORY,
    toolIds: overrides.toolIds ?? [],
    skillIds: overrides.skillIds ?? [],
    fallbackProviderIds: overrides.fallbackProviderIds ?? [],
    approvalConfig: overrides.approvalConfig ?? { mode: "always-ask", trustedServers: [], perToolOverrides: {} },
    sandboxConfig: overrides.sandboxConfig ?? { enabled: false, allowedPaths: [] },
    webPolicy: overrides.webPolicy ?? { allowPrivate: false },
    memoryConfig: overrides.memoryConfig ?? DEFAULT_MEMORY_CONFIG,
    thinkingConfig: overrides.thinkingConfig ?? { enabled: false, budgetTokens: 0 },
    delegationConfig: overrides.delegationConfig ?? {
      enabled: false,
      allowedAgentIds: [],
      maxDelegationDepth: 3,
      maxDelegationTokens: 4096,
      maxDelegationTimeoutMs: 60_000,
    },
    scheduleConfig: overrides.scheduleConfig ?? null,
    createdAt: now,
    updatedAt: now,
  };
}

export function createInstance(config: AgentConfig): AgentInstance {
  return {
    instanceId: nanoid(),
    configId: config.id,
    status: "idle",
    activeConversationId: null,
    tokenUsage: {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      turnCount: 0,
    },
    startedAt: null,
    error: null,
  };
}
