import { dbSelect } from "@/kernel/ipc-bridge";

export async function getDailyTokenUsage(agentId: string, date: string): Promise<number> {
  const rows = await dbSelect<{ total: number }>(
    "SELECT (input_tokens + output_tokens) as total FROM daily_token_usage WHERE agent_id = ? AND date = ?",
    [agentId, date],
  );
  return rows[0]?.total ?? 0;
}

