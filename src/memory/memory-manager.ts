import type {
  MemoryConfig,
  EmbeddingConfig,
  EpisodicEntry,
  DocumentChunk,
  KnowledgeDocument,
  ProceduralTemplate,
  MemoryContext,
} from "@/types";
import { searchEpisodicMemories, getPinnedEpisodicEntries } from "@/memory/episodic-store";
import { searchDocuments, getPinnedChunks } from "@/memory/semantic-store";
import { getProceduralByQuery } from "@/memory/procedural-store";
import { getDocumentsInKB } from "@/memory/knowledge-base-store";
import { estimateTokens } from "@/memory/embedding-service";

export async function retrieveMemoryContext(
  query: string,
  agentId: string,
  memoryConfig: MemoryConfig,
  embeddingConfig: EmbeddingConfig,
): Promise<MemoryContext> {
  if (!memoryConfig.enabled) {
    return emptyContext();
  }

  const budget = memoryConfig.maxRetrievalTokens;
  const pinnedBudget = memoryConfig.maxPinnedTokens;
  let tokensUsed = 0;
  let pinnedTokensUsed = 0;

  const episodic: Array<{ entry: EpisodicEntry; score: number }> = [];
  const semantic: Array<{ chunk: DocumentChunk; document: KnowledgeDocument; score: number }> = [];
  const procedural: ProceduralTemplate[] = [];

  let pinnedEpisodic: EpisodicEntry[] = [];
  let pinnedChunks: Array<{ chunk: DocumentChunk; document: KnowledgeDocument }> = [];

  if (memoryConfig.episodicEnabled) {
    try {
      const allPinned = await getPinnedEpisodicEntries(agentId);
      for (const entry of allPinned) {
        const tokens = estimateTokens(entry.summary);
        if (pinnedTokensUsed + tokens > pinnedBudget) break;
        pinnedEpisodic.push(entry);
        pinnedTokensUsed += tokens;
      }
    } catch { /* non-fatal */ }
  }

  if (memoryConfig.semanticEnabled) {
    try {
      const allPinnedChunks = await getPinnedChunks();
      for (const pc of allPinnedChunks) {
        const tokens = estimateTokens(pc.chunk.text);
        if (pinnedTokensUsed + tokens > pinnedBudget) break;
        pinnedChunks.push(pc);
        pinnedTokensUsed += tokens;
      }
    } catch { /* non-fatal */ }
  }

  if (memoryConfig.episodicEnabled) {
    try {
      const results = await searchEpisodicMemories(
        query,
        agentId,
        embeddingConfig,
        memoryConfig.episodicMaxResults,
        memoryConfig.relevanceThreshold,
      );
      for (const r of results) {
        if (pinnedEpisodic.some((p) => p.id === r.entry.id)) continue;
        const tokens = estimateTokens(r.entry.summary);
        if (tokensUsed + tokens > budget) break;
        episodic.push(r);
        tokensUsed += tokens;
      }
    } catch { /* non-fatal */ }
  }

  if (memoryConfig.semanticEnabled) {
    try {
      // Build the scope: explicit document IDs + all docs in selected KBs.
      // Both empty → undefined (= search every imported doc).
      let docScope: string[] | undefined;
      const baseIds = memoryConfig.knowledgeBaseIds ?? [];
      const explicitDocIds = memoryConfig.knowledgeDocumentIds ?? [];
      if (baseIds.length > 0 || explicitDocIds.length > 0) {
        const scope = new Set<string>(explicitDocIds);
        for (const kbId of baseIds) {
          try {
            const ids = await getDocumentsInKB(kbId);
            for (const id of ids) scope.add(id);
          } catch { /* missing/deleted KB — skip */ }
        }
        // Pass undefined (not empty array) if the union is empty, so
        // searchDocuments doesn't filter to "no documents".
        docScope = scope.size > 0 ? Array.from(scope) : undefined;
      }
      const results = await searchDocuments(
        query,
        embeddingConfig,
        memoryConfig.semanticMaxResults,
        memoryConfig.relevanceThreshold,
        docScope,
      );
      for (const r of results) {
        if (pinnedChunks.some((p) => p.chunk.id === r.chunk.id)) continue;
        const tokens = estimateTokens(r.chunk.text);
        if (tokensUsed + tokens > budget) break;
        semantic.push(r);
        tokensUsed += tokens;
      }
    } catch { /* non-fatal */ }
  }

  if (memoryConfig.proceduralEnabled) {
    try {
      const templates = await getProceduralByQuery(
        query,
        memoryConfig.proceduralMaxResults,
      );
      for (const t of templates) {
        const tokens = estimateTokens(t.content);
        if (tokensUsed + tokens > budget) break;
        procedural.push(t);
        tokensUsed += tokens;
      }
    } catch { /* non-fatal */ }
  }

  const formattedText = formatMemoryContext(
    pinnedEpisodic,
    pinnedChunks,
    episodic,
    semantic,
    procedural,
  );

  const headerOverhead = estimateTokens(formattedText) - tokensUsed;

  return {
    episodic,
    semantic,
    procedural,
    formattedText,
    tokenEstimate: pinnedTokensUsed + tokensUsed + Math.max(headerOverhead, 0),
  };
}

function formatMemoryContext(
  pinnedEpisodic: EpisodicEntry[],
  pinnedChunks: Array<{ chunk: DocumentChunk; document: KnowledgeDocument }>,
  episodic: Array<{ entry: EpisodicEntry; score: number }>,
  semantic: Array<{ chunk: DocumentChunk; document: KnowledgeDocument; score: number }>,
  procedural: ProceduralTemplate[],
): string {
  const sections: string[] = [];

  if (pinnedEpisodic.length > 0 || pinnedChunks.length > 0) {
    const pinned: string[] = ["### Pinned Memories"];
    for (const entry of pinnedEpisodic) {
      pinned.push(entry.summary);
    }
    for (const { chunk, document } of pinnedChunks) {
      pinned.push(`[${document.name}]\n${chunk.text}`);
    }
    sections.push(pinned.join("\n\n"));
  }

  if (episodic.length > 0) {
    const lines: string[] = ["### Relevant Past Conversations"];
    for (const { entry } of episodic) {
      lines.push(entry.summary);
    }
    sections.push(lines.join("\n\n"));
  }

  if (semantic.length > 0) {
    const lines: string[] = ["### Relevant Knowledge"];
    for (const { chunk, document } of semantic) {
      lines.push(`[${document.name}]\n${chunk.text}`);
    }
    sections.push(lines.join("\n\n"));
  }

  if (procedural.length > 0) {
    const lines: string[] = ["### Reference Patterns"];
    for (const t of procedural) {
      lines.push(`[${t.name}]\n${t.content}`);
    }
    sections.push(lines.join("\n\n"));
  }

  return sections.join("\n\n");
}

function emptyContext(): MemoryContext {
  return {
    episodic: [],
    semantic: [],
    procedural: [],
    formattedText: "",
    tokenEstimate: 0,
  };
}
