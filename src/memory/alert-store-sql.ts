import { dbExecute, dbSelect } from "@/kernel/ipc-bridge";
import { isoNow } from "@/lib/utils";
import { nanoid } from "nanoid";
import type { AlertRule } from "@/types";

function mapRow(row: Record<string, unknown>): AlertRule {
  return {
    id: row.id as string,
    name: (row.name as string) ?? null,
    source: row.source as "event" | "telemetry",
    eventType: (row.event_type as string) ?? null,
    predicateJson: (row.predicate_json as string) ?? "{}",
    action: row.action as "toast" | "notify",
    enabled: row.enabled === 1,
    createdAt: row.created_at as string,
  };
}

export async function listAlertRules(): Promise<AlertRule[]> {
  const rows = await dbSelect<Record<string, unknown>>(
    `SELECT * FROM alert_rules ORDER BY created_at DESC`,
  );
  return rows.map(mapRow);
}

export async function createAlertRule(
  rule: Omit<AlertRule, "id" | "createdAt">,
): Promise<void> {
  await dbExecute(
    `INSERT INTO alert_rules (id, name, source, event_type, predicate_json, action, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      nanoid(),
      rule.name,
      rule.source,
      rule.eventType,
      rule.predicateJson,
      rule.action,
      rule.enabled ? 1 : 0,
      isoNow(),
    ],
  );
}

export async function setAlertRuleEnabled(id: string, enabled: boolean): Promise<void> {
  await dbExecute(`UPDATE alert_rules SET enabled = ? WHERE id = ?`, [enabled ? 1 : 0, id]);
}

export async function deleteAlertRule(id: string): Promise<void> {
  await dbExecute(`DELETE FROM alert_rules WHERE id = ?`, [id]);
}
