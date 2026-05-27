import type { ThinkingConfig, DelegationConfig, ScheduleConfig, WebPolicy } from "./agent";
import type { MemoryConfig } from "./memory";

export interface AgentExportPayload {
  version: "1.0";
  exportedAt: string;
  agent: {
    name: string;
    description: string;
    category: string;
    systemPrompt: string;
    temperature: number;
    maxTokens: number;
    maxConversationHistory: number;
    skillIds: string[];
    thinkingConfig: ThinkingConfig;
    delegationConfig: DelegationConfig;
    scheduleConfig: ScheduleConfig | null;
    memoryConfig: MemoryConfig;
    webPolicy?: WebPolicy;
  };
  skills: Array<{
    id: string;
    name: string;
    description: string;
    category: string;
    prompt: string;
    tags: string[];
  }>;
  metadata: {
    sourceProviderId: string;
    sourceModelId: string;
    toolIds: string[];
    mcpServerNames: string[];
  };
}
