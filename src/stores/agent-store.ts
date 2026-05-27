import { create } from "zustand";
import type { AgentConfig, AgentInstance } from "@/types";

interface AgentState {
  configs: AgentConfig[];
  instances: Map<string, AgentInstance>;

  setConfigs: (configs: AgentConfig[]) => void;
  addConfig: (config: AgentConfig) => void;
  updateConfig: (id: string, updates: Partial<AgentConfig>) => void;
  removeConfig: (id: string) => void;
  setInstance: (instanceId: string, instance: AgentInstance) => void;
  updateInstance: (
    instanceId: string,
    updates: Partial<AgentInstance>,
  ) => void;
  removeInstance: (instanceId: string) => void;
}

export const useAgentStore = create<AgentState>((set) => ({
  configs: [],
  instances: new Map(),

  setConfigs: (configs) => set({ configs }),
  addConfig: (config) =>
    set((s) => ({ configs: [...s.configs, config] })),
  updateConfig: (id, updates) =>
    set((s) => ({
      configs: s.configs.map((c) =>
        c.id === id ? { ...c, ...updates } : c,
      ),
    })),
  removeConfig: (id) =>
    set((s) => ({
      configs: s.configs.filter((c) => c.id !== id),
    })),
  setInstance: (instanceId, instance) =>
    set((s) => {
      const next = new Map(s.instances);
      next.set(instanceId, instance);
      return { instances: next };
    }),
  updateInstance: (instanceId, updates) =>
    set((s) => {
      const existing = s.instances.get(instanceId);
      if (!existing) return s;
      const next = new Map(s.instances);
      next.set(instanceId, { ...existing, ...updates });
      return { instances: next };
    }),
  removeInstance: (instanceId) =>
    set((s) => {
      const next = new Map(s.instances);
      next.delete(instanceId);
      return { instances: next };
    }),
}));
