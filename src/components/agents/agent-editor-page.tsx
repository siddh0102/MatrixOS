import { useState, useEffect, useRef } from "react";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useAgent } from "@/hooks/use-agent";
import { useProvider } from "@/hooks/use-provider";
import { useTools } from "@/hooks/use-tools";
import { useLibraryStore } from "@/stores/library-store";
import { useAgentEditorDraftStore } from "@/stores/agent-editor-draft-store";
import { createDefaultConfig } from "@/agents/agent-factory";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Slider } from "@/components/ui/slider";
import { Chip } from "@/components/ui/chip";
import { SkillAttachmentSection } from "./skill-attachment-section";
import { ToolApprovalSection } from "./tool-approval-section";
import { SandboxSection } from "./sandbox-section";
import { MemorySettingsSection } from "./memory-settings-section";
import { SkillEditorDialog } from "@/components/library/skill-editor-dialog";
import { useLibrary } from "@/hooks/use-library";
import { DEFAULT_MEMORY_CONFIG } from "@/memory/memory-defaults";
import { ThinkingConfigSection } from "./thinking-config-section";
import { DelegationConfigSection } from "./delegation-config-section";
import { downloadAgentAsFile } from "@/agents/agent-export";
import { exportAgentToDisk } from "@/agents/exporters";
import { useUIStore } from "@/stores/ui-store";
import { useMCPStore } from "@/stores/mcp-store";
import type { AgentConfig, ApprovalConfig, SandboxConfig, MemoryConfig, ThinkingConfig, DelegationConfig } from "@/types";

