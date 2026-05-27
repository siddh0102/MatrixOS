import { eventBus } from "@/orchestration/event-bus";
import { listAlertRules } from "@/memory/alert-store-sql";
import { useUIStore } from "@/stores/ui-store";
import type { AppEvent, EventType, EventSubscription, AlertRule } from "@/types";

let subs: EventSubscription[] = [];

/** Evaluate a rule's optional predicate against the event payload. Empty/no
 *  predicate ("{}") means "fire on every occurrence". */
function predicatePasses(predicateJson: string, payload: unknown): boolean {
  let pred: { field?: string; op?: string; value?: unknown };
  try {
    pred = JSON.parse(predicateJson || "{}");
  } catch {
    return true;
  }
  if (!pred.field || !pred.op) return true;
  const actual = (payload as Record<string, unknown> | null | undefined)?.[pred.field];
  const expected = pred.value;
  switch (pred.op) {
    case "==": return actual === expected;
    case "!=": return actual !== expected;
    case ">": return Number(actual) > Number(expected);
    case "<": return Number(actual) < Number(expected);
    case ">=": return Number(actual) >= Number(expected);
    case "<=": return Number(actual) <= Number(expected);
    case "contains": return String(actual).includes(String(expected));
    default: return true;
  }
}

function fire(rule: AlertRule, event: AppEvent<unknown>): void {
  useUIStore.getState().addToast({
    type: rule.action === "notify" ? "error" : "info",
    message: rule.name?.trim() || `Alert: ${event.type}`,
    duration: rule.action === "notify" ? 8000 : undefined,
    source: "alert-engine",
  });
}

/** (Re)subscribe the event bus to all enabled event-source rules. Call after
 *  any rule CRUD so the live subscriptions match the DB. */
export async function reloadAlertRules(): Promise<void> {
  for (const s of subs) s.unsubscribe();
  subs = [];
  const rules = await listAlertRules();
  for (const rule of rules) {
    // telemetry-source rules (cost/token thresholds) are not event-driven and
    // are evaluated on the telemetry write path — not wired yet.
    if (!rule.enabled || rule.source !== "event" || !rule.eventType) continue;
    subs.push(
      eventBus.on(rule.eventType as EventType, (e: AppEvent<unknown>) => {
        if (predicatePasses(rule.predicateJson, e.payload)) fire(rule, e);
      }),
    );
  }
}

export async function initAlertEngine(): Promise<void> {
  await reloadAlertRules();
}
