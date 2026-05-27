import { create } from "zustand";
import type {
  ApprovalConfig,
  DelegationConfig,
  MemoryConfig,
  SandboxConfig,
  ThinkingConfig,
} from "@/types";

export interface AgentEditorDraft {
  name: string;
  description: string;
  providerId: string;
  modelId: string;
  systemPrompt: string;
  temperature: number;
  maxTokens: number;
  maxHistory: number;
  selectedToolIds: string[];
  selectedSkillIds: string[];
  approvalMode: ApprovalConfig["mode"];
  perToolOverrides: Record<string, "auto" | "prompt" | "deny">;
  fallbackIds: string[];
  sandbox: SandboxConfig;
  memoryConfig: MemoryConfig;
  thinkingConfig: ThinkingConfig;
  delegationConfig: DelegationConfig;
}

interface AgentEditorDraftState {
  drafts: Record<string, AgentEditorDraft>;
  setDraft: (key: string, draft: AgentEditorDraft) => void;
  getDraft: (key: string) => AgentEditorDraft | undefined;
  clearDraft: (key: string) => void;
  patchDraft: (key: string, patch: Partial<AgentEditorDraft>) => void;
}

export const useAgentEditorDraftStore = create<AgentEditorDraftState>((set, get) => ({
  drafts: {},
  setDraft: (key, draft) =>
    set((s) => ({ drafts: { ...s.drafts, [key]: draft } })),
  getDraft: (key) => get().drafts[key],
  clearDraft: (key) =>
    set((s) => {
      if (!(key in s.drafts)) return s;
      const next = { ...s.drafts };
      delete next[key];
      return { drafts: next };
    }),
  patchDraft: (key, patch) =>
    set((s) => {
      const existing = s.drafts[key];
      if (!existing) return s;
      return { drafts: { ...s.drafts, [key]: { ...existing, ...patch } } };
    }),
}));
