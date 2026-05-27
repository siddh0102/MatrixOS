import { dbExecute, dbSelect } from "@/kernel/ipc-bridge";
import type { AgentConfig, SandboxConfig } from "@/types";
import { isoNow } from "@/lib/utils";
import { appendAudit } from "@/memory/audit-store";
import { DEFAULT_MEMORY_CONFIG } from "@/memory/memory-defaults";

export async function listAgentConfigs(): Promise<AgentConfig[]> {
  const rows = await dbSelect<AgentRow>(
    `SELECT * FROM agents ORDER BY created_at ASC`,
  );
  return rows.map(rowToAgentConfig);
}

export async function saveAgentConfig(config: AgentConfig): Promise<void> {
  const existing = await dbSelect<{ id: string }>(
    "SELECT id FROM agents WHERE id = ?",
    [config.id],
  );
  const isNew = existing.length === 0;

  await dbExecute(
    `INSERT OR REPLACE INTO agents
       (id, name, description, category, config_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      config.id,
      config.name,
      config.description,
      config.category,
      JSON.stringify(config),
      config.createdAt,
      isoNow(),
    ],
  );

  appendAudit({
    eventType: isNew ? "agent.created" : "agent.updated",
    actor: "user",
    targetType: "agent",
    targetId: config.id,
    details: { name: config.name },
  }).catch(() => {});
}

export async function deleteAgentConfig(id: string): Promise<void> {
  const rows = await dbSelect<AgentRow>("SELECT * FROM agents WHERE id = ?", [id]);
  const name = rows[0] ? JSON.parse(rows[0].config_json).name : id;

  await dbExecute(`DELETE FROM agents WHERE id = ?`, [id]);

  appendAudit({
    eventType: "agent.deleted",
    actor: "user",
    targetType: "agent",
    targetId: id,
    details: { name },
  }).catch(() => {});
}

export async function setAgentSandbox(
  agentId: string,
  sandbox: SandboxConfig,
): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("agent_set_sandbox", {
    agentId,
    sandbox: {
      enabled: sandbox.enabled,
      allowedPaths: sandbox.allowedPaths,
    },
  });
}

export async function setAgentRateLimits(
  agentId: string,
  limits: { requestsPerMinute?: number | null; maxTokensPerDay?: number | null },
): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("agent_set_rate_limits", {
    agentId,
    limits: {
      requestsPerMinute: limits.requestsPerMinute ?? null,
      maxTokensPerDay: limits.maxTokensPerDay ?? null,
    },
  });
}

interface AgentRow {
  id: string;
  name: string;
  description: string;
  category: string;
  config_json: string;
  created_at: string;
  updated_at: string;
}

function rowToAgentConfig(row: AgentRow): AgentConfig {
  let configJsonText: string;
  // tauri-plugin-sql returns BLOB columns as a Uint8Array / number[] rather
  // than a string. We've seen this happen when a row was written via
  // SQL `readfile()` — the affinity is set to BLOB and survives even though
  // the table column is declared TEXT. Coerce defensively.
  const cj: unknown = row.config_json;
  if (typeof cj === "string") {
    configJsonText = cj;
  } else if (cj instanceof Uint8Array) {
    configJsonText = new TextDecoder().decode(cj);
  } else if (Array.isArray(cj)) {
    configJsonText = new TextDecoder().decode(new Uint8Array(cj as number[]));
  } else {
    throw new Error(
      `Agent row ${row.id} has config_json of unexpected type: ${typeof cj}`,
    );
  }
  let config: AgentConfig;
  try {
    config = JSON.parse(configJsonText) as AgentConfig;
  } catch (err) {
    throw new Error(
      `Agent row ${row.id} has malformed config_json (length=${configJsonText.length}, head="${configJsonText.slice(0, 60).replace(/\n/g, "\\n")}"): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  config.fallbackProviderIds ??= [];
  config.skillIds ??= [];
  config.approvalConfig ??= { mode: "always-ask", trustedServers: [], perToolOverrides: {} };
  config.approvalConfig.perToolOverrides ??= {};
  config.sandboxConfig ??= { enabled: false, allowedPaths: [] };
  config.memoryConfig ??= DEFAULT_MEMORY_CONFIG;
  config.memoryConfig.knowledgeBaseIds ??= [];
  config.thinkingConfig ??= { enabled: false, budgetTokens: 0 };
  config.delegationConfig ??= {
    enabled: false,
    allowedAgentIds: [],
    maxDelegationDepth: 3,
    maxDelegationTokens: 4096,
    maxDelegationTimeoutMs: 60_000,
  };
  config.scheduleConfig ??= null;
  return config;
}
