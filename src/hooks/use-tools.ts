import { toolRegistry } from "@/tools/tool-registry";
import { mcpManager } from "@/tools/mcp-manager";
import type { Tool, MCPToolDefinition } from "@/types";

export function useTools() {
  function listTools(): Tool[] {
    return toolRegistry.list();
  }

  function getTool(id: string): Tool | undefined {
    return toolRegistry.get(id);
  }

  function listMCPTools(): Array<{
    serverId: string;
    tools: MCPToolDefinition[];
  }> {
    return mcpManager.getAllTools();
  }

  return { listTools, getTool, listMCPTools };
}
