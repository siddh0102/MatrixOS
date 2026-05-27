import { listAgentConfigs } from "@/memory/agent-store-sql";
import { listSkills } from "@/memory/skill-store-sql";
import { toolRegistry } from "@/tools/tool-registry";
import { isoNow } from "@/lib/utils";
import type { AgentExportPayload } from "@/types";

export async function exportAgent(agentId: string): Promise<AgentExportPayload> {
  const allConfigs = await listAgentConfigs();
  const config = allConfigs.find((c) => c.id === agentId);
  if (!config) throw new Error(`Agent ${agentId} not found`);

  const allSkills = await listSkills();
  const agentSkills = allSkills.filter((s) => config.skillIds.includes(s.id));
  // eslint-disable-next-line no-console
  console.log("[exportAgent]", {
    agentId,
    configSkillIds: config.skillIds,
    allSkillIdsInDb: allSkills.map((s) => s.id),
    matchedAgentSkills: agentSkills.map((s) => ({ id: s.id, name: s.name })),
  });

  // Resolve MCP server names from toolIds
  const mcpServerNames: string[] = [];
  for (const toolId of config.toolIds) {
    const tool = toolRegistry.get(toolId);
    if (tool?.serverId && tool.serverId !== "built-in") {
      mcpServerNames.push(tool.serverId);
    }
  }

  return {
    version: "1.0",
    exportedAt: isoNow(),
    agent: {
      name: config.name,
      description: config.description,
      category: config.category,
      systemPrompt: config.systemPrompt,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      maxConversationHistory: config.maxConversationHistory,
      skillIds: config.skillIds,
      thinkingConfig: config.thinkingConfig,
      delegationConfig: config.delegationConfig,
      scheduleConfig: config.scheduleConfig,
      memoryConfig: config.memoryConfig,
    },
    skills: agentSkills.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      category: s.category,
      prompt: s.prompt,
      tags: s.tags,
    })),
    metadata: {
      sourceProviderId: config.providerId,
      sourceModelId: config.modelId,
      toolIds: config.toolIds,
      mcpServerNames: [...new Set(mcpServerNames)],
    },
  };
}

export async function downloadAgentAsFile(agentId: string): Promise<void> {
  const payload = await exportAgent(agentId);
  const json = JSON.stringify(payload, null, 2);
  const { save } = await import("@tauri-apps/plugin-dialog");
  const path = await save({
    defaultPath: `${payload.agent.name.replace(/\s+/g, "-").toLowerCase()}.matrixos-agent.json`,
    filters: [{ name: "MatrixOS Agent", extensions: ["json"] }],
  });
  if (path) {
    const { registerUserPath } = await import("@/lib/user-paths");
    await registerUserPath(path);
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("fs_write", { ctx: { type: "User" }, path, contents: json });
  }
}
