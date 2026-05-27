import type { DelegationConfig, AgentConfig } from "@/types";

interface DelegationConfigSectionProps {
  config: DelegationConfig;
  onChange: (config: DelegationConfig) => void;
  availableAgents: Array<Pick<AgentConfig, "id" | "name">>;
  currentAgentId?: string;
}

export function DelegationConfigSection({
  config,
  onChange,
  availableAgents,
  currentAgentId,
}: DelegationConfigSectionProps) {
  const otherAgents = availableAgents.filter((a) => a.id !== currentAgentId);

  function toggleAgent(agentId: string) {
    const ids = config.allowedAgentIds.includes(agentId)
      ? config.allowedAgentIds.filter((id) => id !== agentId)
      : [...config.allowedAgentIds, agentId];
    onChange({ ...config, allowedAgentIds: ids });
  }

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold text-foreground">Agent Delegation</h3>

      <div className="flex items-center justify-between">
        <div>
          <label className="text-sm font-medium">Enable delegation</label>
          <p className="text-xs text-muted-foreground mt-0.5">
            Allow this agent to delegate tasks to other agents.
          </p>
        </div>
        <button
          type="button"
          onClick={() => onChange({ ...config, enabled: !config.enabled })}
          className={`relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors ${
            config.enabled ? "bg-primary" : "bg-muted"
          }`}
        >
          <span
            className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${
              config.enabled ? "translate-x-4" : "translate-x-0"
            }`}
          />
        </button>
      </div>

      {config.enabled && (
        <div className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Allowed agents</label>
            {otherAgents.length === 0 ? (
              <p className="text-xs text-muted-foreground">No other agents available.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {otherAgents.map((agent) => {
                  const selected = config.allowedAgentIds.includes(agent.id);
                  return (
                    <button
                      key={agent.id}
                      type="button"
                      onClick={() => toggleAgent(agent.id)}
                      className={`rounded-full px-3 py-1 text-xs font-medium border transition-colors ${
                        selected
                          ? "bg-primary text-primary-foreground border-primary"
                          : "bg-transparent text-foreground border-border hover:border-primary"
                      }`}
                    >
                      {agent.name}
                    </button>
                  );
                })}
              </div>
            )}
            {config.enabled && config.allowedAgentIds.length === 0 && (
              <p className="text-xs text-destructive">Select at least one agent to enable delegation.</p>
            )}
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Max depth</label>
              <input
                type="number"
                min={1}
                max={5}
                value={config.maxDelegationDepth}
                onChange={(e) => onChange({ ...config, maxDelegationDepth: Number(e.target.value) })}
                className="w-full rounded border border-input bg-background px-2 py-1 text-sm"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Max tokens</label>
              <input
                type="number"
                min={1000}
                max={16000}
                step={1000}
                value={config.maxDelegationTokens}
                onChange={(e) => onChange({ ...config, maxDelegationTokens: Number(e.target.value) })}
                className="w-full rounded border border-input bg-background px-2 py-1 text-sm"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Timeout (s)</label>
              <input
                type="number"
                min={10}
                max={300}
                value={Math.round(config.maxDelegationTimeoutMs / 1000)}
                onChange={(e) =>
                  onChange({ ...config, maxDelegationTimeoutMs: Number(e.target.value) * 1000 })
                }
                className="w-full rounded border border-input bg-background px-2 py-1 text-sm"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
