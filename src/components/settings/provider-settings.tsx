import { useState, useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useSettingsStore } from "@/stores/settings-store";
import { useUIStore } from "@/stores/ui-store";
import {
  hasProviderApiKey,
  setProviderApiKey,
  deleteProviderApiKey,
} from "@/kernel/secure-store";
import {
  saveProviderConfig,
  deleteProviderConfig,
} from "@/memory/provider-store";
import { createProvider } from "@/providers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SearchableSelect } from "@/components/ui/searchable-select";
import type { ModelConfig, ProviderConfig, ProviderType } from "@/types";
import { CLAUDE_MODELS } from "@/types";
import { OLLAMA_DEFAULT_BASE_URL } from "@/lib/constants";
import { nanoid } from "nanoid";
import { isoNow, cn } from "@/lib/utils";

type TestState = "idle" | "testing" | "ok" | "fail";

const PROVIDER_ICONS: Record<ProviderType, string> = {
  claude: "C",
  ollama: "O",
  "openai-compatible": "OC",
  local: "L",
};

function ProviderCard({
  config,
  onDelete,
}: {
  config: ProviderConfig;
  onDelete: (id: string) => void;
}) {
  const updateProvider = useSettingsStore((s) => s.updateProvider);
  const setActiveProvider = useSettingsStore((s) => s.setActiveProvider);
  const activeProviderId = useSettingsStore((s) => s.activeProviderId);
  const addToast = useUIStore((s) => s.addToast);

  const [apiKey, setApiKey] = useState("");
  const [keyExists, setKeyExists] = useState(false);
  const [name, setName] = useState(config.name);
  const [baseUrl, setBaseUrl] = useState(config.baseUrl ?? "");
  const [saving, setSaving] = useState(false);
  const [testState, setTestState] = useState<TestState>("idle");
  const [discoveredModels, setDiscoveredModels] = useState<ModelConfig[]>([]);

  // Keep local name in sync if config.name changes from elsewhere
  // (e.g., model-discovery saveProviderConfig writes that propagate back).
  useEffect(() => { setName(config.name); }, [config.name]);

  async function commitName() {
    const trimmed = name.trim();
    if (!trimmed) {
      // Empty — revert.
      setName(config.name);
      return;
    }
    if (trimmed === config.name) return;
    const updated = { ...config, name: trimmed, updatedAt: isoNow() };
    await saveProviderConfig(updated);
    updateProvider(config.id, { name: trimmed });
  }

  const needsApiKey =
    config.type === "claude" || config.type === "openai-compatible";
  const needsBaseUrl =
    config.type === "ollama" || config.type === "openai-compatible" || config.type === "local";

  useEffect(() => {
    if (needsApiKey) {
      hasProviderApiKey(config.id).then(setKeyExists);
    }
  }, [config.id, needsApiKey]);

  async function handleSave() {
    setSaving(true);
    try {
      if (needsApiKey && apiKey) {
        await setProviderApiKey(config.id, apiKey);
        setKeyExists(true);
      }
      const updated: ProviderConfig = {
        ...config,
        baseUrl: baseUrl || null,
        enabled: needsApiKey && apiKey ? true : config.enabled,
        updatedAt: isoNow(),
      };
      await saveProviderConfig(updated);
      updateProvider(config.id, updated);
      addToast({ type: "success", message: `${config.name} saved.` });
    } catch {
      addToast({ type: "error", message: "Failed to save provider." });
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTestState("testing");
    try {
      // If the user typed a fresh key in the form, persist it first so the
      // Rust registry sees it on the next validate call. Keys never leave
      // Rust after Phase A — `createProvider` no longer takes a key arg.
      if (needsApiKey && apiKey) {
        await setProviderApiKey(config.id, apiKey);
        setKeyExists(true);
      }
      const testConfig: ProviderConfig = {
        ...config,
        baseUrl: baseUrl || config.baseUrl,
      };
      const provider = createProvider(testConfig);
      const ok = await provider.validateConnection();
      if (ok) {
        setTestState("ok");
        addToast({ type: "success", message: `Connected to ${config.name}` });
        let enabledConfig: ProviderConfig = {
          ...config,
          baseUrl: baseUrl || config.baseUrl,
          enabled: true,
          updatedAt: isoNow(),
        };
        // For providers that discover models from the server (ollama, llama.cpp
        // and other openai-compatible endpoints), fetch the model list now and
        // persist it into config.models so the agent editor can populate its
        // dropdown. Without this, the dropdown stays empty after Test Connection.
        if (config.type === "ollama" || config.type === "openai-compatible" || config.type === "local") {
          try {
            const fetched = await provider.listModels();
            if (fetched.length > 0) {
              setDiscoveredModels(fetched);
              enabledConfig = {
                ...enabledConfig,
                models: fetched,
                defaultModelId: enabledConfig.defaultModelId || fetched[0].id,
              };
            }
          } catch (modelErr) {
            console.warn("Failed to fetch model list after successful test:", modelErr);
          }
        }
        await saveProviderConfig(enabledConfig);
        updateProvider(config.id, {
          enabled: true,
          baseUrl: enabledConfig.baseUrl,
          models: enabledConfig.models,
          defaultModelId: enabledConfig.defaultModelId,
        });
      } else {
        setTestState("fail");
        addToast({
          type: "error",
          message: `Could not connect to ${config.name}`,
        });
      }
    } catch (err) {
      setTestState("fail");
      addToast({
        type: "error",
        message: err instanceof Error ? err.message : "Connection failed",
      });
    }
  }

  const isActive = config.id === activeProviderId;

  return (
    <div
      className={cn(
        "rounded-xl border bg-card transition-all duration-200",
        isActive
          ? "border-primary/50 shadow-sm shadow-primary/5"
          : "border-border hover:border-border/80",
      )}
    >
      {/* Card header */}
      <div className="flex items-center justify-between px-5 py-3.5 border-b border-border/50">
        <div className="flex items-center gap-3 min-w-0">
          <div className={cn(
            "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-xs font-bold",
            isActive
              ? "bg-primary-muted text-primary"
              : "bg-muted text-muted-foreground",
          )}>
            {PROVIDER_ICONS[config.type]}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium truncate">{config.name}</span>
            </div>
            <div className="flex items-center gap-1.5 mt-0.5">
              <span className="text-[11px] text-muted-foreground/70 capitalize px-1.5 py-0.5 rounded bg-muted">
                {config.type}
              </span>
              <span className="text-[11px] text-muted-foreground/50">
                {config.models.length} models
              </span>
            </div>
          </div>
        </div>
        <Button
          size="sm"
          variant={isActive ? "primary" : "ghost"}
          onClick={() => setActiveProvider(isActive ? null : config.id)}
          className="shrink-0"
        >
          {isActive ? "Active" : "Set Active"}
        </Button>
      </div>

      {/* Card body */}
      <div className="px-5 py-4 space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="md:col-span-2">
            <Input
              type="text"
              label="Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => void commitName()}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                if (e.key === "Escape") setName(config.name);
              }}
            />
          </div>

          {needsApiKey && (
            <div className="md:col-span-2">
              <Input
                type="password"
                label="API Key"
                placeholder={
                  keyExists && !apiKey
                    ? "Key saved — enter new key to replace"
                    : config.type === "claude" ? "sk-ant-…" : "gsk_…"
                }
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
            </div>
          )}

          {needsBaseUrl && (
            <div className="md:col-span-2">
              <Input
                type="text"
                label="Base URL"
                placeholder={OLLAMA_DEFAULT_BASE_URL}
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
              />
            </div>
          )}

          {config.type === "local" ? (
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-muted-foreground mb-1">Model</label>
              <div className="text-sm text-foreground/80 rounded-md border border-border bg-muted/50 px-3 py-2">
                {config.models[0]?.name ?? "Will be auto-detected from server at request time"}
              </div>
            </div>
          ) : (
            <div className="md:col-span-2">
              <SearchableSelect
                label="Default Model"
                value={config.defaultModelId}
                options={config.models.map((m) => ({ value: m.id, label: m.name }))}
                onChange={(v) =>
                  updateProvider(config.id, { defaultModelId: v })
                }
                placeholder="Select model..."
                searchPlaceholder="Search models..."
              />
            </div>
          )}
        </div>

        {discoveredModels.length > 0 && (
          <div className="rounded-lg bg-muted/50 border border-border/50 px-3.5 py-2.5">
            <p className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{discoveredModels.length}</span> local model{discoveredModels.length > 1 ? "s" : ""} discovered
            </p>
          </div>
        )}

        {/* Action buttons */}
        <div className="flex items-center gap-2 pt-1">
          <Button
            size="sm"
            variant="secondary"
            onClick={handleTest}
            loading={testState === "testing"}
            className={cn(
              testState === "ok" && "border-success/30 text-success",
              testState === "fail" && "border-destructive/30 text-destructive",
            )}
          >
            {testState === "ok" ? (
              <><svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg> Connected</>
            ) : testState === "fail" ? (
              <><svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg> Failed</>
            ) : "Test Connection"}
          </Button>
          {(needsApiKey || needsBaseUrl) && (
            <Button
              size="sm"
              variant="primary"
              onClick={handleSave}
              loading={saving}
            >
              Save
            </Button>
          )}
          <div className="flex-1" />
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onDelete(config.id)}
            className="text-muted-foreground hover:text-destructive"
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
            </svg>
            Remove
          </Button>
        </div>
      </div>
    </div>
  );
}

