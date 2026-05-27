import { useState } from "react";
import { useSearch, useRouter } from "@tanstack/react-router";
import { useLibrary } from "@/hooks/use-library";
import { useLibraryStore } from "@/stores/library-store";
import { useAgentStore } from "@/stores/agent-store";
import { useAgentEditorDraftStore } from "@/stores/agent-editor-draft-store";
import { useUIStore } from "@/stores/ui-store";
import { saveAgentConfig } from "@/memory/agent-store-sql";
import { isoNow } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Tabs } from "@/components/ui/tabs";
import { Chip } from "@/components/ui/chip";
import { Button } from "@/components/ui/button";
import { AgentTemplateCard } from "./agent-template-card";
import { SkillCard } from "./skill-template-card";
import { SkillEditorDialog } from "./skill-editor-dialog";
import { AttachToAgentsDialog } from "./attach-to-agents-dialog";
import { AgentTemplateEditorDialog } from "./agent-template-editor-dialog";
import { saveAgentTemplate, listAgentTemplates } from "@/memory/agent-template-store-sql";
import type { ImportedSkill, AgentConfig, LibraryAgentTemplate } from "@/types";

const LIBRARY_TABS = [
  { id: "agents", label: "Agent Templates" },
  { id: "skills", label: "Skills" },
];

