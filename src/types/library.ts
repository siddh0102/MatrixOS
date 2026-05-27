import type { SkillTemplate } from "./skill";

export type LibraryIconType =
  | "assistant"
  | "code"
  | "research"
  | "writing"
  | "orchestrator"
  | "data"
  | "devops"
  | "support"
  | "review"
  | "creative";

export interface LibraryAgentTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  systemPrompt: string;
  temperature: number;
  maxTokens: number;
  maxConversationHistory: number;
  icon: LibraryIconType;
  tags: string[];
  author: string;
  version: string;
  suggestedSkillIds: string[];
  sortOrder: number;
}

export interface CatalogMetadata {
  version: string;
  updatedAt: string;
  agentCount: number;
  skillCount: number;
}

export interface LibraryCatalog {
  metadata: CatalogMetadata;
  agents: LibraryAgentTemplate[];
  skills: SkillTemplate[];
}
