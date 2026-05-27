import { create } from "zustand";
import type {
  MCPConnectionInfo,
  MCPServerConfig,
  MCPToolDefinition,
} from "@/types";

interface MCPState {
  servers: MCPServerConfig[];
  connections: Map<string, MCPConnectionInfo>;
  discoveredTools: Map<string, MCPToolDefinition[]>;

  setServers: (servers: MCPServerConfig[]) => void;
  addServer: (config: MCPServerConfig) => void;
  updateServer: (id: string, updates: Partial<MCPServerConfig>) => void;
  removeServer: (id: string) => void;
  setConnectionState: (
    serverId: string,
    state: MCPConnectionInfo,
  ) => void;
  setDiscoveredTools: (
    serverId: string,
    tools: MCPToolDefinition[],
  ) => void;
}

export const useMCPStore = create<MCPState>((set) => ({
  servers: [],
  connections: new Map(),
  discoveredTools: new Map(),

  setServers: (servers) => set({ servers }),
  addServer: (config) =>
    set((s) => ({ servers: [...s.servers, config] })),
  updateServer: (id, updates) =>
    set((s) => ({
      servers: s.servers.map((srv) =>
        srv.id === id ? ({ ...srv, ...updates } as MCPServerConfig) : srv,
      ),
    })),
  removeServer: (id) =>
    set((s) => {
      const connections = new Map(s.connections);
      connections.delete(id);
      const discoveredTools = new Map(s.discoveredTools);
      discoveredTools.delete(id);
      return {
        servers: s.servers.filter((srv) => srv.id !== id),
        connections,
        discoveredTools,
      };
    }),
  setConnectionState: (serverId, state) =>
    set((s) => {
      const connections = new Map(s.connections);
      connections.set(serverId, state);
      return { connections };
    }),
  setDiscoveredTools: (serverId, tools) =>
    set((s) => {
      const discoveredTools = new Map(s.discoveredTools);
      discoveredTools.set(serverId, tools);
      return { discoveredTools };
    }),
}));
