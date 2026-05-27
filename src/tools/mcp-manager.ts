import type {
  MCPConnectionState,
  MCPServerConfig,
  MCPToolDefinition,
} from "@/types";
import { McpConnection } from "./mcp-connection";
import { toolRegistry } from "./tool-registry";
import { eventBus } from "@/orchestration/event-bus";
import { useMCPStore } from "@/stores/mcp-store";
import { isoNow } from "@/lib/utils";

type ConnectionState = MCPConnectionState | "saved";

function pushConnectionState(
  serverId: string,
  state: MCPConnectionState,
  opts: { startedAt?: string | null; toolCount?: number; error?: string | null } = {},
) {
  const existing = useMCPStore.getState().connections.get(serverId);
  useMCPStore.getState().setConnectionState(serverId, {
    serverId,
    state,
    startedAt: opts.startedAt ?? existing?.startedAt ?? null,
    discoveredToolCount: opts.toolCount ?? existing?.discoveredToolCount ?? 0,
    error: opts.error ?? null,
  });
}

class MCPManager {
  private connections = new Map<string, McpConnection>();
  private configs = new Map<string, MCPServerConfig>();
  private states = new Map<string, ConnectionState>();
  private toolCache = new Map<string, MCPToolDefinition[]>();

  async addServer(config: MCPServerConfig): Promise<void> {
    this.configs.set(config.id, config);

    if (!config.enabled) {
      this.states.set(config.id, "disabled");
      eventBus.emit(
        "mcp:server_disabled",
        { serverId: config.id },
        "mcp-manager",
      );
      return;
    }

    await this.startConnection(config);
  }

  async removeServer(id: string): Promise<void> {
    const conn = this.connections.get(id);
    if (conn) {
      try { await conn.disconnect(); } catch { /* ignore */ }
      this.connections.delete(id);
    }
    this.configs.delete(id);
    this.states.delete(id);
    this.toolCache.delete(id);
    this.unregisterServerTools(id);
  }

  async restartServer(id: string): Promise<void> {
    const config = this.configs.get(id);
    if (!config) return;

    const conn = this.connections.get(id);
    if (conn) {
      try { await conn.disconnect(); } catch { /* ignore — server may already be down */ }
      this.connections.delete(id);
    }
    this.unregisterServerTools(id);
    await this.startConnection(config);
  }

  async executeToolOnServer(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const conn = this.connections.get(serverId);
    if (!conn || this.states.get(serverId) !== "ready") {
      throw new Error(`MCP server ${serverId} is not connected`);
    }
    return conn.executeTool(toolName, args);
  }

  getServer(id: string): MCPServerConfig | undefined {
    return this.configs.get(id);
  }

  listServers(): MCPServerConfig[] {
    return [...this.configs.values()];
  }

  getServerState(id: string): ConnectionState | undefined {
    return this.states.get(id);
  }

  getDiscoveredTools(serverId: string): MCPToolDefinition[] {
    return this.toolCache.get(serverId) ?? [];
  }

  getAllTools(): Array<{ serverId: string; tools: MCPToolDefinition[] }> {
    const result: Array<{ serverId: string; tools: MCPToolDefinition[] }> = [];
    for (const [serverId, tools] of this.toolCache) {
      if (tools.length > 0) {
        result.push({ serverId, tools });
      }
    }
    return result;
  }

  async loadAndStartAll(configs: MCPServerConfig[]): Promise<void> {
    for (const config of configs) {
      try {
        await this.addServer(config);
      } catch {
        /* individual server failures don't block others */
      }
    }
  }

  async shutdownAll(): Promise<void> {
    const stops = [...this.connections.keys()].map((id) =>
      this.removeServer(id),
    );
    await Promise.allSettled(stops);
  }

  private async startConnection(config: MCPServerConfig): Promise<void> {
    this.states.set(config.id, "connecting");
    pushConnectionState(config.id, "connecting");
    eventBus.emit(
      "mcp:server_connecting",
      { serverId: config.id },
      "mcp-manager",
    );

    const conn = new McpConnection(config.id);

    conn.onServerCrash((exitCode) => {
      this.states.set(config.id, "error");
      this.connections.delete(config.id);
      pushConnectionState(config.id, "error", { error: `crashed (exit ${exitCode ?? "?"})` });
      eventBus.emit(
        "mcp:server_crashed",
        { serverId: config.id, exitCode },
        "mcp-manager",
      );
    });

    conn.onServerStderr((line) => {
      // MCP servers use stderr as their info/log channel — stdout is reserved
      // for JSON-RPC traffic. Forward at `log` severity to avoid mislabeling
      // benign startup messages (e.g. "Server running on stdio") as errors.
      // If a server genuinely encodes an error level into the line text
      // (e.g. starts with "ERROR" / "FATAL"), escalate.
      const upper = line.trimStart().slice(0, 8).toUpperCase();
      if (upper.startsWith("ERROR") || upper.startsWith("FATAL")) {
        console.error(`[MCP ${config.id}] stderr: ${line}`);
      } else {
        console.log(`[MCP ${config.id}] stderr: ${line}`);
      }
    });

    this.connections.set(config.id, conn);

    try {
      await conn.connect();

      // MCP protocol requires `initialize` before any other request. The
      // server will not respond to `tools/list` until it has received an
      // `initialize` and the matching `notifications/initialized` follow-up.
      await conn.sendRequest({
        jsonrpc: "2.0",
        id: -1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "MatrixOS", version: "0.1.0" },
        },
      });
      await conn.sendNotification("notifications/initialized");

      // Now the server is ready for capability queries.
      const listResp = await conn.sendRequest({
        jsonrpc: "2.0",
        id: 0,
        method: "tools/list",
        params: {},
      });

      const tools: MCPToolDefinition[] = [];
      if (listResp.result && typeof listResp.result === "object") {
        const result = listResp.result as { tools?: MCPToolDefinition[] };
        if (Array.isArray(result.tools)) {
          for (const t of result.tools) {
            tools.push({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            });
          }
        }
      }

      this.toolCache.set(config.id, tools);
      this.registerServerTools(config.id, config.name, tools);
      this.states.set(config.id, "ready");
      useMCPStore.getState().setDiscoveredTools(config.id, tools);
      pushConnectionState(config.id, "ready", {
        startedAt: isoNow(),
        toolCount: tools.length,
      });

      eventBus.emit(
        "mcp:server_ready",
        { serverId: config.id },
        "mcp-manager",
      );
      eventBus.emit(
        "mcp:tools_discovered",
        { serverId: config.id, tools },
        "mcp-manager",
      );
    } catch (err) {
      this.states.set(config.id, "error");
      pushConnectionState(config.id, "error", {
        error: err instanceof Error ? err.message : String(err),
      });
      eventBus.emit(
        "mcp:server_error",
        {
          serverId: config.id,
          error: err instanceof Error ? err.message : String(err),
          timestamp: isoNow(),
        },
        "mcp-manager",
      );
      throw err;
    }
  }

  private registerServerTools(
    serverId: string,
    serverName: string,
    tools: MCPToolDefinition[],
  ): void {
    this.unregisterServerTools(serverId);
    for (const tool of tools) {
      toolRegistry.register({
        serverId,
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        tags: ["mcp", serverName],
      });
    }
  }

  private unregisterServerTools(serverId: string): void {
    const tools = toolRegistry.list();
    for (const tool of tools) {
      if (tool.serverId === serverId) {
        toolRegistry.unregister(tool.id);
      }
    }
  }
}

export const mcpManager = new MCPManager();