export function AgentEditorPage() {
  const navigate = useNavigate();
  const params = useParams({ strict: false });
  const agentId = (params as { id?: string }).id;
  const isEditMode = !!agentId;

  const { configs, saveAgent } = useAgent();
  const { providers } = useProvider();
  const { listTools } = useTools();
  const agentTemplates = useLibraryStore((s) => s.agentTemplates);
  const { importedSkills, updateSkill, resetSkillToBundle } = useLibrary();

  const { templateId } = useSearch({ strict: false }) as { templateId?: string };

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [providerId, setProviderId] = useState("");
  const [modelId, setModelId] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("You are a helpful AI assistant.");
  const [temperature, setTemperature] = useState(0.7);
  const [maxTokens, setMaxTokens] = useState(4096);
  const [maxHistory, setMaxHistory] = useState(50);
  const [selectedToolIds, setSelectedToolIds] = useState<string[]>([]);
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([]);
  const [approvalMode, setApprovalMode] = useState<ApprovalConfig["mode"]>("always-ask");
  const [perToolOverrides, setPerToolOverrides] = useState<Record<string, "auto" | "prompt" | "deny">>({});
  const [fallbackIds, setFallbackIds] = useState<string[]>([]);
  const [sandbox, setSandbox] = useState<SandboxConfig>({ enabled: false, allowedPaths: [] });
  const [memoryConfig, setMemoryConfig] = useState<MemoryConfig>(DEFAULT_MEMORY_CONFIG);
  const [thinkingConfig, setThinkingConfig] = useState<ThinkingConfig>({ enabled: false, budgetTokens: 0 });
  const [delegationConfig, setDelegationConfig] = useState<DelegationConfig>({
    enabled: false,
    allowedAgentIds: [],
    maxDelegationDepth: 3,
    maxDelegationTokens: 4096,
    maxDelegationTimeoutMs: 60_000,
  });
  const [editingSkillId, setEditingSkillId] = useState<string | null>(null);
  const addToast = useUIStore((s) => s.addToast);
  const editingSkill = editingSkillId ? (importedSkills.find((s) => s.id === editingSkillId) ?? null) : null;

  // Keyed in-memory draft so unsaved edits survive when the user navigates
  // away (e.g. to /library to import a skill) and comes back.
  const draftKey = isEditMode ? `edit:${agentId}` : (templateId ? `new:${templateId}` : "new");
  const hasHydratedRef = useRef(false);

  useEffect(() => {
    if (hasHydratedRef.current) return;

    const draft = useAgentEditorDraftStore.getState().getDraft(draftKey);
    if (draft) {
      setName(draft.name);
      setDescription(draft.description);
      setProviderId(draft.providerId);
      setModelId(draft.modelId);
      setSystemPrompt(draft.systemPrompt);
      setTemperature(draft.temperature);
      setMaxTokens(draft.maxTokens);
      setMaxHistory(draft.maxHistory);
      setSelectedToolIds(draft.selectedToolIds);
      setSelectedSkillIds(draft.selectedSkillIds);
      setApprovalMode(draft.approvalMode);
      setPerToolOverrides(draft.perToolOverrides);
      setFallbackIds(draft.fallbackIds);
      setSandbox(draft.sandbox);
      setMemoryConfig(draft.memoryConfig);
      setThinkingConfig(draft.thinkingConfig);
      setDelegationConfig(draft.delegationConfig);
      hasHydratedRef.current = true;
      return;
    }

    if (isEditMode) {
      const existing = configs.find((c) => c.id === agentId);
      if (!existing) return; // wait for configs to load
      // Drop tool ids that no longer resolve in the registry. These are
      // orphans from before the registry switched to deterministic ids;
      // keeping them in state would silently re-persist garbage on Save.
      // Skill ids are NOT filtered here — the library store may still be
      // hydrating and would falsely look empty for a few ms after mount.
      const liveToolIds = existing.toolIds.filter((id) => listTools().some((t) => t.id === id));
      const droppedCount = existing.toolIds.length - liveToolIds.length;
      if (droppedCount > 0) {
        addToast({
          type: "info",
          message: `${droppedCount} previously-attached tool${droppedCount === 1 ? "" : "s"} unlinked from this agent (legacy IDs no longer match the registry). Re-attach and Save to refresh.`,
          duration: 8000,
        });
      }
      setName(existing.name);
      setDescription(existing.description);
      setProviderId(existing.providerId);
      setModelId(existing.modelId);
      setSystemPrompt(existing.systemPrompt);
      setTemperature(existing.temperature);
      setMaxTokens(existing.maxTokens);
      setMaxHistory(existing.maxConversationHistory);
      setSelectedToolIds(liveToolIds);
      setSelectedSkillIds(existing.skillIds ?? []);
      setApprovalMode(existing.approvalConfig.mode);
      setPerToolOverrides(existing.approvalConfig.perToolOverrides ?? {});
      setFallbackIds(existing.fallbackProviderIds);
      setSandbox(existing.sandboxConfig ?? { enabled: false, allowedPaths: [] });
      setMemoryConfig(existing.memoryConfig ?? DEFAULT_MEMORY_CONFIG);
      setThinkingConfig(existing.thinkingConfig ?? { enabled: false, budgetTokens: 0 });
      setDelegationConfig(existing.delegationConfig ?? {
        enabled: false,
        allowedAgentIds: [],
        maxDelegationDepth: 3,
        maxDelegationTokens: 4096,
        maxDelegationTimeoutMs: 60_000,
      });
      hasHydratedRef.current = true;
    } else if (templateId) {
      const template = agentTemplates.find((t) => t.id === templateId);
      if (!template) return; // wait for templates to load
      setName(template.name);
      setDescription(template.description);
      setSystemPrompt(template.systemPrompt);
      setTemperature(template.temperature);
      setMaxTokens(template.maxTokens);
      setMaxHistory(template.maxConversationHistory);
      hasHydratedRef.current = true;
    } else {
      // New agent with no template — useState defaults are the starting point.
      hasHydratedRef.current = true;
    }
  }, [isEditMode, agentId, configs, templateId, agentTemplates, draftKey]);

  useEffect(() => {
    if (!hasHydratedRef.current) return;
    useAgentEditorDraftStore.getState().setDraft(draftKey, {
      name,
      description,
      providerId,
      modelId,
      systemPrompt,
      temperature,
      maxTokens,
      maxHistory,
      selectedToolIds,
      selectedSkillIds,
      approvalMode,
      perToolOverrides,
      fallbackIds,
      sandbox,
      memoryConfig,
      thinkingConfig,
      delegationConfig,
    });
  }, [
    draftKey,
    name,
    description,
    providerId,
    modelId,
    systemPrompt,
    temperature,
    maxTokens,
    maxHistory,
    selectedToolIds,
    selectedSkillIds,
    approvalMode,
    perToolOverrides,
    fallbackIds,
    sandbox,
    memoryConfig,
    thinkingConfig,
    delegationConfig,
  ]);

  function handleOverrideChange(key: string, value: "auto" | "prompt" | "deny" | null) {
    setPerToolOverrides((prev) => {
      const next = { ...prev };
      if (value === null) {
        delete next[key];
      } else {
        next[key] = value;
      }
      return next;
    });
  }

  const enabledProviders = providers.filter((p) => p.enabled);
  const selectedProvider = providers.find((p) => p.id === providerId);
  const models = selectedProvider?.models ?? [];
  const tools = listTools();
  const mcpServers = useMCPStore((s) => s.servers);

  // Built-in tools and MCP servers can expose the same tool name (e.g. a
  // filesystem MCP server's `read_file` collides with our built-in). Show
  // the source on non-built-in chips so they're distinguishable.
  function chipLabelFor(t: { name: string; serverId: string }): string {
    if (t.serverId === "built-in") return t.name;
    const server = mcpServers.find((s) => s.id === t.serverId);
    const sourceName = server?.name ?? t.serverId;
    return `${t.name} (${sourceName})`;
  }
  // Local providers (llama.cpp-server etc.) auto-discover the loaded model on
  // every request, so the agent doesn't need a stored modelId. The provider's
  // send() overrides req.model from GET /v1/models at runtime.
  const isLocalProvider = selectedProvider?.type === "local";
  const effectiveModelId = isLocalProvider ? (modelId || "auto") : modelId;

  function buildCurrentConfig(): AgentConfig | null {
    if (!name || !providerId) return null;
    if (!isLocalProvider && !modelId) return null;

    const approvalConfig: ApprovalConfig = {
      mode: approvalMode,
      trustedServers: isEditMode
        ? (configs.find((c) => c.id === agentId)?.approvalConfig.trustedServers ?? [])
        : [],
      perToolOverrides,
    };

    return isEditMode
      ? {
          ...(configs.find((c) => c.id === agentId)!),
          name,
          description,
          providerId,
          modelId: effectiveModelId,
          systemPrompt,
          temperature,
          maxTokens,
          maxConversationHistory: maxHistory,
          toolIds: selectedToolIds,
          skillIds: selectedSkillIds,
          fallbackProviderIds: fallbackIds,
          approvalConfig,
          sandboxConfig: sandbox,
          memoryConfig,
          thinkingConfig,
          delegationConfig,
          updatedAt: new Date().toISOString(),
        }
      : createDefaultConfig({
          name,
          description,
          providerId,
          modelId: effectiveModelId,
          systemPrompt,
          temperature,
          maxTokens,
          maxConversationHistory: maxHistory,
          toolIds: selectedToolIds,
          skillIds: selectedSkillIds,
          fallbackProviderIds: fallbackIds,
          approvalConfig,
          sandboxConfig: sandbox,
          memoryConfig,
          thinkingConfig,
          delegationConfig,
        });
  }

  // Persist current editor edits in-place (no navigation) so subsequent
  // operations like Export see the latest skillIds/toolIds. Called by the
  // export buttons before they read the saved agent back from disk.
  async function persistCurrentEdits(): Promise<boolean> {
    if (!isEditMode) return true; // export buttons only render in edit mode
    const config = buildCurrentConfig();
    if (!config) {
      // eslint-disable-next-line no-console
      console.warn("[persist-before-export] skipped — required fields missing");
      return false;
    }
    // eslint-disable-next-line no-console
    console.log("[persist-before-export] saving", {
      id: config.id,
      skillIds: config.skillIds,
      toolIds: config.toolIds,
    });
    await saveAgent(config);
    useAgentEditorDraftStore.getState().clearDraft(draftKey);
    return true;
  }

  async function handleSave() {
    const config = buildCurrentConfig();
    if (!config) return;
    // eslint-disable-next-line no-console
    console.log("[agent-save] persisting", {
      id: config.id,
      name: config.name,
      skillIds: config.skillIds,
      toolIds: config.toolIds,
    });
    try {
      await saveAgent(config);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[agent-save] FAILED", err);
      addToast({ type: "error", message: `Save failed: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
    // eslint-disable-next-line no-console
    console.log("[agent-save] persisted ok");
    useAgentEditorDraftStore.getState().clearDraft(draftKey);
    navigate({ to: "/agents" });
  }

  return (
    <div className="flex flex-1 flex-col overflow-auto p-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold">
          {isEditMode ? "Edit Agent" : "New Agent"}
        </h1>
        {isEditMode && (
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              onClick={async () => {
                try {
                  // Persist current editor state first so unsaved skill/tool
                  // attachments make it into the exported file.
                  await persistCurrentEdits();
                  await downloadAgentAsFile(agentId!);
                } catch (err) {
                  addToast({ type: "error", message: err instanceof Error ? err.message : "Export failed" });
                }
              }}
            >
              Export JSON
            </Button>
            {(["claude", "copilot", "both"] as const).map((target) => (
              <Button
                key={target}
                variant="ghost"
                onClick={async () => {
                  // eslint-disable-next-line no-console
                  console.log(`[agent-export] start target=${target} agentId=${agentId}`);
                  try {
                    // Persist unsaved editor state so skill/tool attachments
                    // made in this session are included in the export.
                    await persistCurrentEdits();
                    const { open } = await import("@tauri-apps/plugin-dialog");
                    const title = target === "claude"
                      ? "Choose folder to export Claude Code agent into"
                      : target === "copilot"
                        ? "Choose folder to export GitHub Copilot agent into"
                        : "Choose folder to export Claude + Copilot agent into";
                    const chosen = await open({ directory: true, multiple: false, title });
                    // eslint-disable-next-line no-console
                    console.log(`[agent-export] dialog returned chosen=${chosen ?? "<cancelled>"}`);
                    if (typeof chosen !== "string") return;
                    // CRITICAL: the chosen directory must be registered with
                    // UserPaths before fs_write will accept any file within
                    // it. Without this every fs_write call returns
                    // USER_PATH_NOT_REGISTERED and the whole export aborts
                    // with no files written. The bulk export does this too —
                    // it was an oversight that this code path didn't.
                    const { registerUserPath } = await import("@/lib/user-paths");
                    await registerUserPath(chosen);
                    // eslint-disable-next-line no-console
                    console.log(`[agent-export] user_path_registered dir=${chosen}`);
                    const result = await exportAgentToDisk(agentId!, target, chosen);
                    // eslint-disable-next-line no-console
                    console.log(`[agent-export] done fileCount=${result.fileCount} warnings=${result.warnings.length}`);
                    const warnMsg = result.warnings.length > 0 ? ` (${result.warnings.length} warning${result.warnings.length === 1 ? "" : "s"})` : "";
                    addToast({ type: "success", message: `Exported ${result.fileCount} file${result.fileCount === 1 ? "" : "s"} to ${chosen}${warnMsg}`, source: "agent-editor:export" });
                    for (const w of result.warnings) {
                      addToast({ type: "info", message: w, source: "agent-editor:export" });
                    }
                  } catch (err) {
                    // eslint-disable-next-line no-console
                    console.error(`[agent-export] FAILED target=${target}`, err);
                    addToast({ type: "error", message: err instanceof Error ? err.message : "Markdown export failed", source: "agent-editor:export" });
                  }
                }}
              >
                {target === "claude" ? "Export Claude" : target === "copilot" ? "Export Copilot" : "Export Both"}
              </Button>
            ))}
          </div>
        )}
      </div>

      <div className="flex max-w-2xl flex-col gap-5">
        {!isEditMode && (
          <div>
            <label className="mb-2 block text-sm text-muted-foreground">
              Start from a template
            </label>
            <Button
              variant="ghost"
              onClick={() => navigate({ to: "/library", search: { tab: "agents" } })}
            >
              Browse Library
            </Button>
          </div>
        )}

        <div>
          <label className="mb-1 block text-sm text-muted-foreground">Name</label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My Agent"
          />
        </div>

        <div>
          <label className="mb-1 block text-sm text-muted-foreground">Description</label>
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional description"
          />
        </div>

        <div>
          <label className="mb-1 block text-sm text-muted-foreground">Provider</label>
          <Select
            value={providerId}
            onChange={(e) => {
              setProviderId(e.target.value);
              setModelId("");
            }}
          >
            <option value="">Select provider...</option>
            {enabledProviders.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </Select>
        </div>

        <div>
          <label className="mb-1 block text-sm text-muted-foreground">Model</label>
          {isLocalProvider ? (
            <div className="rounded-md border border-border bg-muted/50 px-3 py-2 text-sm text-foreground/80">
              {models[0]?.name ?? "Auto-detected from local server at request time"}
            </div>
          ) : (
            <SearchableSelect
              value={modelId}
              onChange={setModelId}
              options={models.map((m) => ({ value: m.id, label: m.name }))}
              placeholder="Select model..."
              searchPlaceholder="Search models..."
            />
          )}
        </div>

        <div>
          <label className="mb-1 block text-sm text-muted-foreground">System Prompt</label>
          <textarea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            rows={5}
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none"
          />
        </div>

        <Slider
          label="Temperature"
          displayValue={temperature.toFixed(1)}
          min={0}
          max={2}
          step={0.1}
          value={temperature}
          onChange={(e) => setTemperature(parseFloat(e.target.value))}
        />

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="mb-1 block text-sm text-muted-foreground">Max Tokens</label>
            <Input
              type="number"
              value={maxTokens}
              onChange={(e) => {
                const v = parseInt(e.target.value);
                setMaxTokens(Number.isNaN(v) ? 0 : v);
              }}
              min={0}
            />
            <p className="mt-1 text-center text-xs text-muted-foreground">
              0 = let the model decide
            </p>
          </div>
          <div>
            <label className="mb-1 block text-sm text-muted-foreground">Max History</label>
            <Input
              type="number"
              value={maxHistory}
              onChange={(e) => setMaxHistory(parseInt(e.target.value))}
              min={1}
              max={200}
            />
          </div>
        </div>

        {tools.length > 0 && (
          <div>
            <label className="mb-2 block text-sm text-muted-foreground">Tools</label>
            <div className="flex flex-wrap gap-2">
              {tools.map((t) => (
                <Chip
                  key={t.id}
                  label={chipLabelFor(t)}
                  selected={selectedToolIds.includes(t.id)}
                  onToggle={() =>
                    setSelectedToolIds((ids) =>
                      ids.includes(t.id)
                        ? ids.filter((id) => id !== t.id)
                        : [...ids, t.id],
                    )
                  }
                />
              ))}
            </div>
          </div>
        )}

        <SkillAttachmentSection
          agentId={isEditMode ? agentId : undefined}
          draftKey={!isEditMode ? draftKey : undefined}
          selectedSkillIds={selectedSkillIds}
          onToggle={(skillId) => {
            // Decide outside the updater so the operation is single-direction
            // and identical under React.StrictMode's double-invocation guard.
            const isSelected = selectedSkillIds.includes(skillId);
            const skillName = importedSkills.find((s) => s.id === skillId)?.name ?? skillId;
            if (isSelected) {
              setSelectedSkillIds((ids) =>
                ids.includes(skillId) ? ids.filter((id) => id !== skillId) : ids,
              );
              addToast({ type: "info", message: `Removed "${skillName}" from agent (click Save Changes to persist)`, duration: 3000 });
            } else {
              setSelectedSkillIds((ids) =>
                ids.includes(skillId) ? ids : [...ids, skillId],
              );
              addToast({ type: "info", message: `Attached "${skillName}" to agent (click Save Changes to persist)`, duration: 3000 });
            }
          }}
          onReorder={setSelectedSkillIds}
          onEdit={setEditingSkillId}
        />

        <ToolApprovalSection
          approvalMode={approvalMode}
          onModeChange={setApprovalMode}
          perToolOverrides={perToolOverrides}
          onOverrideChange={handleOverrideChange}
          tools={tools.filter((t) => selectedToolIds.includes(t.id))}
        />

        {enabledProviders.length > 1 && (
          <div>
            <label className="mb-2 block text-sm text-muted-foreground">Fallback Providers</label>
            <div className="flex flex-wrap gap-2">
              {enabledProviders
                .filter((p) => p.id !== providerId)
                .map((p) => (
                  <Chip
                    key={p.id}
                    label={p.name}
                    selected={fallbackIds.includes(p.id)}
                    onToggle={() =>
                      setFallbackIds((ids) =>
                        ids.includes(p.id)
                          ? ids.filter((id) => id !== p.id)
                          : [...ids, p.id],
                      )
                    }
                  />
                ))}
            </div>
          </div>
        )}

        <SandboxSection sandbox={sandbox} onChange={setSandbox} />

        <MemorySettingsSection memoryConfig={memoryConfig} onChange={setMemoryConfig} />

        <ThinkingConfigSection
          config={thinkingConfig}
          onChange={setThinkingConfig}
          modelSupportsThinking={
            (selectedProvider?.models.find((m) => m.id === modelId)?.supportsThinking) ?? false
          }
        />

        <DelegationConfigSection
          config={delegationConfig}
          onChange={setDelegationConfig}
          availableAgents={configs}
          currentAgentId={agentId}
        />

        <div className="mt-2 flex gap-2">
          <Button
            onClick={handleSave}
            disabled={!name || !providerId || (!isLocalProvider && !modelId)}
          >
            {isEditMode ? "Save Changes" : "Create Agent"}
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              useAgentEditorDraftStore.getState().clearDraft(draftKey);
              navigate({ to: "/agents" });
            }}
          >
            Cancel
          </Button>
        </div>
      </div>

      <SkillEditorDialog
        open={editingSkill !== null}
        onClose={() => setEditingSkillId(null)}
        skill={editingSkill}
        onSave={async (id, updates) => { await updateSkill(id, updates); }}
        onReset={editingSkill?.sourceTemplateId ? async (id) => { await resetSkillToBundle(id); } : null}
      />
    </div>
  );
}
