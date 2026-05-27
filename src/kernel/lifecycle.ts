import type { AgentStatus } from "@/types";

const VALID_TRANSITIONS: Record<AgentStatus, AgentStatus[]> = {
  idle: ["running", "stopped"],
  running: ["idle", "paused", "error", "stopped"],
  paused: ["running", "stopped"],
  error: ["running", "stopped"],
  stopped: ["idle"],
};

export function canTransition(from: AgentStatus, to: AgentStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

export function transition(from: AgentStatus, to: AgentStatus): AgentStatus {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid agent state transition: ${from} → ${to}`);
  }
  return to;
}

export function getValidTransitions(from: AgentStatus): AgentStatus[] {
  return VALID_TRANSITIONS[from] ?? [];
}
