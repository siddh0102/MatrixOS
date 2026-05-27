import { dbExecute, dbSelect } from "@/kernel/ipc-bridge";
import type { ModelConfig, ProviderConfig, ProviderType, RateLimitConfig } from "@/types";
import { isoNow } from "@/lib/utils";

export async function listProviderConfigs(): Promise<ProviderConfig[]> {
  const rows = await dbSelect<ProviderRow>(
    `SELECT * FROM provider_configs ORDER BY created_at ASC`,
  );
  return rows.map(rowToProviderConfig);
}

export async function saveProviderConfig(
  config: ProviderConfig,
): Promise<void> {
  const existing = await dbSelect<{ id: string }>(
    "SELECT id FROM provider_configs WHERE id = ?",
    [config.id],
  );

  if (existing.length > 0) {
    // UPDATE path: route through Rust command for validation/audit
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("provider_set_config", {
      providerId: config.id,
      config: {
        name: config.name ?? null,
        baseUrl: config.baseUrl ?? null,
        enabled: config.enabled ?? null,
        defaultModelId: config.defaultModelId ?? null,
        // Persist the discovered model list so it survives restart. Without
        // this, Test Connection populates the in-memory store but the DB
        // keeps the stale/empty list, and the dropdown is empty next launch.
        models: config.models ?? null,
      },
    });
  } else {
    // INSERT path: new provider — JS-side SQL (no security implication; key managed via provider_set_key)
    const configJson = JSON.stringify({
      models: config.models,
      defaultModelId: config.defaultModelId,
      rateLimit: config.rateLimit,
    });
    await dbExecute(
      `INSERT INTO provider_configs
         (id, type, name, base_url, enabled, config_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        config.id,
        config.type,
        config.name,
        config.baseUrl,
        config.enabled ? 1 : 0,
        configJson,
        config.createdAt,
        isoNow(),
      ],
    );
  }
}

export async function deleteProviderConfig(id: string): Promise<void> {
  await dbExecute(`DELETE FROM provider_configs WHERE id = ?`, [id]);
}

// ── Internal ──

interface ProviderRow {
  id: string;
  type: string;
  name: string;
  base_url: string | null;
  enabled: number;
  config_json: string;
  created_at: string;
  updated_at: string;
}

interface ProviderConfigJson {
  models: ModelConfig[];
  defaultModelId: string;
  rateLimit: RateLimitConfig;
}

function rowToProviderConfig(row: ProviderRow): ProviderConfig {
  const parsed = JSON.parse(row.config_json) as ProviderConfigJson;
  return {
    id: row.id,
    type: row.type as ProviderType,
    name: row.name,
    baseUrl: row.base_url,
    enabled: row.enabled === 1,
    models: parsed.models ?? [],
    defaultModelId: parsed.defaultModelId ?? "",
    rateLimit: parsed.rateLimit ?? {
      requestsPerMinute: 60,
      tokensPerMinute: 100_000,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