const PROVIDER_TEMPLATES: Record<
  ProviderType,
  Omit<ProviderConfig, "id" | "createdAt" | "updatedAt">
> = {
  claude: {
    type: "claude",
    name: "Anthropic Claude",
    baseUrl: null,
    enabled: false,
    models: CLAUDE_MODELS as ModelConfig[],
    defaultModelId: "claude-sonnet-4-6",
    rateLimit: { requestsPerMinute: 60, tokensPerMinute: 100_000 },
  },
  ollama: {
    type: "ollama",
    name: "Ollama (Local)",
    baseUrl: OLLAMA_DEFAULT_BASE_URL,
    enabled: false,
    models: [],
    defaultModelId: "",
    rateLimit: { requestsPerMinute: 120, tokensPerMinute: 500_000 },
  },
  "openai-compatible": {
    type: "openai-compatible",
    name: "OpenAI-Compatible",
    baseUrl: "",
    enabled: false,
    models: [],
    defaultModelId: "",
    rateLimit: { requestsPerMinute: 60, tokensPerMinute: 100_000 },
  },
  local: {
    type: "local",
    name: "Local (llama.cpp)",
    // llama.cpp / vLLM / LM Studio serve OpenAI-compat endpoints under /v1/.
    // Base URL must include /v1 — matches the openai-compatible convention.
    baseUrl: "http://127.0.0.1:8080/v1",
    enabled: false,
    models: [],
    defaultModelId: "",
    rateLimit: { requestsPerMinute: 120, tokensPerMinute: 500_000 },
  },
};

