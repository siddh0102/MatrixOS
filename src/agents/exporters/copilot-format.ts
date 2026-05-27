import type { AgentExportPayload, MCPServerConfig } from "@/types";
import type { ExportPlanFile } from "./types";
import type { SkillRef } from "./claude-format";
import { slugify, toFrontmatter } from "./yaml-utils";

export function buildCopilotAgent(
  payload: AgentExportPayload,
  toolNames: string[],
  skillSlugs: string[],
): ExportPlanFile {
  const agent = payload.agent;
  const slug = slugify(agent.name);

  const frontmatter: Record<string, unknown> = {
    name: slug,
    description: agent.description || agent.name,
    model: payload.metadata.sourceModelId,
  };

  if (toolNames.length > 0) frontmatter.tools = toolNames;

  frontmatter.matrixos = {
    sourceProviderId: payload.metadata.sourceProviderId,
    category: agent.category,
    temperature: agent.temperature,
    maxTokens: agent.maxTokens,
    maxConversationHistory: agent.maxConversationHistory,
    memoryConfig: agent.memoryConfig,
    thinkingConfig: agent.thinkingConfig,
    delegationConfig: agent.delegationConfig,
    scheduleConfig: agent.scheduleConfig,
    exportedAt: payload.exportedAt,
  };

  let body = agent.systemPrompt.trimEnd();
  if (skillSlugs.length > 0) {
    const promptRefs = skillSlugs.map((s) => `\`/${s}\``).join(", ");
    body += `\n\n---\n\nAvailable prompts: ${promptRefs}`;
  }

  return {
    relPath: `.github/agents/${slug}.agent.md`,
    contents: toFrontmatter(frontmatter) + "\n" + body + "\n",
  };
}

export function buildCopilotPrompt(skill: SkillRef): ExportPlanFile {
  const slug = slugify(skill.name);

  const frontmatter: Record<string, unknown> = {
    description: skill.description || skill.name,
    mode: "agent",
  };
  frontmatter.matrixos = {
    category: skill.category,
    tags: skill.tags,
  };

  return {
    relPath: `.github/prompts/${slug}.prompt.md`,
    contents: toFrontmatter(frontmatter) + "\n" + skill.prompt.trimEnd() + "\n",
  };
}

export function buildVscodeMcpJson(
  serverNames: string[],
  allServers: MCPServerConfig[],
): ExportPlanFile | null {
  if (serverNames.length === 0) return null;
  const matched = allServers.filter((s) => serverNames.includes(s.name));
  if (matched.length === 0) return null;

  const servers: Record<string, unknown> = {};
  for (const server of matched) {
    if (server.transport === "stdio") {
      servers[server.name] = {
        type: "stdio",
        command: server.command,
        args: server.args,
        ...(Object.keys(server.env).length > 0 ? { env: server.env } : {}),
      };
    } else {
      servers[server.name] = {
        type: "http",
        url: server.baseUrl,
        ...(server.headers ? { headers: server.headers } : {}),
      };
    }
  }

  return {
    relPath: ".vscode/mcp.json",
    contents: JSON.stringify({ servers }, null, 2) + "\n",
  };
}
