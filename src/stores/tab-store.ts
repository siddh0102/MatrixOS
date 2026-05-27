import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { nanoid } from "nanoid";
import type { Message } from "@/types";
import type { StreamingToolCall } from "@/stores/conversation-store";
import { useAgentStore } from "@/stores/agent-store";

const TAB_STORAGE_KEY = "matrixos-tabs";
const MAX_TABS = 10;

export interface Tab {
  id: string;
  agentId: string;
  conversationId: string | null;
  title: string;
  lastActiveAt: number;
}

export interface TabStreamState {
  messages: Message[];
  isStreaming: boolean;
  streamingText: string;
  streamingThinking: string;
  isThinking: boolean;
  streamingToolCalls: StreamingToolCall[];
  messagesLoaded: boolean;
  needsAttention: boolean;
}

interface PersistedTab {
  id: string;
  agentId: string;
  conversationId: string | null;
  title: string;
}

interface TabState {
  tabs: Tab[];
  activeTabId: string | null;
  tabStates: Record<string, TabStreamState>;

  openTab: (agentId: string, conversationId?: string | null, title?: string) => string | null;
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  updateTabConversation: (tabId: string, conversationId: string, title?: string) => void;
  updateTabTitle: (tabId: string, title: string) => void;

  setTabMessages: (tabId: string, messages: Message[]) => void;
  addTabMessage: (tabId: string, message: Message) => void;

  setTabStreaming: (tabId: string, streaming: boolean) => void;
  appendTabStreamingText: (tabId: string, delta: string) => void;
  clearTabStreaming: (tabId: string) => void;
  addTabStreamingToolCall: (tabId: string, id: string, name: string) => void;
  updateTabStreamingToolCall: (tabId: string, id: string, args: Record<string, unknown>) => void;
  finishTabStreamingToolCall: (tabId: string, id: string) => void;

  appendTabStreamingThinking: (tabId: string, delta: string) => void;
  setTabIsThinking: (tabId: string, thinking: boolean) => void;

  setTabNeedsAttention: (tabId: string, needs: boolean) => void;

  getActiveTab: () => Tab | undefined;
  getActiveTabState: () => TabStreamState | undefined;
  getTabState: (tabId: string) => TabStreamState | undefined;
  findTabByConversation: (conversationId: string) => Tab | undefined;
  findTabByAgent: (agentId: string) => Tab | undefined;
  getStreamingTabCount: () => number;

  persistTabs: () => void;
  restoreTabs: () => void;
}

function emptyTabState(conversationId: string | null): TabStreamState {
  return {
    messages: [],
    isStreaming: false,
    streamingText: "",
    streamingThinking: "",
    isThinking: false,
    streamingToolCalls: [],
    messagesLoaded: conversationId == null,
    needsAttention: false,
  };
}

