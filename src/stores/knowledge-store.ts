import { create } from "zustand";
import type {
  EmbeddingConfig,
  ImportProgress,
  KnowledgeDocument,
  ProceduralTemplate,
} from "@/types";

export type ImportQueueItem = {
  name: string;
  path: string;
  fileType: KnowledgeDocument["fileType"];
};

export type CurrentImport = {
  name: string;
  index: number;        // 1-based position in the user's batch
  total: number;        // total files in the user's batch
  progress: ImportProgress | null;
  abortController: AbortController;
};

interface KnowledgeState {
  embeddingConfig: EmbeddingConfig | null;
  documents: KnowledgeDocument[];
  proceduralTemplates: ProceduralTemplate[];
  activeTab: "episodic" | "semantic" | "procedural";
  searchQuery: string;
  // Import queue lives in the store so tab/route changes don't lose it.
  importQueue: ImportQueueItem[];
  currentImport: CurrentImport | null;

  setEmbeddingConfig: (config: EmbeddingConfig) => void;
  setDocuments: (docs: KnowledgeDocument[]) => void;
  addDocument: (doc: KnowledgeDocument) => void;
  removeDocument: (id: string) => void;
  setProceduralTemplates: (templates: ProceduralTemplate[]) => void;
  addProceduralTemplate: (template: ProceduralTemplate) => void;
  updateProceduralTemplate: (id: string, updates: Partial<ProceduralTemplate>) => void;
  removeProceduralTemplate: (id: string) => void;
  setActiveTab: (tab: "episodic" | "semantic" | "procedural") => void;
  setSearchQuery: (query: string) => void;

  enqueueImports: (items: ImportQueueItem[]) => void;
  setCurrentImport: (cur: CurrentImport | null) => void;
  setCurrentProgress: (p: ImportProgress) => void;
  // Aborts the in-flight import AND drops the remaining queue.
  // Cleanup of the partial DB state is the caller's responsibility.
  cancelImport: () => void;
}

export const useKnowledgeStore = create<KnowledgeState>()((set) => ({
  embeddingConfig: null,
  documents: [],
  proceduralTemplates: [],
  activeTab: "episodic",
  searchQuery: "",
  importQueue: [],
  currentImport: null,

  setEmbeddingConfig: (config) => set({ embeddingConfig: config }),

  setDocuments: (docs) => set({ documents: docs }),
  addDocument: (doc) =>
    set((s) => ({ documents: [doc, ...s.documents] })),
  removeDocument: (id) =>
    set((s) => ({ documents: s.documents.filter((d) => d.id !== id) })),

  setProceduralTemplates: (templates) => set({ proceduralTemplates: templates }),
  addProceduralTemplate: (template) =>
    set((s) => ({ proceduralTemplates: [...s.proceduralTemplates, template] })),
  updateProceduralTemplate: (id, updates) =>
    set((s) => ({
      proceduralTemplates: s.proceduralTemplates.map((t) =>
        t.id === id ? { ...t, ...updates } : t,
      ),
    })),
  removeProceduralTemplate: (id) =>
    set((s) => ({
      proceduralTemplates: s.proceduralTemplates.filter((t) => t.id !== id),
    })),

  setActiveTab: (tab) => set({ activeTab: tab }),
  setSearchQuery: (query) => set({ searchQuery: query }),

  enqueueImports: (items) =>
    set((s) => ({ importQueue: [...s.importQueue, ...items] })),

  setCurrentImport: (cur) => set({ currentImport: cur }),

  setCurrentProgress: (progress) =>
    set((s) =>
      s.currentImport
        ? { currentImport: { ...s.currentImport, progress } }
        : {},
    ),

  cancelImport: () =>
    set((s) => {
      s.currentImport?.abortController.abort();
      return { importQueue: [] };
    }),
}));
