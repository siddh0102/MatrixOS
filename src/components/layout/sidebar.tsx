import { useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useAgentStore } from "@/stores/agent-store";
import { useConversationStore } from "@/stores/conversation-store";
import { useUIStore } from "@/stores/ui-store";
import { useTabStore, useCurrentAgentId } from "@/stores/tab-store";
import {
  listConversations,
  deleteConversation as dbDeleteConversation,
  updateConversationTitle,
} from "@/memory/conversation-store";
import { cn, truncate } from "@/lib/utils";

function PlusIcon() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
    </svg>
  );
}

/**
 * Collapsible section in the sidebar. The header is the click target;
 * clicking anywhere on the header toggles the section. An optional
 * `action` button (e.g. "+ New Agent") is rendered to the right of the
 * title and only shown when expanded — it makes no sense to invite the
 * user to add something to a collapsed list.
 *
 * Collapsed state is persisted to localStorage per-`id` so the user's
 * arrangement survives reloads. Failures (e.g. private-mode storage)
 * fall back to in-memory only.
 */
function SidebarGroup({
  id,
  title,
  action,
  children,
  scroll = false,
}: {
  id: string;
  title: string;
  action?: ReactNode;
  children: ReactNode;
  /** When true and expanded, the group flexes to share sidebar height and its
   *  body gets its own scrollbar (independent of sibling groups). */
  scroll?: boolean;
}) {
  const storageKey = `sidebar-group:${id}`;
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(storageKey) === "collapsed"; }
    catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem(storageKey, collapsed ? "collapsed" : "expanded"); }
    catch { /* private-mode storage failure — non-fatal */ }
  }, [storageKey, collapsed]);

  return (
    <div className={cn("px-3 pb-1", scroll && !collapsed && "flex min-h-0 flex-1 flex-col")}>
      <div className="mb-2 flex items-center justify-between shrink-0">
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className="flex items-center gap-1.5 text-[9px] font-medium text-sidebar-muted uppercase tracking-[2px] hover:text-sidebar-foreground transition-colors"
          style={{ fontFamily: "'Orbitron', sans-serif" }}
          aria-expanded={!collapsed}
          aria-controls={`sidebar-group-${id}-body`}
        >
          <svg
            className={cn("h-3 w-3 transition-transform", collapsed ? "" : "rotate-90")}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2.5}
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
          <span>{title}</span>
        </button>
        {action && !collapsed && action}
      </div>
      {!collapsed && (
        <div
          id={`sidebar-group-${id}-body`}
          className={cn(scroll && "min-h-0 flex-1 overflow-y-auto")}
        >
          {children}
        </div>
      )}
    </div>
  );
}

