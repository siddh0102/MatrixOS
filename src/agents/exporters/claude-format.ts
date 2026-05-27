import type { AgentExportPayload, MCPServerConfig } from "@/types";
import type { ExportPlanFile } from "./types";
import { slugify, toFrontmatter } from "./yaml-utils";

export interface SkillRef {
  name: string;
  description: string;
  category: string;
  prompt: string;
  tags: string[];
}

export function buildClaudeAgent(
  payload: AgentExportPayload,
  toolNames: string[],
  skillSlugs: string[],
  mcpServerNames: string[],
): ExportPlanFile {
  const agent = payload.agent;
  const slug = slugify(agent.name);

  const frontmatter: Record<string, unknown> = {
    name: slug,
    description: agent.description || agent.name,
    model: payload.metadata.sourceModelId,
  };

  if (toolNames.length > 0) frontmatter.tools = toolNames;
  if (skillSlugs.length > 0) frontmatter.skills = skillSlugs;
  if (mcpServerNames.length > 0) frontmatter.mcpServers = mcpServerNames;

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

  const contents = toFrontmatter(frontmatter) + "\n" + agent.systemPrompt.trimEnd() + "\n";

  return {
    relPath: `.claude/agents/${slug}.md`,
    contents,
  };
}

export function buildClaudeSkill(skill: SkillRef): ExportPlanFile {
  const slug = slugify(skill.name);

  const frontmatter: Record<string, unknown> = {
    name: slug,
    description: skill.description || skill.name,
  };
  if (skill.tags.length > 0) frontmatter.tags = skill.tags;
  frontmatter.matrixos = {
    category: skill.category,
  };

  const contents = toFrontmatter(frontmatter) + "\n" + skill.prompt.trimEnd() + "\n";

  return {
    relPath: `.claude/skills/${slug}/SKILL.md`,
    contents,
  };
}

export function buildClaudeMcpJson(
  serverNames: string[],
  allServers: MCPServerConfig[],
): ExportPlanFile | null {
  if (serverNames.length === 0) return null;
  const matched = allServers.filter((s) => serverNames.includes(s.name));
  if (matched.length === 0) return null;

  const mcpServers: Record<string, unknown> = {};
  for (const server of matched) {
    if (server.transport === "stdio") {
      mcpServers[server.name] = {
        command: server.command,
        args: server.args,
        ...(Object.keys(server.env).length > 0 ? { env: server.env } : {}),
      };
    } else {
      mcpServers[server.name] = {
        type: "http",
        url: server.baseUrl,
        ...(server.headers ? { headers: server.headers } : {}),
      };
    }
  }

  return {
    relPath: ".mcp.json",
    contents: JSON.stringify({ mcpServers }, null, 2) + "\n",
  };
}
