export type ProcessPriority = "interactive" | "background" | "scheduled";

export type ProcessStatus =
  | "queued"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export interface AgentProcess {
  id: string;
  agentId: string;
  conversationId: string;
  priority: ProcessPriority;
  status: ProcessStatus;
  queuePosition: number | null;
  tokenBudget: TokenBudget;
  tokenUsage: { inputTokens: number; outputTokens: number };
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  parentWorkflowRunId: string | null;
  parentStepId: string | null;
  createdAt: string;
}

export interface TokenBudget {
  maxTokensPerTurn: number;
  maxTokensPerSession: number;
  maxTokensPerDay: number;
  usedToday: number;
  sessionUsed: number;
}

export type ProcessEvent =
  | { type: "started"; process_id: string }
  | { type: "status_changed"; process_id: string; from: string; to: string }
  | { type: "completed"; process_id: string; input_tokens: number; output_tokens: number }
  | { type: "failed"; process_id: string; error: string }
  | { type: "stopped"; process_id: string };

export interface ProcessManagerConfig {
  maxConcurrentProcesses: number;
  maxQueueSize: number;
  interactiveSlots: number;
  backgroundSlots: number;
  scheduledSlots: number;
  defaultTokenBudget: TokenBudget;
  preemptionEnabled: boolean;
}