export const useTabStore = create<TabState>()(
  subscribeWithSelector((set, get) => ({
    tabs: [],
    activeTabId: null,
    tabStates: {},

    openTab: (agentId, conversationId = null, title = "New Tab") => {
      const { tabs, tabStates } = get();

      const existing = conversationId
        ? tabs.find((t) => t.conversationId === conversationId)
        : tabs.find((t) => t.agentId === agentId && t.conversationId == null);

      if (existing) {
        if (existing.id !== get().activeTabId) {
          set({
            activeTabId: existing.id,
            tabs: tabs.map((t) =>
              t.id === existing.id ? { ...t, lastActiveAt: Date.now() } : t,
            ),
          });
          get().persistTabs();
        }
        return existing.id;
      }

      if (tabs.length >= MAX_TABS) return null;

      const id = nanoid();
      const newTab: Tab = { id, agentId, conversationId, title, lastActiveAt: Date.now() };
      set({
        tabs: [...tabs, newTab],
        activeTabId: id,
        tabStates: { ...tabStates, [id]: emptyTabState(conversationId) },
      });
      get().persistTabs();
      return id;
    },

    closeTab: (tabId) => {
      const { tabs, activeTabId, tabStates } = get();
      const idx = tabs.findIndex((t) => t.id === tabId);
      if (idx === -1) return;

      const newTabs = tabs.filter((t) => t.id !== tabId);
      const newTabStates = { ...tabStates };
      delete newTabStates[tabId];

      let newActiveTabId: string | null = activeTabId;
      if (activeTabId === tabId) {
        if (idx < newTabs.length) {
          newActiveTabId = newTabs[idx].id;
        } else if (newTabs.length > 0) {
          newActiveTabId = newTabs[newTabs.length - 1].id;
        } else {
          newActiveTabId = null;
        }
      }

      set({ tabs: newTabs, activeTabId: newActiveTabId, tabStates: newTabStates });
      get().persistTabs();
    },

    setActiveTab: (tabId) => {
      const { tabs, activeTabId, tabStates } = get();
      if (tabId === activeTabId) return;
      const existingState = tabStates[tabId];
      const updatedStates = existingState?.needsAttention
        ? { ...tabStates, [tabId]: { ...existingState, needsAttention: false } }
        : tabStates;
      set({
        activeTabId: tabId,
        tabs: tabs.map((t) =>
          t.id === tabId ? { ...t, lastActiveAt: Date.now() } : t,
        ),
        tabStates: updatedStates,
      });
      get().persistTabs();
    },

    updateTabConversation: (tabId, conversationId, title) => {
      const { tabs, tabStates } = get();
      const existingState = tabStates[tabId];
      if (!existingState) return;
      set({
        tabs: tabs.map((t) =>
          t.id === tabId ? { ...t, conversationId, title: title ?? t.title } : t,
        ),
        tabStates: {
          ...tabStates,
          [tabId]: { ...existingState, messagesLoaded: true },
        },
      });
      get().persistTabs();
    },

    updateTabTitle: (tabId, title) => {
      const { tabs } = get();
      set({ tabs: tabs.map((t) => (t.id === tabId ? { ...t, title } : t)) });
    },

    setTabMessages: (tabId, messages) => {
      const { tabStates } = get();
      const state = tabStates[tabId];
      if (!state) return;
      set({
        tabStates: {
          ...tabStates,
          [tabId]: { ...state, messages, messagesLoaded: true },
        },
      });
    },

    addTabMessage: (tabId, message) => {
      set((s) => {
        const state = s.tabStates[tabId];
        if (!state) return s;
        return {
          tabStates: {
            ...s.tabStates,
            [tabId]: { ...state, messages: [...state.messages, message] },
          },
        };
      });
    },

    setTabStreaming: (tabId, streaming) => {
      set((s) => {
        const state = s.tabStates[tabId];
        if (!state) return s;
        return {
          tabStates: { ...s.tabStates, [tabId]: { ...state, isStreaming: streaming } },
        };
      });
    },

    appendTabStreamingText: (tabId, delta) => {
      set((s) => {
        const state = s.tabStates[tabId];
        if (!state) return s;
        return {
          tabStates: {
            ...s.tabStates,
            [tabId]: { ...state, streamingText: state.streamingText + delta },
          },
        };
      });
    },

    clearTabStreaming: (tabId) => {
      set((s) => {
        const state = s.tabStates[tabId];
        if (!state) return s;
        return {
          tabStates: {
            ...s.tabStates,
            [tabId]: {
              ...state,
              isStreaming: false,
              streamingText: "",
              streamingThinking: "",
              isThinking: false,
              streamingToolCalls: [],
            },
          },
        };
      });
    },

    appendTabStreamingThinking: (tabId, delta) => {
      set((s) => {
        const state = s.tabStates[tabId];
        if (!state) return s;
        return {
          tabStates: {
            ...s.tabStates,
            [tabId]: {
              ...state,
              streamingThinking: state.streamingThinking + delta,
              isThinking: true,
            },
          },
        };
      });
    },

    setTabIsThinking: (tabId, thinking) => {
      set((s) => {
        const state = s.tabStates[tabId];
        if (!state) return s;
        return {
          tabStates: {
            ...s.tabStates,
            [tabId]: { ...state, isThinking: thinking },
          },
        };
      });
    },

    addTabStreamingToolCall: (tabId, id, name) => {
      set((s) => {
        const state = s.tabStates[tabId];
        if (!state) return s;
        return {
          tabStates: {
            ...s.tabStates,
            [tabId]: {
              ...state,
              streamingToolCalls: [
                ...state.streamingToolCalls,
                { id, name, args: null, streaming: true },
              ],
            },
          },
        };
      });
    },

    updateTabStreamingToolCall: (tabId, id, args) => {
      set((s) => {
        const state = s.tabStates[tabId];
        if (!state) return s;
        return {
          tabStates: {
            ...s.tabStates,
            [tabId]: {
              ...state,
              streamingToolCalls: state.streamingToolCalls.map((tc) =>
                tc.id === id ? { ...tc, args } : tc,
              ),
            },
          },
        };
      });
    },

    finishTabStreamingToolCall: (tabId, id) => {
      set((s) => {
        const state = s.tabStates[tabId];
        if (!state) return s;
        return {
          tabStates: {
            ...s.tabStates,
            [tabId]: {
              ...state,
              streamingToolCalls: state.streamingToolCalls.map((tc) =>
                tc.id === id ? { ...tc, streaming: false } : tc,
              ),
            },
          },
        };
      });
    },

    setTabNeedsAttention: (tabId, needs) => {
      set((s) => {
        const state = s.tabStates[tabId];
        if (!state) return s;
        return {
          tabStates: {
            ...s.tabStates,
            [tabId]: { ...state, needsAttention: needs },
          },
        };
      });
    },

    getActiveTab: () => {
      const { tabs, activeTabId } = get();
      return tabs.find((t) => t.id === activeTabId);
    },

    getActiveTabState: () => {
      const { tabStates, activeTabId } = get();
      if (!activeTabId) return undefined;
      return tabStates[activeTabId];
    },

    getTabState: (tabId) => get().tabStates[tabId],

    findTabByConversation: (conversationId) =>
      get().tabs.find((t) => t.conversationId === conversationId),

    findTabByAgent: (agentId) => {
      const agentTabs = get().tabs.filter((t) => t.agentId === agentId);
      if (agentTabs.length === 0) return undefined;
      return agentTabs.reduce((best, t) =>
        t.lastActiveAt > best.lastActiveAt ? t : best,
      );
    },

    getStreamingTabCount: () => {
      let count = 0;
      for (const state of Object.values(get().tabStates)) {
        if (state.isStreaming) count++;
      }
      return count;
    },

    persistTabs: () => {
      const { tabs, activeTabId } = get();
      const data = {
        tabs: tabs.map(({ id, agentId, conversationId, title }) => ({
          id, agentId, conversationId, title,
        })),
        activeTabId,
      };
      try {
        localStorage.setItem(TAB_STORAGE_KEY, JSON.stringify(data));
      } catch {
        // localStorage full or unavailable — non-fatal
      }
    },

    restoreTabs: () => {
      try {
        const raw = localStorage.getItem(TAB_STORAGE_KEY);
        if (!raw) return;
        const data = JSON.parse(raw) as {
          tabs: PersistedTab[];
          activeTabId: string | null;
        };
        const agentIds = new Set(
          useAgentStore.getState().configs.map((c) => c.id),
        );
        const validTabs = data.tabs.filter((t) => agentIds.has(t.agentId));
        if (validTabs.length === 0) return;

        const tabs: Tab[] = validTabs.map((t) => ({
          ...t,
          lastActiveAt: Date.now(),
        }));
        const tabStates: Record<string, TabStreamState> = {};
        for (const t of tabs) {
          tabStates[t.id] = emptyTabState(t.conversationId);
        }
        const activeTabId = validTabs.some((t) => t.id === data.activeTabId)
          ? data.activeTabId
          : validTabs[0].id;
        set({ tabs, activeTabId, tabStates });
      } catch {
        // corrupt data — start fresh
      }
    },
  })),
);

/**
 * The "current agent" is the agent of the focused tab.
 * Returns null when no tab is open.
 *
 * This replaces the old global `activeAgentId` — agent activity is now
 * naturally tab-scoped: multiple tabs can each have their own agent.
 */
export function useCurrentAgentId(): string | null {
  return useTabStore((s) => {
    if (!s.activeTabId) return null;
    return s.tabs.find((t) => t.id === s.activeTabId)?.agentId ?? null;
  });
}
