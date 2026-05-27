import type { Tool } from "@/types";

class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(definition: Omit<Tool, "id">): Tool {
    // Deterministic id: `${serverId}:${name}`. The registry is in-memory and
    // resets every session, so a random nanoid would invalidate any
    // agent.toolIds saved in the DB between sessions. A stable key from
    // (serverId, name) survives restarts and is naturally idempotent.
    const id = `${definition.serverId}:${definition.name}`;
    const tool: Tool = { ...definition, id };
    this.tools.set(id, tool);
    return tool;
  }

  unregister(id: string): boolean {
    return this.tools.delete(id);
  }

  get(id: string): Tool | undefined {
    return this.tools.get(id);
  }

  getByName(name: string): Tool | undefined {
    for (const tool of this.tools.values()) {
      if (tool.name === name) return tool;
    }
    return undefined;
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  clear(): void {
    this.tools.clear();
  }
}

export const toolRegistry = new ToolRegistry();
