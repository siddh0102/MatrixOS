import type { MemoryConfig } from "@/types";

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  enabled: false,
  episodicEnabled: true,
  semanticEnabled: true,
  proceduralEnabled: true,
  maxRetrievalTokens: 2048,
  maxPinnedTokens: 4096,
  episodicMaxResults: 5,
  semanticMaxResults: 5,
  proceduralMaxResults: 3,
  relevanceThreshold: 0.3,
  knowledgeDocumentIds: [],
  knowledgeBaseIds: [],
};
