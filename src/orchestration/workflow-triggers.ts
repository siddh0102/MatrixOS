import { Cron } from "croner";
import type { WorkflowDefinition, ScheduledTriggerConfig, EventTriggerConfig } from "@/types";
import { eventBus } from "./event-bus";
import { workflowExecutor } from "./workflow-executor";

class TriggerManager {
  private cronJobs: Map<string, { stop: () => void }> = new Map();
  private eventUnsubscribers: Map<string, () => void> = new Map();

  async start(workflows: WorkflowDefinition[]): Promise<void> {
    for (const workflow of workflows) {
      this.registerTriggers(workflow);
    }
  }

  stop(): void {
    for (const [, job] of this.cronJobs) {
      job.stop();
    }
    this.cronJobs.clear();

    for (const [, unsub] of this.eventUnsubscribers) {
      unsub();
    }
    this.eventUnsubscribers.clear();
  }

  registerTriggers(workflow: WorkflowDefinition): void {
    for (const trigger of workflow.triggers) {
      if (!trigger.enabled) continue;

      const key = `${workflow.id}:${trigger.id}`;

      switch (trigger.config.type) {
        case "scheduled": {
          const config = trigger.config as ScheduledTriggerConfig;
          const job = new Cron(config.cronExpression, { timezone: config.timezone }, () => {
            eventBus.emit("workflow:trigger_fired", {
              workflowId: workflow.id,
              triggerId: trigger.id,
              type: "scheduled",
            }, "trigger-manager");
            void workflowExecutor.execute(workflow, "scheduled");
          });
          this.cronJobs.set(key, { stop: () => job.stop() });
          break;
        }

        case "event": {
          const config = trigger.config as EventTriggerConfig;
          const sub = eventBus.on(config.eventType as any, (event) => {
            if (config.filter && !matchesFilter(event.payload, config.filter)) return;

            eventBus.emit("workflow:trigger_fired", {
              workflowId: workflow.id,
              triggerId: trigger.id,
              type: "event",
            }, "trigger-manager");
            void workflowExecutor.execute(workflow, "event", { triggerEvent: event.payload });
          });
          this.eventUnsubscribers.set(key, () => sub.unsubscribe());
          break;
        }

        case "manual":
          break;
      }
    }
  }

  unregisterTriggers(workflowId: string): void {
    for (const [key, job] of [...this.cronJobs.entries()]) {
      if (key.startsWith(`${workflowId}:`)) {
        job.stop();
        this.cronJobs.delete(key);
      }
    }
    for (const [key, unsub] of [...this.eventUnsubscribers.entries()]) {
      if (key.startsWith(`${workflowId}:`)) {
        unsub();
        this.eventUnsubscribers.delete(key);
      }
    }
  }

  reloadTriggers(workflow: WorkflowDefinition): void {
    this.unregisterTriggers(workflow.id);
    this.registerTriggers(workflow);
  }
}

function matchesFilter(payload: unknown, filter: Record<string, unknown>): boolean {
  if (!payload || typeof payload !== "object") return false;
  for (const [key, expected] of Object.entries(filter)) {
    const actual = (payload as Record<string, unknown>)[key];
    if (!deepEqual(actual, expected)) return false;
  }
  return true;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((val, idx) => deepEqual(val, b[idx]));
  }
  if (Array.isArray(a) || Array.isArray(b)) return false;

  const keysA = Object.keys(a as object);
  const keysB = Object.keys(b as object);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) =>
    deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])
  );
}

export const triggerManager = new TriggerManager();
