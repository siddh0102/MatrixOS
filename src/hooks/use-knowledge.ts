import { useKnowledgeStore } from "@/stores/knowledge-store";
import {
  importDocument,
  reimportDocument,
  reembedAllChunks,
  deleteDocument as deleteDocDB,
  searchDocuments,
  toggleChunkPin,
} from "@/memory/semantic-store";
import {
  saveProceduralTemplate as saveProceduralDB,
  updateProceduralTemplate as updateProceduralDB,
  deleteProceduralTemplate as deleteProceduralDB,
  incrementUsageCount,
} from "@/memory/procedural-store";
import {
  searchEpisodicMemories,
  deleteEpisodicEntry,
  toggleEpisodicPin,
} from "@/memory/episodic-store";
import type {
  EpisodicEntry,
  KnowledgeDocument,
  DocumentChunk,
  ProceduralTemplate,
  ImportProgress,
} from "@/types";

export function useKnowledge() {
  const embeddingConfig = useKnowledgeStore((s) => s.embeddingConfig);
  const documents = useKnowledgeStore((s) => s.documents);
  const proceduralTemplates = useKnowledgeStore((s) => s.proceduralTemplates);
  const addDocument = useKnowledgeStore((s) => s.addDocument);
  const removeDocumentFromStore = useKnowledgeStore((s) => s.removeDocument);
  const addProceduralTemplate = useKnowledgeStore((s) => s.addProceduralTemplate);
  const updateProceduralInStore = useKnowledgeStore((s) => s.updateProceduralTemplate);
  const removeProceduralFromStore = useKnowledgeStore((s) => s.removeProceduralTemplate);

  async function importDoc(
    name: string,
    fileType: KnowledgeDocument["fileType"],
    filePath: string,
    onProgress?: (progress: ImportProgress) => void,
    signal?: AbortSignal,
  ): Promise<KnowledgeDocument | null> {
    if (!embeddingConfig) return null;
    const doc = await importDocument(name, fileType, filePath, embeddingConfig, onProgress, signal);
    addDocument(doc);
    return doc;
  }

  async function deleteDoc(id: string): Promise<void> {
    await deleteDocDB(id);
    removeDocumentFromStore(id);
  }

  async function reimportDoc(
    id: string,
    onProgress?: (progress: ImportProgress) => void,
  ): Promise<KnowledgeDocument | null> {
    if (!embeddingConfig) return null;
    const updated = await reimportDocument(id, embeddingConfig, onProgress);
    removeDocumentFromStore(id);
    addDocument(updated);
    return updated;
  }

  async function reembedAll(
    onProgress?: (progress: ImportProgress) => void,
    signal?: AbortSignal,
  ): Promise<{ embedded: number; skipped: number } | null> {
    if (!embeddingConfig) return null;
    return reembedAllChunks(embeddingConfig, onProgress, signal);
  }

  async function applyProcedural(id: string): Promise<void> {
    await incrementUsageCount(id);
    updateProceduralInStore(id, {
      usageCount: (proceduralTemplates.find((t) => t.id === id)?.usageCount ?? 0) + 1,
    });
  }

  async function searchEpisodic(
    query: string,
    agentId: string | null,
    limit?: number,
  ): Promise<Array<{ entry: EpisodicEntry; score: number }>> {
    if (!embeddingConfig) return [];
    return searchEpisodicMemories(
      query,
      agentId,
      embeddingConfig,
      limit ?? 10,
      0.2,
    );
  }

  async function searchSemantic(
    query: string,
    limit?: number,
  ): Promise<Array<{ chunk: DocumentChunk; document: KnowledgeDocument; score: number }>> {
    if (!embeddingConfig) return [];
    return searchDocuments(query, embeddingConfig, limit ?? 10, 0.2);
  }

  async function createProcedural(
    template: Omit<ProceduralTemplate, "id" | "usageCount" | "createdAt" | "updatedAt">,
  ): Promise<ProceduralTemplate> {
    const saved = await saveProceduralDB(template);
    addProceduralTemplate(saved);
    return saved;
  }

  async function updateProcedural(
    id: string,
    updates: Partial<Pick<ProceduralTemplate, "name" | "description" | "category" | "content" | "tags">>,
  ): Promise<void> {
    await updateProceduralDB(id, updates);
    updateProceduralInStore(id, updates);
  }

  async function deleteProcedural(id: string): Promise<void> {
    await deleteProceduralDB(id);
    removeProceduralFromStore(id);
  }

  async function pinEpisodic(id: string, pinned: boolean): Promise<void> {
    await toggleEpisodicPin(id, pinned);
  }

  async function pinChunk(chunkId: string, pinned: boolean): Promise<void> {
    await toggleChunkPin(chunkId, pinned);
  }

  async function forgetEpisodic(id: string): Promise<void> {
    await deleteEpisodicEntry(id);
  }

  return {
    embeddingConfig,
    documents,
    proceduralTemplates,
    importDoc,
    reimportDoc,
    reembedAll,
    deleteDoc,
    searchEpisodic,
    searchSemantic,
    applyProcedural,
    createProcedural,
    updateProcedural,
    deleteProcedural,
    pinEpisodic,
    pinChunk,
    forgetEpisodic,
  };
}
