import { dbExecute, dbSelect } from "@/kernel/ipc-bridge";
import { isoNow } from "@/lib/utils";

const GLOBAL = "__global__";

export async function getPreference<T>(
  key: string,
  agentId?: string,
): Promise<T | null> {
  const rows = await dbSelect<{ value_json: string }>(
    `SELECT value_json FROM preferences WHERE key = ? AND agent_id = ?`,
    [key, agentId ?? GLOBAL],
  );
  if (!rows[0]) return null;
  return JSON.parse(rows[0].value_json) as T;
}

export async function setPreference(
  key: string,
  value: unknown,
  agentId?: string,
): Promise<void> {
  await dbExecute(
    `INSERT OR REPLACE INTO preferences (key, value_json, agent_id, updated_at)
     VALUES (?, ?, ?, ?)`,
    [key, JSON.stringify(value), agentId ?? GLOBAL, isoNow()],
  );
}

export async function deletePreference(
  key: string,
  agentId?: string,
): Promise<void> {
  await dbExecute(
    `DELETE FROM preferences WHERE key = ? AND agent_id = ?`,
    [key, agentId ?? GLOBAL],
  );
}

export async function getAllPreferences(
  agentId?: string,
): Promise<Record<string, unknown>> {
  const rows = await dbSelect<{ key: string; value_json: string }>(
    `SELECT key, value_json FROM preferences WHERE agent_id = ?`,
    [agentId ?? GLOBAL],
  );
  const result: Record<string, unknown> = {};
  for (const row of rows) {
    result[row.key] = JSON.parse(row.value_json);
  }
  return result;
}
