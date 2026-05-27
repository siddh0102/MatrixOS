export type StepType =
  | "agent_task"
  | "condition"
  | "parallel"
  | "human_input"
  | "transform"
  | "tool_call"
  | "sub_workflow";

export type ErrorStrategy = "stop" | "skip" | "fallback";

export type TriggerType = "manual" | "event" | "scheduled" | "sub_workflow";

export interface WorkflowDefinition {
  id: string;
  name: string;
  description: string;
  version: number;
  steps: WorkflowStep[];
  edges: WorkflowEdge[];
  variables: WorkflowVariable[];
  triggers: WorkflowTrigger[];
  errorStrategy: ErrorStrategy;
  maxDurationMs: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowStep {
  id: string;
  type: StepType;
  name: string;
  config: StepConfig;
  position: { x: number; y: number };
  errorStrategy?: ErrorStrategy;
  timeoutMs?: number;
  retryCount?: number;
}

export type StepConfig =
  | AgentTaskConfig
  | ConditionConfig
  | ParallelConfig
  | HumanInputConfig
  | TransformConfig
  | ToolCallConfig
  | SubWorkflowConfig;

export interface AgentTaskConfig {
  type: "agent_task";
  agentId: string;
  prompt: string;
  maxTokens?: number;
  includeContext?: boolean;
  sandboxEnabled?: boolean;
}

export interface ConditionConfig {
  type: "condition";
  expression: string;
  ifTrueStepId: string;
  ifFalseStepId: string;
}

export interface ParallelConfig {
  type: "parallel";
  branchStepIds: string[];
  waitPolicy: "all" | "any" | "none";
  maxConcurrency?: number;
}

export interface HumanInputConfig {
  type: "human_input";
  prompt: string;
  inputType: "text" | "choice" | "confirm";
  choices?: string[];
  timeoutMs?: number;
  defaultValue?: string;
}

export interface TransformConfig {
  type: "transform";
  expression: string;
  outputVariable: string;
}

export interface ToolCallConfig {
  type: "tool_call";
  toolName: string;
  serverId: string;
  arguments: Record<string, string>;
  sandboxConfig?: { enabled: boolean; allowedPaths: string[] };
}

export interface SubWorkflowConfig {
  type: "sub_workflow";
  workflowId: string;
  inputMapping: Record<string, string>;
  outputMapping: Record<string, string>;
}

export interface WorkflowEdge {
  id: string;
  sourceStepId: string;
  targetStepId: string;
  label?: string;
  condition?: string;
}

export interface WorkflowVariable {
  name: string;
  type: "string" | "number" | "boolean" | "object" | "array";
  defaultValue?: unknown;
  description?: string;
}

export interface WorkflowTrigger {
  id: string;
  type: TriggerType;
  enabled: boolean;
  config: TriggerConfig;
}

export type TriggerConfig =
  | ManualTriggerConfig
  | EventTriggerConfig
  | ScheduledTriggerConfig;

export interface ManualTriggerConfig {
  type: "manual";
}

export interface EventTriggerConfig {
  type: "event";
  eventType: string;
  filter?: Record<string, unknown>;
}

export interface ScheduledTriggerConfig {
  type: "scheduled";
  cronExpression: string;
  timezone: string;
}

export type RunStatus =
  | "pending"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export type StepRunStatus =
  | "pending"
  | "running"
  | "waiting_input"
  | "completed"
  | "failed"
  | "skipped"
  | "cancelled";

export interface WorkflowRun {
  id: string;
  workflowId: string;
  workflowVersion: number;
  status: RunStatus;
  triggeredBy: TriggerType;
  variables: Record<string, unknown>;
  stepResults: Record<string, StepRunResult>;
  startedAt: string;
  completedAt: string | null;
  error: string | null;
  durationMs: number | null;
}

export interface StepRunResult {
  stepId: string;
  status: StepRunStatus;
  output: unknown;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  tokenUsage?: { inputTokens: number; outputTokens: number };
}
