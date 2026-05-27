import { create } from "zustand";
import type { ProviderConfig, ProcessManagerConfig } from "@/types";

interface SettingsState {
  providers: ProviderConfig[];
  activeProviderId: string | null;
  processConfig: Partial<ProcessManagerConfig> | null;

  setProviders: (providers: ProviderConfig[]) => void;
  addProvider: (config: ProviderConfig) => void;
  updateProvider: (id: string, updates: Partial<ProviderConfig>) => void;
  removeProvider: (id: string) => void;
  setActiveProvider: (id: string | null) => void;
  getActiveProvider: () => ProviderConfig | undefined;
  getProvider: (id: string) => ProviderConfig | undefined;
  setProcessConfig: (config: Partial<ProcessManagerConfig>) => void;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  providers: [],
  activeProviderId: null,
  processConfig: null,

  setProviders: (providers) => set({ providers }),
  addProvider: (config) =>
    set((s) => ({ providers: [...s.providers, config] })),
  updateProvider: (id, updates) =>
    set((s) => ({
      providers: s.providers.map((p) =>
        p.id === id ? { ...p, ...updates } : p,
      ),
    })),
  removeProvider: (id) =>
    set((s) => ({
      providers: s.providers.filter((p) => p.id !== id),
      activeProviderId:
        s.activeProviderId === id ? null : s.activeProviderId,
    })),
  setActiveProvider: (id) => set({ activeProviderId: id }),
  getActiveProvider: () => {
    const { providers, activeProviderId } = get();
    return providers.find((p) => p.id === activeProviderId);
  },
  getProvider: (id) => {
    return get().providers.find((p) => p.id === id);
  },
  setProcessConfig: (config) => set({ processConfig: config }),
}));