export function ProviderSettings() {
  const providers = useSettingsStore((s) => s.providers);
  const addProvider = useSettingsStore((s) => s.addProvider);
  const removeProvider = useSettingsStore((s) => s.removeProvider);
  const navigate = useNavigate();
  const addToast = useUIStore((s) => s.addToast);

  async function handleAddProvider(type: ProviderType) {
    const template = PROVIDER_TEMPLATES[type];
    const now = isoNow();
    const config: ProviderConfig = {
      ...template,
      id: nanoid(),
      createdAt: now,
      updatedAt: now,
    };
    await saveProviderConfig(config);
    addProvider(config);
  }

  async function handleDeleteProvider(id: string) {
    try {
      await deleteProviderApiKey(id);
      await deleteProviderConfig(id);
      removeProvider(id);
    } catch {
      addToast({ type: "error", message: "Failed to delete provider." });
    }
  }

  const addableTypes: ProviderType[] = [
    "claude",
    "ollama",
    "openai-compatible",
    "local",
  ];

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Header */}
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-border/60 bg-card/30 px-5">
        <button
          onClick={() => navigate({ to: "/chat" })}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18" />
          </svg>
          Back
        </button>
        <span className="text-sm font-medium">Provider Settings</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl p-5 space-y-4">
          {providers.map((config) => (
            <ProviderCard
              key={config.id}
              config={config}
              onDelete={handleDeleteProvider}
            />
          ))}

          {/* Add provider */}
          <div className="flex flex-wrap gap-2 pt-1">
            {addableTypes.map((type) => (
                <Button
                  key={type}
                  size="sm"
                  variant="ghost"
                  onClick={() => handleAddProvider(type)}
                  className="border border-dashed border-border hover:border-border/80"
                >
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                  </svg>
                  {PROVIDER_TEMPLATES[type].name}
                </Button>
              ))}
          </div>
        </div>
      </div>
    </div>
  );
}
