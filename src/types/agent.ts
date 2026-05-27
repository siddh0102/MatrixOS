import type { MemoryConfig } from "./memory";
import type { TokenBudget } from "./process";

export interface ThinkingConfig {
  enabled: boolean;
  budgetTokens: number;
}

export interface DelegationConfig {
  enabled: boolean;
  allowedAgentIds: string[];
  maxDelegationDepth: number;
  maxDelegationTokens: number;
  maxDelegationTimeoutMs: number;
}

export interface ScheduleConfig {
  cronExpression: string;
  timezone: string;
  enabled: boolean;
  targetConversationId: string | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
  prompt: string;
}

export type AgentStatus =
  | "idle"
  | "running"
  | "paused"
  | "error"
  | "stopped";

export interface ApprovalConfig {
  mode: "auto-approve" | "auto-reject" | "always-ask";
  trustedServers: string[];
  // key = "serverId:toolName" to avoid collisions between same-named tools from different servers
  // Built-in tools use "built-in:toolName". Falls back to global `mode` when not in map.
  perToolOverrides: Record<string, "auto" | "prompt" | "deny">;
}

export interface SandboxConfig {
  enabled: boolean;
  allowedPaths: string[];
}

export interface WebPolicy {
  allowPrivate: boolean;
}

export interface AgentConfig {
  readonly id: string;
  name: string;
  description: string;
  category: string;
  providerId: string;
  modelId: string;
  systemPrompt: string;
  temperature: number;
  maxTokens: number;
  maxConversationHistory: number;
  toolIds: string[];
  skillIds: string[];
  fallbackProviderIds: string[];
  approvalConfig: ApprovalConfig;
  sandboxConfig: SandboxConfig;
  webPolicy: WebPolicy;
  memoryConfig: MemoryConfig;
  thinkingConfig: ThinkingConfig;
  delegationConfig: DelegationConfig;
  scheduleConfig: ScheduleConfig | null;
  processBudget?: Partial<TokenBudget>;
  createdAt: string;
  updatedAt: string;
}

export interface AgentError {
  readonly message: string;
  readonly code: string;
  readonly timestamp: string;
  readonly recoverable: boolean;
}

export interface TokenUsageAccumulator {
  totalInputTokens: number;
  totalOutputTokens: number;
  turnCount: number;
}

export interface AgentInstance {
  readonly instanceId: string;
  readonly configId: string;
  status: AgentStatus;
  activeConversationId: string | null;
  tokenUsage: TokenUsageAccumulator;
  startedAt: string | null;
  error: AgentError | null;
}
