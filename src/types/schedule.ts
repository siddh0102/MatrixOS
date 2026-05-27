export interface ScheduledJob {
  id: string;
  agentId: string;
  cronExpression: string;
  timezone: string;
  enabled: boolean;
  prompt: string;
  targetConversationId: string | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastRunStatus: "success" | "error" | "running" | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleRunResult {
  id: string;
  jobId: string;
  conversationId: string;
  messageId: string | null;
  status: "success" | "error";
  error?: string;
  inputTokens: number;
  outputTokens: number;
  startedAt: string;
  completedAt: string;
}
