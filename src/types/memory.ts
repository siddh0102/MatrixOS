export type EmbeddingProvider = "local" | "ollama" | "openai-compatible";

export interface EmbeddingConfig {
  provider: EmbeddingProvider;
  model: string;
  dimensions: number;
  baseUrl: string | null;
}

export interface MemoryConfig {
  enabled: boolean;
  episodicEnabled: boolean;
  semanticEnabled: boolean;
  proceduralEnabled: boolean;
  maxRetrievalTokens: number;
  maxPinnedTokens: number;
  episodicMaxResults: number;
  semanticMaxResults: number;
  proceduralMaxResults: number;
  relevanceThreshold: number;
  knowledgeDocumentIds: string[];
  knowledgeBaseIds: string[];
}

export interface KnowledgeBase {
  id: string;
  name: string;
  description: string;
  documentIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface EpisodicEntry {
  id: string;
  conversationId: string;
  agentId: string;
  userMessageId: string;
  assistantMessageId: string;
  summary: string;
  pinned: boolean;
  createdAt: string;
}

export interface KnowledgeDocument {
  id: string;
  name: string;
  fileType: "pdf" | "markdown" | "code" | "text" | "docx" | "pptx";
  filePath: string | null;
  totalChunks: number;
  totalTokensEstimate: number;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentChunk {
  id: string;
  documentId: string;
  chunkIndex: number;
  text: string;
  tokenEstimate: number;
  pinned: boolean;
  createdAt: string;
}

export interface ProceduralTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  content: string;
  tags: string[];
  usageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface VectorSearchResult {
  id: string;
  distance: number;
  metadata: string;
}

export interface MemoryContext {
  episodic: Array<{ entry: EpisodicEntry; score: number }>;
  semantic: Array<{ chunk: DocumentChunk; document: KnowledgeDocument; score: number }>;
  procedural: ProceduralTemplate[];
  formattedText: string;
  tokenEstimate: number;
}

export interface ImportProgress {
  phase: "reading" | "chunking" | "embedding" | "storing" | "done";
  current: number;
  total: number;
}

/**
 * A single retrieved source attached to an assistant message. Stored as
 * `messages.sources_json` (migration 017) and rendered in the chat UI as
 * the "🔍 N sources used" badge / expander. Only semantic (knowledge-doc)
 * sources are persisted — episodic and procedural retrievals are not
 * cited because they're not addressable as "a source file".
 */
export interface MessageSource {
  type: "semantic";
  documentId: string;
  documentName: string;
  chunkId: string;
  chunkIndex: number;
  score: number;
  /** First ~200 chars of the chunk text for the hover/expand preview. */
  excerpt: string;
}