function SettingsIcon() {
  return (
    <svg className="h-4.5 w-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  );
}

function ChatIcon() {
  return (
    <svg className="h-4.5 w-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
    </svg>
  );
}

function BotIcon() {
  return (
    <svg className="h-4.5 w-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
    </svg>
  );
}

export function Sidebar() {
  const navigate = useNavigate();
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const addToast = useUIStore((s) => s.addToast);

  const configs = useAgentStore((s) => s.configs);
  // "Current agent" = agent of the focused tab. Replaces the old global activeAgentId.
  const currentAgentId = useCurrentAgentId();

  const conversations = useConversationStore((s) => s.conversations);
  const activeConversationId = useConversationStore(
    (s) => s.activeConversationId,
  );
  const setConversations = useConversationStore((s) => s.setConversations);
  const removeConversation = useConversationStore((s) => s.removeConversation);

  const openTab = useTabStore((s) => s.openTab);
  const setActiveTab = useTabStore((s) => s.setActiveTab);
  const closeTab = useTabStore((s) => s.closeTab);
  const findTabByAgent = useTabStore((s) => s.findTabByAgent);
  const findTabByConversation = useTabStore((s) => s.findTabByConversation);
  const updateTabTitle = useTabStore((s) => s.updateTabTitle);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");

  // Auto-load conversations whenever the focused tab's agent changes.
  // This keeps the sidebar's Conversations list in sync regardless of which
  // page is mounted (chat, agents list, settings, …).
  useEffect(() => {
    if (!currentAgentId) {
      setConversations([]);
      return;
    }
    listConversations(currentAgentId).then(setConversations).catch(() => {});
  }, [currentAgentId, setConversations]);

  async function handleSelectAgent(agentId: string) {
    try {
      const existingTab = findTabByAgent(agentId);
      if (existingTab) {
        setActiveTab(existingTab.id);
        if (existingTab.conversationId) {
          navigate({ to: "/chat/$id", params: { id: existingTab.conversationId } });
        } else {
          navigate({ to: "/chat" });
        }
        return;
      }

      const agentName = configs.find((c) => c.id === agentId)?.name ?? "Agent";
      const convs = await listConversations(agentId);
      setConversations(convs);

      if (convs.length > 0) {
        const tabId = openTab(agentId, convs[0].id, convs[0].title);
        if (!tabId) {
          addToast({ type: "info", message: "Maximum 10 tabs reached." });
          return;
        }
        navigate({ to: "/chat/$id", params: { id: convs[0].id } });
      } else {
        const tabId = openTab(agentId, null, agentName);
        if (!tabId) {
          addToast({ type: "info", message: "Maximum 10 tabs reached." });
          return;
        }
        navigate({ to: "/chat" });
      }
    } catch (err) {
      addToast({ type: "error", message: err instanceof Error ? err.message : "Failed to load agent." });
    }
  }

  async function handleSelectConversation(convId: string) {
    try {
      const existingTab = findTabByConversation(convId);
      if (existingTab) {
        setActiveTab(existingTab.id);
        navigate({ to: "/chat/$id", params: { id: convId } });
        return;
      }

      const conv = conversations.find((c) => c.id === convId);
      if (!conv) return;
      const tabId = openTab(conv.agentId, convId, conv.title);
      if (!tabId) {
        addToast({ type: "info", message: "Maximum 10 tabs reached." });
        return;
      }
      navigate({ to: "/chat/$id", params: { id: convId } });
    } catch (err) {
      addToast({ type: "error", message: err instanceof Error ? err.message : "Failed to load conversation." });
    }
  }

  async function handleDeleteConversation(convId: string) {
    try {
      const tab = findTabByConversation(convId);
      if (tab) closeTab(tab.id);

      await dbDeleteConversation(convId);
      removeConversation(convId);
    } catch (err) {
      addToast({ type: "error", message: err instanceof Error ? err.message : "Failed to delete conversation." });
    }
  }

  function handleNewAgent() {
    navigate({ to: "/agents/new", search: {} });
  }

  async function handleNewConversation() {
    if (!currentAgentId) return;
    const agentName = configs.find((c) => c.id === currentAgentId)?.name ?? "New Tab";
    const tabId = openTab(currentAgentId, null, agentName);
    if (!tabId) {
      addToast({ type: "info", message: "Maximum 10 tabs reached." });
      return;
    }
    navigate({ to: "/chat" });
  }

  function startRename(convId: string, title: string) {
    setEditingId(convId);
    setEditTitle(title);
  }

  async function commitRename() {
    if (!editingId) return;
    try {
      await updateConversationTitle(editingId, editTitle);
      setConversations(
        conversations.map((c) =>
          c.id === editingId ? { ...c, title: editTitle } : c,
        ),
      );
      const tab = findTabByConversation(editingId);
      if (tab) updateTabTitle(tab.id, editTitle);
    } catch {
      /* rename failed */
    }
    setEditingId(null);
  }

  if (!sidebarOpen) return null;

  return (
    <aside className="flex w-[260px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar">
      <div className="flex h-12 items-center justify-between px-4 border-b border-sidebar-border">
        <div className="flex items-center gap-2.5">
          <div className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-primary shadow-[0_0_12px_rgba(79,195,247,0.4),inset_0_0_8px_rgba(79,195,247,0.2)]">
            <span className="text-[11px] font-bold text-primary" style={{ fontFamily: "'Orbitron', sans-serif" }}>M</span>
          </div>
          <span className="text-sm text-primary tracking-[2px] uppercase" style={{ fontFamily: "'Orbitron', sans-serif" }}>
            Matrix
          </span>
        </div>
      </div>

      <div className="flex-1 flex flex-col min-h-0 py-2 gap-1">
        <SidebarGroup
          id="agents"
          title="Agents"
          scroll
          action={
            <button
              onClick={handleNewAgent}
              className="flex items-center justify-center rounded-md p-1.5 text-sidebar-muted hover:text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
              title="New Agent"
            >
              <PlusIcon />
            </button>
          }
        >
          <ul className="space-y-0.5">
            {configs.map((cfg) => (
              <li key={cfg.id}>
                <button
                  onClick={() => handleSelectAgent(cfg.id)}
                  className={cn(
                    "group flex w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-left text-[13px] transition-all duration-150",
                    cfg.id === currentAgentId
                      ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                      : "text-sidebar-foreground hover:bg-sidebar-accent/60",
                  )}
                >
                  <BotIcon />
                  <span className="truncate flex-1">{cfg.name}</span>
                  {cfg.id === currentAgentId && (
                    <span className="h-2 w-2 rounded-full bg-primary flex-shrink-0 shadow-[0_0_6px_rgba(79,195,247,0.8)]" />
                  )}
                </button>
              </li>
            ))}
            {configs.length === 0 && (
              <li className="px-3 py-2.5 text-sm text-sidebar-muted">
                No agents yet
              </li>
            )}
          </ul>
        </SidebarGroup>

        <SidebarGroup
          id="conversations"
          title="Conversations"
          scroll
          action={
            currentAgentId ? (
              <button
                onClick={handleNewConversation}
                className="flex items-center justify-center rounded-md p-1.5 text-sidebar-muted hover:text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
                title="New Conversation"
              >
                <PlusIcon />
              </button>
            ) : undefined
          }
        >
          {!currentAgentId ? (
            <div className="px-3 py-2.5 text-sm text-sidebar-muted">
              Select an agent to see conversations.
            </div>
          ) : (
            <ul className="space-y-0.5">
              {conversations.map((conv) => (
                <li key={conv.id} className="group relative">
                  {editingId === conv.id ? (
                    <input
                      autoFocus
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                      onBlur={commitRename}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitRename();
                        if (e.key === "Escape") setEditingId(null);
                      }}
                      className="w-full rounded-lg bg-sidebar-accent px-3 py-2 text-base outline-none"
                    />
                  ) : (
                    <button
                      onClick={() => handleSelectConversation(conv.id)}
                      onDoubleClick={() => startRename(conv.id, conv.title)}
                      className={cn(
                        "flex w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-left text-[13px] transition-all duration-150",
                        conv.id === activeConversationId
                          ? "bg-sidebar-accent text-sidebar-accent-foreground"
                          : "text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
                      )}
                    >
                      <ChatIcon />
                      <span className="truncate flex-1">
                        {truncate(conv.title, 26)}
                      </span>
                    </button>
                  )}
                  <div className="absolute right-1 top-1/2 -translate-y-1/2 flex gap-0.5 opacity-0 group-hover:opacity-100">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        startRename(conv.id, conv.title);
                      }}
                      className="rounded p-0.5 text-muted-foreground hover:text-foreground"
                      title="Rename conversation"
                    >
                      <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L6.832 19.82a4.5 4.5 0 01-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 011.13-1.897L16.863 4.487z" />
                      </svg>
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteConversation(conv.id);
                      }}
                      className="rounded p-0.5 text-muted-foreground hover:text-destructive"
                      title="Delete conversation"
                    >
                      ✕
                    </button>
                  </div>
                </li>
              ))}
              {conversations.length === 0 && (
                <li className="px-3 py-2.5 text-sm text-sidebar-muted">
                  No conversations yet
                </li>
              )}
            </ul>
          )}
        </SidebarGroup>

        <SidebarGroup id="misc" title="Miscellaneous">
          <div className="space-y-0.5">
            <button
              onClick={() => navigate({ to: "/" })}
              className="flex w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-[13px] text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground transition-all duration-150"
            >
              <svg className="h-4.5 w-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" />
              </svg>
              Dashboard
            </button>
            <button
              onClick={() => navigate({ to: "/agents" })}
              className="flex w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-[13px] text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground transition-all duration-150"
            >
              <BotIcon />
              Manage Agents
            </button>
            <button
              onClick={() => navigate({ to: "/library", search: {} })}
              className="flex w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-[13px] text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground transition-all duration-150"
            >
              <svg className="h-4.5 w-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" />
              </svg>
              Template Library
            </button>
            <button
              onClick={() => navigate({ to: "/knowledge" })}
              className="flex w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-[13px] text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground transition-all duration-150"
            >
              <svg className="h-4.5 w-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4.26 10.147a60.438 60.438 0 00-.491 6.347A48.627 48.627 0 0112 20.904a48.627 48.627 0 018.232-4.41 60.46 60.46 0 00-.491-6.347m-15.482 0a50.57 50.57 0 00-2.658-.813A59.905 59.905 0 0112 3.493a59.902 59.902 0 0110.399 5.84c-.896.248-1.783.52-2.658.814m-15.482 0A50.697 50.697 0 0112 13.489a50.702 50.702 0 017.74-3.342M6.75 15a.75.75 0 100-1.5.75.75 0 000 1.5zm0 0v-3.675A55.378 55.378 0 0112 8.443m-7.007 11.55A5.981 5.981 0 006.75 15.75v-1.5" />
              </svg>
              Knowledge
            </button>
            <button
              onClick={() => navigate({ to: "/schedules" as "/" })}
              className="flex w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-[13px] text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground transition-all duration-150"
            >
              <svg className="h-4.5 w-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              Schedules
            </button>
            <button
              onClick={() => navigate({ to: "/workflows" as "/" })}
              className="flex w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-[13px] text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground transition-all duration-150"
            >
              <svg className="h-4.5 w-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
              </svg>
              Workflows
            </button>
            <button
              onClick={() => navigate({ to: "/settings/providers" })}
              className="flex w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-[13px] text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground transition-all duration-150"
            >
              <SettingsIcon />
              Settings
            </button>
          </div>
        </SidebarGroup>
      </div>
    </aside>
  );
}
