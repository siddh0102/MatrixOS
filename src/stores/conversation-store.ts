import { create } from "zustand";
import type { Conversation, Message } from "@/types";

export interface StreamingToolCall {
  id: string;
  name: string;
  args: Record<string, unknown> | null;
  streaming: boolean;
}

interface ConversationState {
  conversations: Conversation[];
  activeConversationId: string | null;
  messages: Message[];
  streamingText: string;
  streamingToolCalls: StreamingToolCall[];
  isStreaming: boolean;

  setConversations: (conversations: Conversation[]) => void;
  addConversation: (conversation: Conversation) => void;
  removeConversation: (id: string) => void;
  setActiveConversation: (id: string | null) => void;
  setMessages: (messages: Message[]) => void;
  addMessage: (message: Message) => void;
  setStreamingText: (text: string) => void;
  appendStreamingText: (delta: string) => void;
  setIsStreaming: (streaming: boolean) => void;
  clearStreaming: () => void;

  addStreamingToolCall: (id: string, name: string) => void;
  updateStreamingToolCall: (
    id: string,
    args: Record<string, unknown>,
  ) => void;
  finishStreamingToolCall: (id: string) => void;
}

export const useConversationStore = create<ConversationState>((set) => ({
  conversations: [],
  activeConversationId: null,
  messages: [],
  streamingText: "",
  streamingToolCalls: [],
  isStreaming: false,

  setConversations: (conversations) => set({ conversations }),
  addConversation: (conversation) =>
    set((s) => ({ conversations: [conversation, ...s.conversations] })),
  removeConversation: (id) =>
    set((s) => ({
      conversations: s.conversations.filter((c) => c.id !== id),
      activeConversationId:
        s.activeConversationId === id ? null : s.activeConversationId,
    })),
  setActiveConversation: (id) => set({ activeConversationId: id }),
  setMessages: (messages) => set({ messages }),
  addMessage: (message) =>
    set((s) => ({ messages: [...s.messages, message] })),
  setStreamingText: (text) => set({ streamingText: text }),
  appendStreamingText: (delta) =>
    set((s) => ({ streamingText: s.streamingText + delta })),
  setIsStreaming: (streaming) => set({ isStreaming: streaming }),
  clearStreaming: () =>
    set({ streamingText: "", streamingToolCalls: [], isStreaming: false }),

  addStreamingToolCall: (id, name) =>
    set((s) => ({
      streamingToolCalls: [
        ...s.streamingToolCalls,
        { id, name, args: null, streaming: true },
      ],
    })),

  updateStreamingToolCall: (id, args) =>
    set((s) => ({
      streamingToolCalls: s.streamingToolCalls.map((tc) =>
        tc.id === id ? { ...tc, args } : tc,
      ),
    })),

  finishStreamingToolCall: (id) =>
    set((s) => ({
      streamingToolCalls: s.streamingToolCalls.map((tc) =>
        tc.id === id ? { ...tc, streaming: false } : tc,
      ),
    })),
}));
