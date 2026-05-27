import { useMemo } from "react";
import { useLibraryStore } from "@/stores/library-store";
import { useAgentStore } from "@/stores/agent-store";
import { saveSkill, deleteSkill } from "@/memory/skill-store-sql";
import { saveAgentConfig } from "@/memory/agent-store-sql";
import { nanoid } from "nanoid";
import { isoNow } from "@/lib/utils";
import type { ImportedSkill } from "@/types";

export function useLibrary() {
  const agentTemplates = useLibraryStore((s) => s.agentTemplates);
  const bundledSkills = useLibraryStore((s) => s.bundledSkills);
  const importedSkills = useLibraryStore((s) => s.importedSkills);
  const searchQuery = useLibraryStore((s) => s.searchQuery);
  const selectedCategory = useLibraryStore((s) => s.selectedCategory);
  const addImportedSkill = useLibraryStore((s) => s.addImportedSkill);
  const updateImportedSkillInStore = useLibraryStore((s) => s.updateImportedSkill);
  const removeImportedSkillFromStore = useLibraryStore((s) => s.removeImportedSkill);

  async function createCustomSkill(
    name: string,
    prompt: string,
    category: string,
  ): Promise<ImportedSkill> {
    const now = isoNow();
    const skill: ImportedSkill = {
      id: nanoid(),
      sourceTemplateId: null,
      sourceVersion: null,
      name,
      description: "",
      category,
      prompt,
      tags: [],
      createdAt: now,
      updatedAt: now,
    };

    await saveSkill(skill);
    addImportedSkill(skill);
    return skill;
  }

  async function updateSkill(
    id: string,
    updates: Partial<Pick<ImportedSkill, "name" | "description" | "prompt" | "category" | "tags">>,
  ): Promise<void> {
    const existing = importedSkills.find((s) => s.id === id);
    if (!existing) return;

    const updated: ImportedSkill = {
      ...existing,
      ...updates,
      updatedAt: isoNow(),
    };

    await saveSkill(updated);
    updateImportedSkillInStore(id, { ...updates, updatedAt: updated.updatedAt });
  }

  async function resetSkillToBundle(id: string): Promise<void> {
    const existing = importedSkills.find((s) => s.id === id);
    if (!existing || !existing.sourceTemplateId) return;

    const bundled = bundledSkills.find((t) => t.id === existing.sourceTemplateId);
    if (!bundled) return;

    const now = isoNow();
    const restored: ImportedSkill = {
      ...existing,
      name: bundled.name,
      description: bundled.description,
      prompt: bundled.prompt,
      tags: [...bundled.tags],
      sourceVersion: bundled.version,
      updatedAt: now,
    };

    await saveSkill(restored);
    updateImportedSkillInStore(id, {
      name: bundled.name,
      description: bundled.description,
      prompt: bundled.prompt,
      tags: [...bundled.tags],
      sourceVersion: bundled.version,
      updatedAt: now,
    });
  }

  async function removeSkill(id: string): Promise<void> {
    await deleteSkill(id);
    removeImportedSkillFromStore(id);

    const { configs, updateConfig } = useAgentStore.getState();
    for (const config of configs) {
      if (config.skillIds?.includes(id)) {
        const cleaned = {
          ...config,
          skillIds: config.skillIds.filter((sid) => sid !== id),
          updatedAt: isoNow(),
        };
        await saveAgentConfig(cleaned);
        updateConfig(config.id, cleaned);
      }
    }
  }

  async function applyBundleUpdate(skillId: string): Promise<void> {
    // Aliased name for resetSkillToBundle — semantically this is what the
    // "Update Available" button does. Same operation either way.
    await resetSkillToBundle(skillId);
  }

  function isUpdateAvailable(skill: ImportedSkill): boolean {
    if (!skill.sourceTemplateId || !skill.sourceVersion) return false;
    const bundled = bundledSkills.find((t) => t.id === skill.sourceTemplateId);
    if (!bundled) return false;
    return bundled.version !== skill.sourceVersion;
  }

  function resolveSkillPrompts(skillIds: string[]): string[] {
    return skillIds
      .map((id) => importedSkills.find((s) => s.id === id))
      .filter((s): s is ImportedSkill => s !== undefined)
      .map((s) => s.prompt);
  }

  function matchesSearch(text: string, query: string): boolean {
    const q = query.toLowerCase();
    return text.toLowerCase().includes(q);
  }

  const filteredAgents = useMemo(
    () =>
      agentTemplates.filter((a) => {
        if (selectedCategory && a.category !== selectedCategory) return false;
        if (!searchQuery) return true;
        return (
          matchesSearch(a.name, searchQuery) ||
          matchesSearch(a.description, searchQuery) ||
          a.tags.some((t) => matchesSearch(t, searchQuery))
        );
      }),
    [agentTemplates, searchQuery, selectedCategory],
  );

  const filteredImportedSkills = useMemo(
    () =>
      importedSkills.filter((s) => {
        if (selectedCategory && s.category !== selectedCategory) return false;
        if (!searchQuery) return true;
        return (
          matchesSearch(s.name, searchQuery) ||
          matchesSearch(s.description, searchQuery) ||
          s.tags.some((t) => matchesSearch(t, searchQuery))
        );
      }),
    [importedSkills, searchQuery, selectedCategory],
  );

  return {
    agentTemplates,
    bundledSkills,
    importedSkills,
    filteredAgents,
    filteredImportedSkills,
    createCustomSkill,
    updateSkill,
    applyBundleUpdate,
    resetSkillToBundle,
    removeSkill,
    isUpdateAvailable,
    resolveSkillPrompts,
  };
}
