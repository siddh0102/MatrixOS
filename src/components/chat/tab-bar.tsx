import { useNavigate } from "@tanstack/react-router";
import { useTabStore, useCurrentAgentId } from "@/stores/tab-store";
import { useAgentStore } from "@/stores/agent-store";
import { useUIStore } from "@/stores/ui-store";
import { cn } from "@/lib/utils";
import { useShallow } from "zustand/react/shallow";

function TabItem({ tabId }: { tabId: string }) {
  const tabTitle = useTabStore((s) => s.tabs.find((t) => t.id === tabId)?.title ?? "");
  const tabConversationId = useTabStore((s) => s.tabs.find((t) => t.id === tabId)?.conversationId ?? null);
  const isActive = useTabStore((s) => s.activeTabId === tabId);
  const isStreaming = useTabStore((s) => s.tabStates[tabId]?.isStreaming ?? false);
  const needsAttention = useTabStore((s) => s.tabStates[tabId]?.needsAttention ?? false);
  const setActiveTab = useTabStore((s) => s.setActiveTab);
  const closeTab = useTabStore((s) => s.closeTab);
  const navigate = useNavigate();

  function handleClick() {
    setActiveTab(tabId);
    if (tabConversationId) {
      navigate({ to: "/chat/$id", params: { id: tabConversationId } });
    } else {
      navigate({ to: "/chat" });
    }
  }

  function handleClose(e: React.MouseEvent) {
    e.stopPropagation();
    closeTab(tabId);
  }

  function handleAuxClick(e: React.MouseEvent) {
    if (e.button === 1) {
      e.preventDefault();
      closeTab(tabId);
    }
  }

  return (
    <button
      onClick={handleClick}
      onAuxClick={handleAuxClick}
      className={cn(
        "flex items-center gap-1.5 px-3 py-1.5 text-xs shrink-0 border-b-2 transition-colors",
        isActive
          ? "border-primary text-foreground"
          : "border-transparent text-muted-foreground hover:bg-accent/50 hover:text-foreground",
      )}
    >
      {needsAttention ? (
        <span className="h-1.5 w-1.5 rounded-full bg-yellow-500 animate-pulse" />
      ) : isStreaming ? (
        <span className="h-1.5 w-1.5 rounded-full bg-success animate-pulse" />
      ) : null}
      <span className="truncate max-w-[120px]">{tabTitle}</span>
      <span
        onClick={handleClose}
        className="ml-1 rounded p-0.5 hover:bg-muted text-muted-foreground hover:text-foreground"
      >
        ✕
      </span>
    </button>
  );
}

export function TabBar() {
  const tabIds = useTabStore(useShallow((s) => s.tabs.map((t) => t.id)));
  const openTab = useTabStore((s) => s.openTab);
  const navigate = useNavigate();
  const currentAgentId = useCurrentAgentId();
  const configs = useAgentStore((s) => s.configs);
  const addToast = useUIStore((s) => s.addToast);

  if (tabIds.length <= 1) return null;

  function handleNewTab() {
    if (!currentAgentId) return;
    const agentName = configs.find((c) => c.id === currentAgentId)?.name ?? "New Tab";
    const tabId = openTab(currentAgentId, null, agentName);
    if (!tabId) {
      addToast({ type: "info", message: "Maximum 10 tabs reached." });
      return;
    }
    navigate({ to: "/chat" });
  }

  return (
    <div className="flex h-9 shrink-0 items-center border-b border-border/60 bg-card/20 overflow-x-auto">
      {tabIds.map((id) => (
        <TabItem key={id} tabId={id} />
      ))}
      <button
        onClick={handleNewTab}
        className="flex items-center justify-center px-2 py-1.5 text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors shrink-0"
        title="New tab"
      >
        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
        </svg>
      </button>
    </div>
  );
}
