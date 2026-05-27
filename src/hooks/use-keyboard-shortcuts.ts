import { useEffect, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useUIStore } from "@/stores/ui-store";
import { useTabStore } from "@/stores/tab-store";
import type { Tab } from "@/stores/tab-store";

function getCurrentAgentId(): string | null {
  const { activeTabId, tabs } = useTabStore.getState();
  if (!activeTabId) return null;
  return tabs.find((t) => t.id === activeTabId)?.agentId ?? null;
}

export function useKeyboardShortcuts() {
  const navigate = useNavigate();
  const toggleSidebarRef = useRef(useUIStore.getState().toggleSidebar);
  const tabStoreRef = useRef({
    tabs: useTabStore.getState().tabs as Tab[],
    activeTabId: useTabStore.getState().activeTabId as string | null,
    setActiveTab: useTabStore.getState().setActiveTab,
    closeTab: useTabStore.getState().closeTab,
    openTab: useTabStore.getState().openTab,
  });

  useEffect(() => {
    const unsub1 = useUIStore.subscribe((s) => {
      toggleSidebarRef.current = s.toggleSidebar;
    });
    const unsub3 = useTabStore.subscribe((s) => {
      tabStoreRef.current = {
        tabs: s.tabs,
        activeTabId: s.activeTabId,
        setActiveTab: s.setActiveTab,
        closeTab: s.closeTab,
        openTab: s.openTab,
      };
    });
    return () => {
      unsub1();
      unsub3();
    };
  }, []);

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      const isInput =
        target.tagName === "INPUT" || target.tagName === "TEXTAREA";
      const ctrl = e.ctrlKey || e.metaKey;

      if (ctrl && e.shiftKey && e.key === "N") {
        e.preventDefault();
        navigate({ to: "/agents/new", search: {} });
        return;
      }

      // Alt+N — new tab (blank conversation)
      if (e.altKey && e.key === "n" && !isInput) {
        e.preventDefault();
        const agentId = getCurrentAgentId();
        if (agentId) {
          const tabId = tabStoreRef.current.openTab(agentId);
          if (tabId) navigate({ to: "/chat" });
        }
        return;
      }

      // Alt+. — next tab; Alt+, — previous tab
      if (e.altKey && (e.key === "." || e.key === ",") && !isInput) {
        e.preventDefault();
        const { tabs, activeTabId, setActiveTab } = tabStoreRef.current;
        if (tabs.length < 2) return;
        const idx = tabs.findIndex((t) => t.id === activeTabId);
        const next =
          e.key === ","
            ? (idx - 1 + tabs.length) % tabs.length
            : (idx + 1) % tabs.length;
        setActiveTab(tabs[next].id);
        const tab = tabs[next];
        if (tab.conversationId) {
          navigate({ to: "/chat/$id", params: { id: tab.conversationId } });
        } else {
          navigate({ to: "/chat" });
        }
        return;
      }

      // Ctrl+1 through Ctrl+9 — jump to tab N
      if (ctrl && !e.shiftKey && !e.altKey && e.key >= "1" && e.key <= "9") {
        const { tabs, setActiveTab } = tabStoreRef.current;
        if (tabs.length > 1) {
          e.preventDefault();
          const idx = parseInt(e.key, 10) - 1;
          if (idx < tabs.length) {
            setActiveTab(tabs[idx].id);
            const tab = tabs[idx];
            if (tab.conversationId) {
              navigate({ to: "/chat/$id", params: { id: tab.conversationId } });
            } else {
              navigate({ to: "/chat" });
            }
          }
          return;
        }
      }

      // Alt+W — close active tab
      if (e.altKey && e.key === "w" && !isInput) {
        e.preventDefault();
        const { activeTabId, closeTab } = tabStoreRef.current;
        if (activeTabId) closeTab(activeTabId);
        return;
      }

      // Alt+T — open new tab for current agent
      if (e.altKey && e.key === "t" && !isInput) {
        e.preventDefault();
        const agentId = getCurrentAgentId();
        if (!agentId) return;
        const tabId = tabStoreRef.current.openTab(agentId);
        if (tabId) navigate({ to: "/chat" });
        return;
      }

      if (ctrl && e.key === "/" && !isInput) {
        e.preventDefault();
        document.querySelector<HTMLTextAreaElement>("[data-chat-input]")?.focus();
        return;
      }

      if (ctrl && e.key === "b" && !isInput) {
        e.preventDefault();
        toggleSidebarRef.current();
        return;
      }

      if (ctrl && e.key === ",") {
        e.preventDefault();
        navigate({ to: "/settings/providers" });
        return;
      }
    }

    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [navigate]);
}
