import { create } from "zustand";
import type { LibraryAgentTemplate, SkillTemplate, ImportedSkill } from "@/types";

interface LibraryState {
  agentTemplates: LibraryAgentTemplate[];
  // In-memory snapshot of bundled defaults — used only for version-diff on
  // already-seeded skills (to surface "Update Available"). The UI itself
  // renders from `importedSkills`.
  bundledSkills: SkillTemplate[];
  importedSkills: ImportedSkill[];
  searchQuery: string;
  selectedCategory: string | null;
  activeTab: "agents" | "skills";

  setAgentTemplates: (agents: LibraryAgentTemplate[]) => void;
  setBundledSkills: (skills: SkillTemplate[]) => void;
  setImportedSkills: (skills: ImportedSkill[]) => void;
  addImportedSkill: (skill: ImportedSkill) => void;
  updateImportedSkill: (id: string, updates: Partial<ImportedSkill>) => void;
  removeImportedSkill: (id: string) => void;
  setSearchQuery: (query: string) => void;
  setSelectedCategory: (category: string | null) => void;
  setActiveTab: (tab: "agents" | "skills") => void;
}

export const useLibraryStore = create<LibraryState>()((set) => ({
  agentTemplates: [],
  bundledSkills: [],
  importedSkills: [],
  searchQuery: "",
  selectedCategory: null,
  activeTab: "agents",

  setAgentTemplates: (agents) => set({ agentTemplates: agents }),
  setBundledSkills: (skills) => set({ bundledSkills: skills }),
  setImportedSkills: (skills) => set({ importedSkills: skills }),

  addImportedSkill: (skill) =>
    set((s) => ({ importedSkills: [...s.importedSkills, skill] })),

  updateImportedSkill: (id, updates) =>
    set((s) => ({
      importedSkills: s.importedSkills.map((sk) =>
        sk.id === id ? { ...sk, ...updates } : sk,
      ),
    })),

  removeImportedSkill: (id) =>
    set((s) => ({
      importedSkills: s.importedSkills.filter((sk) => sk.id !== id),
    })),

  setSearchQuery: (query) => set({ searchQuery: query }),
  setSelectedCategory: (category) => set({ selectedCategory: category }),
  setActiveTab: (tab) => set({ activeTab: tab }),
}));