export function LibraryPage() {
  const router = useRouter();
  const canGoBack = router.history.length > 1;

  const {
    filteredAgents,
    filteredImportedSkills,
    createCustomSkill,
    updateSkill,
    applyBundleUpdate,
    removeSkill,
    isUpdateAvailable,
  } = useLibrary();

  const searchQuery = useLibraryStore((s) => s.searchQuery);
  const setSearchQuery = useLibraryStore((s) => s.setSearchQuery);
  const selectedCategory = useLibraryStore((s) => s.selectedCategory);
  const setSelectedCategory = useLibraryStore((s) => s.setSelectedCategory);
  const activeTab = useLibraryStore((s) => s.activeTab);
  const setActiveTab = useLibraryStore((s) => s.setActiveTab);
  const agentTemplates = useLibraryStore((s) => s.agentTemplates);
  const importedSkills = useLibraryStore((s) => s.importedSkills);

  const { tab, from, draft: draftKey } = useSearch({ from: "/library/" });

  useState(() => {
    if (tab === "agents" || tab === "skills") setActiveTab(tab);
  });

  const agentConfigs = useAgentStore((s) => s.configs);
  const updateAgentConfigInStore = useAgentStore((s) => s.updateConfig);
  const patchAgentDraft = useAgentEditorDraftStore((s) => s.patchDraft);
  const draftRecord = useAgentEditorDraftStore((s) =>
    draftKey ? s.drafts[draftKey] : undefined,
  );
  const addToast = useUIStore((s) => s.addToast);
  const fromAgent = from ? agentConfigs.find((c) => c.id === from) ?? null : null;

  const targetName = fromAgent?.name ?? draftRecord?.name ?? (draftKey ? "New Agent" : null);
  const targetSkillIds = fromAgent?.skillIds ?? draftRecord?.selectedSkillIds ?? null;
  const hasTarget = !!(fromAgent || (draftKey && draftRecord));

  const [editingSkill, setEditingSkill] = useState<ImportedSkill | null>(null);
  const [creatingCustomSkill, setCreatingCustomSkill] = useState(false);
  const [attachingSkillId, setAttachingSkillId] = useState<string | null>(null);
  const [creatingAgentTemplate, setCreatingAgentTemplate] = useState(false);
  const setAgentTemplates = useLibraryStore((s) => s.setAgentTemplates);

  async function handleSaveAgentTemplate(tpl: LibraryAgentTemplate) {
    try {
      await saveAgentTemplate(tpl, "user");
      // Re-list from DB so sort_order + new row land in the store.
      const refreshed = await listAgentTemplates();
      setAgentTemplates(refreshed);
      addToast({ type: "info", message: `Created template "${tpl.name}"`, duration: 2500 });
    } catch (err) {
      addToast({
        type: "error",
        message: `Failed to create template: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  async function handleAddToTarget(skill: ImportedSkill) {
    if (!hasTarget) return;
    if (fromAgent) {
      if (fromAgent.skillIds.includes(skill.id)) return;
      const nextSkillIds = [...fromAgent.skillIds, skill.id];
      const next: AgentConfig = { ...fromAgent, skillIds: nextSkillIds, updatedAt: isoNow() };
      try {
        await saveAgentConfig(next);
        updateAgentConfigInStore(fromAgent.id, { skillIds: nextSkillIds, updatedAt: next.updatedAt });
        patchAgentDraft(`edit:${fromAgent.id}`, { selectedSkillIds: nextSkillIds });
        addToast({
          type: "info",
          message: `Added "${skill.name}" to "${fromAgent.name}"`,
          duration: 2500,
        });
      } catch (err) {
        addToast({ type: "error", message: `Failed to attach skill: ${err instanceof Error ? err.message : String(err)}` });
      }
      return;
    }
    // Draft (new, unsaved agent) — patch the editor draft. Persisted when user saves the agent.
    if (draftKey && draftRecord) {
      if (draftRecord.selectedSkillIds.includes(skill.id)) return;
      const nextSkillIds = [...draftRecord.selectedSkillIds, skill.id];
      patchAgentDraft(draftKey, { selectedSkillIds: nextSkillIds });
      addToast({
        type: "info",
        message: `Added "${skill.name}" to "${draftRecord.name || "New Agent"}" (save the agent to persist)`,
        duration: 3000,
      });
    }
  }

  async function handleDeleteSkill(skill: ImportedSkill) {
    const confirmed = window.confirm(
      `Delete "${skill.name}"? It will be removed from any agents that use it and won't come back automatically.`,
    );
    if (!confirmed) return;
    try {
      await removeSkill(skill.id);
      addToast({ type: "info", message: `Deleted "${skill.name}"`, duration: 2500 });
    } catch (err) {
      addToast({
        type: "error",
        message: `Failed to delete skill: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  async function handleApplyUpdate(skill: ImportedSkill) {
    try {
      await applyBundleUpdate(skill.id);
      addToast({ type: "info", message: `Updated "${skill.name}" to latest bundled version`, duration: 2500 });
    } catch (err) {
      addToast({
        type: "error",
        message: `Failed to update skill: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  const categories = Array.from(
    new Set(
      activeTab === "agents"
        ? agentTemplates.map((t) => t.category)
        : importedSkills.map((s) => s.category),
    ),
  ).sort();

  function handleTabChange(id: string) {
    setActiveTab(id as "agents" | "skills");
    setSelectedCategory(null);
  }

  async function handleEditorSave(id: string, updates: { name: string; prompt: string }) {
    await updateSkill(id, updates);
  }

  async function handleCreateCustom(name: string, prompt: string) {
    await createCustomSkill(name, prompt, "custom");
  }

  return (
    <div className="flex flex-1 flex-col overflow-auto p-6">
      <div className="mb-6 flex items-center gap-3">
        {canGoBack && (
          <button
            onClick={() => router.history.back()}
            className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
            Back
          </button>
        )}
        <h1 className="text-xl font-semibold">Library</h1>
      </div>

      {hasTarget && targetName && (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-primary/30 bg-primary/5 px-4 py-2.5">
          <div className="text-sm">
            Adding skills to <span className="font-semibold">{targetName}</span>
            {!fromAgent && (
              <span className="ml-2 text-xs text-muted-foreground">(unsaved draft)</span>
            )}
          </div>
          <button
            onClick={() => {
              if (fromAgent) {
                router.navigate({ to: "/agents/$id/edit", params: { id: fromAgent.id }, search: {} });
              } else if (draftKey) {
                const tplId = draftKey.startsWith("new:") ? draftKey.slice("new:".length) : null;
                router.navigate({
                  to: "/agents/new",
                  search: tplId ? { templateId: tplId } : {},
                });
              }
            }}
            className="text-xs text-primary hover:underline"
          >
            ← Back to agent
          </button>
        </div>
      )}

      <div className="mb-4 max-w-md">
        <Input
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={activeTab === "agents" ? "Search templates..." : "Search skills..."}
        />
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        <Chip
          label="All"
          size="sm"
          selected={selectedCategory === null}
          onToggle={() => setSelectedCategory(null)}
        />
        {categories.map((cat) => (
          <Chip
            key={cat}
            label={cat}
            size="sm"
            selected={selectedCategory === cat}
            onToggle={() => setSelectedCategory(selectedCategory === cat ? null : cat)}
          />
        ))}
      </div>

      <Tabs
        tabs={LIBRARY_TABS}
        activeTab={activeTab}
        onTabChange={handleTabChange}
        className="flex-1"
      >
        {activeTab === "agents" && (
          <>
            <div className="mb-4">
              <Button variant="ghost" onClick={() => setCreatingAgentTemplate(true)}>
                + Create Agent Template
              </Button>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {filteredAgents
                .sort((a, b) => a.sortOrder - b.sortOrder)
                .map((template) => (
                  <AgentTemplateCard key={template.id} template={template} />
                ))}
              {filteredAgents.length === 0 && (
                <p className="col-span-full py-8 text-center text-sm text-muted-foreground">
                  No matching agent templates found.
                </p>
              )}
            </div>
          </>
        )}

        {activeTab === "skills" && (
          <>
            <div className="mb-4">
              <Button variant="ghost" onClick={() => setCreatingCustomSkill(true)}>
                + Create Skill
              </Button>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {filteredImportedSkills.map((skill) => {
                const hasUpdate = isUpdateAvailable(skill);
                const isCustom = skill.sourceTemplateId === null;
                return (
                  <SkillCard
                    key={skill.id}
                    skill={skill}
                    hasUpdate={hasUpdate}
                    isCustom={isCustom}
                    onEdit={() => setEditingSkill(skill)}
                    onAttachToAgents={() => setAttachingSkillId(skill.id)}
                    onDelete={() => handleDeleteSkill(skill)}
                    onApplyUpdate={hasUpdate ? () => handleApplyUpdate(skill) : undefined}
                    fromAgentName={hasTarget ? targetName ?? undefined : undefined}
                    attachedToFromAgent={
                      hasTarget && targetSkillIds
                        ? targetSkillIds.includes(skill.id)
                        : false
                    }
                    onAddToFromAgent={hasTarget ? () => handleAddToTarget(skill) : undefined}
                  />
                );
              })}
              {filteredImportedSkills.length === 0 && (
                <p className="col-span-full py-8 text-center text-sm text-muted-foreground">
                  No matching skills found.
                </p>
              )}
            </div>
          </>
        )}
      </Tabs>

      <SkillEditorDialog
        open={editingSkill !== null}
        onClose={() => setEditingSkill(null)}
        skill={editingSkill}
        onSave={handleEditorSave}
        onReset={null}
      />

      <SkillEditorDialog
        open={creatingCustomSkill}
        onClose={() => setCreatingCustomSkill(false)}
        skill={null}
        onSave={async (_id, { name, prompt }) => {
          await handleCreateCustom(name, prompt);
          setCreatingCustomSkill(false);
        }}
        onReset={null}
      />

      <AttachToAgentsDialog
        open={attachingSkillId !== null}
        onClose={() => setAttachingSkillId(null)}
        skillId={attachingSkillId}
      />

      <AgentTemplateEditorDialog
        open={creatingAgentTemplate}
        onClose={() => setCreatingAgentTemplate(false)}
        template={null}
        knownCategories={Array.from(new Set(agentTemplates.map((t) => t.category))).sort()}
        onSave={handleSaveAgentTemplate}
      />
    </div>
  );
}
