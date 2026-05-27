import { exportAgent } from "@/agents/agent-export";
import { dbSelect } from "@/kernel/ipc-bridge";
import { toolRegistry } from "@/tools/tool-registry";
import type { AgentExportPayload, MCPServerConfig } from "@/types";
import type { ExportPlan, ExportPlanFile, ExportTarget } from "./types";
import { buildClaudeAgent, buildClaudeSkill, buildClaudeMcpJson } from "./claude-format";
import { buildCopilotAgent, buildCopilotPrompt, buildVscodeMcpJson } from "./copilot-format";
import { slugify } from "./yaml-utils";
import { applyExportPlan } from "./file-writer";

export type { ExportTarget, ExportPlan, ExportPlanFile } from "./types";

interface ResolvedExportContext {
  payload: AgentExportPayload;
  toolNames: string[];
  skillSlugs: string[];
  mcpServerNames: string[];
  allMcpServers: MCPServerConfig[];
  warnings: string[];
}

async function resolveContext(agentId: string): Promise<ResolvedExportContext> {
  const payload = await exportAgent(agentId);
  const warnings: string[] = [];

  const toolNames: string[] = [];
  for (const toolId of payload.metadata.toolIds) {
    const tool = toolRegistry.get(toolId);
    if (tool) {
      toolNames.push(tool.name);
    } else {
      warnings.push(`Tool "${toolId}" could not be resolved at export time and was omitted.`);
    }
  }

  const skillSlugs = payload.skills.map((s) => slugify(s.name));
  const mcpRows = await dbSelect<{ id: string; name: string; transport_json: string; enabled: number }>(
    "SELECT id, name, transport_json, enabled FROM mcp_servers ORDER BY created_at ASC",
  );
  // transport_json contains the full McpServerConfig JSON written by mcp_set_server_config.
  // Override id/name/enabled from the canonical columns.
  const allMcpServers: MCPServerConfig[] = mcpRows.map((r) =>
    ({
      ...(JSON.parse(r.transport_json) as MCPServerConfig),
      id: r.id,
      name: r.name,
      enabled: r.enabled === 1,
    }) as MCPServerConfig,
  );
  const mcpServerNames = payload.metadata.mcpServerNames;

  return { payload, toolNames, skillSlugs, mcpServerNames, allMcpServers, warnings };
}

function buildClaudePlan(ctx: ResolvedExportContext): ExportPlanFile[] {
  const files: ExportPlanFile[] = [];
  files.push(buildClaudeAgent(ctx.payload, ctx.toolNames, ctx.skillSlugs, ctx.mcpServerNames));
  for (const skill of ctx.payload.skills) {
    files.push(buildClaudeSkill(skill));
  }
  const mcp = buildClaudeMcpJson(ctx.mcpServerNames, ctx.allMcpServers);
  if (mcp) files.push(mcp);
  return files;
}

function buildCopilotPlan(ctx: ResolvedExportContext): { files: ExportPlanFile[]; warnings: string[] } {
  const files: ExportPlanFile[] = [];
  const warnings: string[] = [];
  files.push(buildCopilotAgent(ctx.payload, ctx.toolNames, ctx.skillSlugs));
  for (const skill of ctx.payload.skills) {
    files.push(buildCopilotPrompt(skill));
  }
  const mcp = buildVscodeMcpJson(ctx.mcpServerNames, ctx.allMcpServers);
  if (mcp) files.push(mcp);
  if (ctx.payload.skills.length > 0) {
    warnings.push(
      "Copilot has no native concept of an agent-attached skill list; skills were exported as separate prompts and referenced inline in the agent body.",
    );
  }
  return { files, warnings };
}

export async function exportAgentToMarkdown(
  agentId: string,
  target: ExportTarget,
): Promise<ExportPlan> {
  const ctx = await resolveContext(agentId);
  const files: ExportPlanFile[] = [];
  const warnings = [...ctx.warnings];

  if (ctx.mcpServerNames.length > 0 && ctx.allMcpServers.every((s) => !ctx.mcpServerNames.includes(s.name))) {
    warnings.push(
      `Agent references MCP servers ${ctx.mcpServerNames.join(", ")} but none were found in the MCP store.`,
    );
  }

  if (target === "claude" || target === "both") {
    files.push(...buildClaudePlan(ctx));
  }
  if (target === "copilot" || target === "both") {
    const copilot = buildCopilotPlan(ctx);
    files.push(...copilot.files);
    warnings.push(...copilot.warnings);
  }

  // Dedup by relPath (defensive — Claude/Copilot live in different folders, but a future change could collide)
  const seen = new Set<string>();
  const unique = files.filter((f) => {
    if (seen.has(f.relPath)) return false;
    seen.add(f.relPath);
    return true;
  });

  return { files: unique, warnings };
}

export async function exportAgentToDisk(
  agentId: string,
  target: ExportTarget,
  rootDir: string,
): Promise<{ warnings: string[]; fileCount: number }> {
  const plan = await exportAgentToMarkdown(agentId, target);
  await applyExportPlan(rootDir, plan);
  return { warnings: plan.warnings, fileCount: plan.files.length };
}

export async function exportAgentsToDisk(
  agentIds: string[],
  target: ExportTarget,
  rootDir: string,
): Promise<{ warnings: string[]; fileCount: number; perAgent: Array<{ agentId: string; fileCount: number; error?: string }> }> {
  const merged: ExportPlanFile[] = [];
  const allWarnings: string[] = [];
  const perAgent: Array<{ agentId: string; fileCount: number; error?: string }> = [];
  const seen = new Set<string>();

  for (const id of agentIds) {
    try {
      const plan = await exportAgentToMarkdown(id, target);
      let count = 0;
      for (const file of plan.files) {
        if (seen.has(file.relPath)) continue;
        seen.add(file.relPath);
        merged.push(file);
        count++;
      }
      allWarnings.push(...plan.warnings);
      perAgent.push({ agentId: id, fileCount: count });
    } catch (err) {
      perAgent.push({ agentId: id, fileCount: 0, error: err instanceof Error ? err.message : String(err) });
    }
  }

  await applyExportPlan(rootDir, { files: merged, warnings: allWarnings });
  return { warnings: allWarnings, fileCount: merged.length, perAgent };
}
