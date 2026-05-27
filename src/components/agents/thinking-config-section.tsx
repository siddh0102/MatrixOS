import type { ThinkingConfig } from "@/types";

interface ThinkingConfigSectionProps {
  config: ThinkingConfig;
  onChange: (config: ThinkingConfig) => void;
  modelSupportsThinking: boolean;
}

export function ThinkingConfigSection({ config, onChange, modelSupportsThinking }: ThinkingConfigSectionProps) {
  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold text-foreground">Thinking / Reasoning</h3>

      <div className={`space-y-4 ${!modelSupportsThinking ? "opacity-50 pointer-events-none" : ""}`}>
        <div className="flex items-center justify-between">
          <div>
            <label className="text-sm font-medium">Enable thinking mode</label>
            <p className="text-xs text-muted-foreground mt-0.5">
              The model will reason step-by-step before responding.
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
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">Thinking token budget</label>
              <span className="text-xs text-muted-foreground font-mono">
                {config.budgetTokens === 0 ? "Model default" : config.budgetTokens.toLocaleString()}
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={50000}
              step={1000}
              value={config.budgetTokens}
              onChange={(e) => onChange({ ...config, budgetTokens: Number(e.target.value) })}
              className="w-full"
            />
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>Model default</span>
              <span>50,000</span>
            </div>
            <p className="text-xs text-muted-foreground bg-muted/40 rounded px-2 py-1.5">
              Temperature is locked to 1 when thinking is enabled (required by Claude API).
            </p>
          </div>
        )}
      </div>

      {!modelSupportsThinking && (
        <p className="text-xs text-muted-foreground">
          The selected model does not support extended thinking.
        </p>
      )}
    </div>
  );
}
