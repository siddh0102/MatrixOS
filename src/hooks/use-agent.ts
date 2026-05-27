import { useAgentStore } from "@/stores/agent-store";
import { useTabStore, useCurrentAgentId } from "@/stores/tab-store";
import {
  saveAgentConfig,
  deleteAgentConfig,
} from "@/memory/agent-store-sql";
import type { AgentConfig } from "@/types";

export function useAgent() {
  const configs = useAgentStore((s) => s.configs);
  const updateConfig = useAgentStore((s) => s.updateConfig);
  const addConfig = useAgentStore((s) => s.addConfig);
  const removeConfig = useAgentStore((s) => s.removeConfig);
  const removeInstance = useAgentStore((s) => s.removeInstance);

  // "Current agent" is now derived from the focused tab.
  const currentAgentId = useCurrentAgentId();
  const currentConfig = configs.find((c) => c.id === currentAgentId) ?? null;

  async function saveAgent(config: AgentConfig): Promise<void> {
    await saveAgentConfig(config);
    const exists = configs.some((c) => c.id === config.id);
    if (exists) {
      updateConfig(config.id, config);
    } else {
      addConfig(config);
    }
  }

  async function deleteAgent(id: string): Promise<void> {
    await deleteAgentConfig(id);
    const { tabs, closeTab } = useTabStore.getState();
    tabs.filter((t) => t.agentId === id).forEach((t) => closeTab(t.id));
    removeConfig(id);
    removeInstance(id + "-inst");
  }

  return {
    configs,
    currentAgentId,
    currentConfig,
    saveAgent,
    deleteAgent,
  };
}
