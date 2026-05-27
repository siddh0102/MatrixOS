export type EventType =
  | "agent:started"
  | "agent:stopped"
  | "agent:error"
  | "agent:status_changed"
  | "conversation:created"
  | "conversation:deleted"
  | "conversation:message_added"
  | "conversation:compacted"
  | "tool:execution_started"
  | "tool:execution_completed"
  | "tool:execution_failed"
  | "tool:approval_requested"
  | "tool:approval_resolved"
  | "tool:execution_approved"
  | "tool:execution_rejected"
  | "provider:connected"
  | "provider:disconnected"
  | "provider:error"
  | "provider:config_changed"
  | "provider:rate_limited"
  | "mcp:server_connecting"
  | "mcp:server_ready"
  | "mcp:server_error"
  | "mcp:server_crashed"
  | "mcp:server_disabled"
  | "mcp:tools_discovered"
  | "schedule:job_started"
  | "schedule:job_completed"
  | "schedule:job_failed"
  | "process:queued"
  | "process:started"
  | "process:completed"
  | "process:failed"
  | "process:cancelled"
  | "process:preempted"
  | "process:budget_warning"
  | "workflow:run_started"
  | "workflow:run_completed"
  | "workflow:run_failed"
  | "workflow:step_started"
  | "workflow:step_completed"
  | "workflow:step_failed"
  | "workflow:human_input_required"
  | "workflow:trigger_fired"
  | "workflow:step_activity"
  | "agent:delegation_started"
  | "agent:delegation_completed";

export interface AppEvent<T = unknown> {
  readonly id: string;
  readonly type: EventType;
  readonly payload: T;
  readonly source: string;
  readonly timestamp: string;
}

export interface EventSubscription {
  unsubscribe(): void;
}

export interface IEventBus {
  emit<T>(type: EventType, payload: T, source: string): void;
  on<T>(
    type: EventType,
    handler: (event: AppEvent<T>) => void,
  ): EventSubscription;
  once<T>(
    type: EventType,
    handler: (event: AppEvent<T>) => void,
  ): EventSubscription;
  off(type: EventType, handler: (event: AppEvent<unknown>) => void): void;
}
