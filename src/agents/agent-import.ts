import { nanoid } from "nanoid";
import { isoNow } from "@/lib/utils";
import type { AgentConfig, AgentExportPayload } from "@/types";
import { saveAgentConfig } from "@/memory/agent-store-sql";
import { listSkills, saveSkill } from "@/memory/skill-store-sql";
import { useSettingsStore } from "@/stores/settings-store";
import { useAgentStore } from "@/stores/agent-store";
import { DEFAULT_MEMORY_CONFIG } from "@/memory/memory-defaults";

export function validateExportPayload(data: unknown): data is AgentExportPayload {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  return (
    d.version === "1.0" &&
    typeof d.exportedAt === "string" &&
    typeof d.agent === "object" && d.agent !== null &&
    Array.isArray(d.skills) &&
    typeof d.metadata === "object" && d.metadata !== null
  );
}

export interface ImportResult {
  config: AgentConfig;
  warnings: string[];
}

export async function importAgentFromFile(): Promise<ImportResult | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({
    multiple: false,
    filters: [{ name: "MatrixOS Agent", extensions: ["json"] }],
  });
  if (!selected) return null;

  const path = typeof selected === "string" ? selected : (selected as { path: string }).path;
  const { registerUserPath } = await import("@/lib/user-paths");
  await registerUserPath(path);
  const { invoke } = await import("@tauri-apps/api/core");
  const raw = await invoke<string>("fs_read", { ctx: { type: "User" }, path });

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("Invalid JSON in agent file");
  }

  if (!validateExportPayload(data)) {
    throw new Error("Invalid agent export file format (unsupported version or missing fields)");
  }

  const warnings: string[] = [];
  const providers = useSettingsStore.getState().providers;

  // Check provider availability
  const sourceProvider = providers.find((p) => p.id === data.metadata.sourceProviderId);
  let targetProviderId = data.metadata.sourceProviderId;
  let targetModelId = data.metadata.sourceModelId;

  if (!sourceProvider) {
    const firstEnabled = providers.find((p) => p.enabled);
    if (firstEnabled) {
      targetProviderId = firstEnabled.id;
      targetModelId = firstEnabled.defaultModelId;
      warnings.push(
        `Provider "${data.metadata.sourceProviderId}" not found. Using "${firstEnabled.name}" instead.`,
      );
    } else {
      warnings.push(`Provider "${data.metadata.sourceProviderId}" not found. Please configure it after import.`);
    }
  }

  // Check MCP server references
  if (data.metadata.mcpServerNames.length > 0) {
    warnings.push(
      `This agent uses MCP servers: ${data.metadata.mcpServerNames.join(", ")}. Configure them in Settings → MCP Servers.`,
    );
  }

  // Import embedded skills (skip if already imported by id)
  const existingSkills = await listSkills();
  const existingIds = new Set(existingSkills.map((s) => s.id));
  const skillIdMap: Record<string, string> = {};

  for (const skill of data.skills) {
    if (existingIds.has(skill.id)) {
      skillIdMap[skill.id] = skill.id;
      continue;
    }
    const newId = nanoid();
    skillIdMap[skill.id] = newId;
    const now = isoNow();
    await saveSkill({
      id: newId,
      sourceTemplateId: null,
      sourceVersion: null,
      name: skill.name,
      description: skill.description,
      category: skill.category,
      prompt: skill.prompt,
      tags: skill.tags,
      createdAt: now,
      updatedAt: now,
    });
  }

  // Map old skillIds to new ones
  const newSkillIds = data.agent.skillIds.map((id: string) => skillIdMap[id] ?? id);

  const now = isoNow();
  const newId = nanoid();
  const config: AgentConfig = {
    id: newId,
    name: data.agent.name,
    description: data.agent.description,
    category: data.agent.category,
    providerId: targetProviderId,
    modelId: targetModelId,
    systemPrompt: data.agent.systemPrompt,
    temperature: data.agent.temperature,
    maxTokens: data.agent.maxTokens,
    maxConversationHistory: data.agent.maxConversationHistory,
    toolIds: [],
    skillIds: newSkillIds,
    fallbackProviderIds: [],
    approvalConfig: { mode: "always-ask", trustedServers: [], perToolOverrides: {} },
    sandboxConfig: { enabled: false, allowedPaths: [] },
    webPolicy: data.agent.webPolicy ?? { allowPrivate: false },
    memoryConfig: data.agent.memoryConfig ?? DEFAULT_MEMORY_CONFIG,
    thinkingConfig: data.agent.thinkingConfig ?? { enabled: false, budgetTokens: 0 },
    delegationConfig: data.agent.delegationConfig ?? {
      enabled: false,
      allowedAgentIds: [],
      maxDelegationDepth: 3,
      maxDelegationTokens: 4096,
      maxDelegationTimeoutMs: 60_000,
    },
    scheduleConfig: data.agent.scheduleConfig ?? null,
    createdAt: now,
    updatedAt: now,
  };

  await saveAgentConfig(config);
  useAgentStore.getState().addConfig(config);

  return { config, warnings };
}
