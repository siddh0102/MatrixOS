import { useEffect, useRef } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useAgentStore } from "@/stores/agent-store";
import { useConversationStore } from "@/stores/conversation-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useUIStore } from "@/stores/ui-store";
import { useApprovalStore } from "@/stores/approval-store";
import { useTabStore } from "@/stores/tab-store";
import { useLibrary } from "@/hooks/use-library";
import { hasProviderApiKey } from "@/kernel/secure-store";
import { createProvider } from "@/providers";
import { createInstance } from "@/agents/agent-factory";
import { executeAgentTurn } from "@/agents/agent-runtime";
import type { StreamCallbacks } from "@/agents/agent-runtime";
import { processManager } from "@/orchestration/process-manager";
import { eventBus } from "@/orchestration/event-bus";
import {
  createConversation,
  getMessagesForChat,
  getConversation,
  listConversations,
} from "@/memory/conversation-store";
import { MessageList } from "./message-list";
import { ChatInput } from "./chat-input";
import { TabBar } from "./tab-bar";
import { ToolApprovalModal } from "@/components/tools/tool-approval-modal";
import { nanoid } from "nanoid";
import { isoNow } from "@/lib/utils";
import type { AgentConfig, ILLMProvider } from "@/types";

function EmptyState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 px-8">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary-muted">
        <svg className="h-6 w-6 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
        </svg>
      </div>
      <div className="text-center max-w-xs">
        <h3 className="text-sm font-medium text-foreground mb-1">Select an agent</h3>
        <p className="text-xs text-muted-foreground/70 leading-relaxed">
          Choose an agent from the sidebar or create a new one to start chatting.
        </p>
      </div>
    </div>
  );
}

export function ChatPage() {
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as { id?: string };
  const routeConvId = params.id;

  const configs = useAgentStore((s) => s.configs);
  const instances = useAgentStore((s) => s.instances);
  const setInstance = useAgentStore((s) => s.setInstance);
  const updateInstance = useAgentStore((s) => s.updateInstance);
  const removeInstance = useAgentStore((s) => s.removeInstance);
  const addConversation = useConversationStore((s) => s.addConversation);
  const setActiveConversation = useConversationStore((s) => s.setActiveConversation);
  const setConversations = useConversationStore((s) => s.setConversations);

  const providers = useSettingsStore((s) => s.providers);
  const addToast = useUIStore((s) => s.addToast);

  const pendingApprovals = useApprovalStore((s) => s.pendingRequests);
  const resolveApproval = useApprovalStore((s) => s.resolve);

  const { resolveSkillPrompts } = useLibrary();

  // Per-tab state selectors — use primitives to avoid re-render cascades
  const activeTabId = useTabStore((s) => s.activeTabId);
  const hasActiveTab = useTabStore((s) => s.activeTabId !== null);
  const isActiveStreaming = useTabStore(
    (s) => s.tabStates[s.activeTabId ?? ""]?.isStreaming ?? false,
  );
  const activeTabAgentId = useTabStore(
    (s) => s.tabs.find((t) => t.id === s.activeTabId)?.agentId ?? null,
  );
  const activeConvId = useTabStore(
    (s) => s.tabs.find((t) => t.id === s.activeTabId)?.conversationId ?? null,
  );

  const activeConfig = configs.find((c) => c.id === activeTabAgentId);

  // Deep link: ensure a tab exists when navigating directly to /chat/$id
  useEffect(() => {
    if (!routeConvId) return;
    const store = useTabStore.getState();
    const existingTab = store.findTabByConversation(routeConvId);
    if (existingTab) {
      if (existingTab.id !== store.activeTabId) store.setActiveTab(existingTab.id);
      return;
    }
    getConversation(routeConvId).then((conv) => {
      if (!conv) return;
      const tabId = store.openTab(conv.agentId, conv.id, conv.title);
      if (!tabId) addToast({ type: "info", message: "Maximum 10 tabs reached." });
    });
  }, [routeConvId]);

  // Load messages when active tab changes and messages haven't been loaded yet
  useEffect(() => {
    const store = useTabStore.getState();
    const tab = store.getActiveTab();
    const state = store.getActiveTabState();
    if (!tab?.conversationId) return;
    if (state?.messagesLoaded) return;

    const tabId = tab.id;
    const convId = tab.conversationId;
    // Use getMessagesForChat so the UI sees compacted-out rows (grayed)
    // and the active summary row (rendered as the compaction divider) in
    // their original chronological positions.
    getMessagesForChat(convId).then((msgs) => {
      useTabStore.getState().setTabMessages(tabId, msgs);
    }).catch(() => {});
  }, [activeTabId]);

  // Refresh conversation list when active tab's agent changes.
  // (Sidebar also handles this for non-chat pages — duplicate-safe.)
  useEffect(() => {
    if (activeTabAgentId) {
      listConversations(activeTabAgentId).then(setConversations).catch(() => {});
    }
  }, [activeTabAgentId, setConversations]);

  // Sync activeConversationId for sidebar highlight
  useEffect(() => {
    if (activeConvId !== useConversationStore.getState().activeConversationId) {
      setActiveConversation(activeConvId);
    }
  }, [activeConvId]);

  // Surface compaction events as a toast + refresh the active tab's
  // message list so the new divider and grayed-out rows appear.
  useEffect(() => {
    const sub = eventBus.on<{
      conversationId: string;
      compactedCount: number;
      summaryPreview: string;
      replacedPriorSummary: boolean;
    }>("conversation:compacted", (event) => {
      const { conversationId, compactedCount, replacedPriorSummary } = event.payload;
      addToast({
        type: "info",
        message: `🗜 Compacted ${compactedCount} earlier message${compactedCount === 1 ? "" : "s"}${replacedPriorSummary ? " (folded in prior summary)" : ""} to keep the conversation within the model's context window.`,
        duration: 6000,
      });
      // If the compacted conversation is open in any tab, refresh its
      // message list from DB. The setTabMessages call replaces the in-
      // memory list with the post-compaction view (summary row + grayed
      // originals + recent live messages).
      const tabs = useTabStore.getState().tabs;
      for (const t of tabs) {
        if (t.conversationId === conversationId) {
          getMessagesForChat(conversationId).then((msgs) => {
            useTabStore.getState().setTabMessages(t.id, msgs);
          }).catch(() => {});
        }
      }
    });
    return () => sub.unsubscribe();
  }, [addToast]);

  // Clean up per-tab instances when tabs are closed
  const prevTabsRef = useRef(useTabStore.getState().tabs);
  useEffect(() => {
    const unsub = useTabStore.subscribe(
      (s) => s.tabs,
      (tabs, prevTabs) => {
        const currentIds = new Set(tabs.map((t) => t.id));
        for (const prev of prevTabs) {
          if (!currentIds.has(prev.id)) {
            removeInstance(`${prev.id}-inst`);
          }
        }
        prevTabsRef.current = tabs;
      },
    );
    return unsub;
  }, []);

  async function resolveFallbackProviders(config: AgentConfig): Promise<ILLMProvider[]> {
    if (!config.fallbackProviderIds?.length) return [];
    const result: ILLMProvider[] = [];
    for (const pid of config.fallbackProviderIds) {
      const cfg = providers.find((p) => p.id === pid);
      if (!cfg || !cfg.enabled) continue;
      if (cfg.type === "claude" || cfg.type === "openai-compatible") {
        const hasKey = await hasProviderApiKey(cfg.id);
        if (!hasKey) continue;
      }
      result.push(createProvider(cfg));
    }
    return result;
  }

  async function handleSend(text: string, attachedImages?: import("@/types").ImageContent[]) {
    // Diagnostic instrumentation — prints a labeled, timestamped trace of every
    // major step in the send pipeline. Each line includes elapsed-from-send so
    // you can spot where time is going or where the chain stalls. Safe to leave
    // on; disable by setting localStorage.MATRIXOS_NO_TRACE = "1".
    const traceEnabled = (() => {
      try { return localStorage.getItem("MATRIXOS_NO_TRACE") !== "1"; }
      catch { return true; }
    })();
    const t0 = performance.now();
    const trace = (label: string, extra?: Record<string, unknown>) => {
      if (!traceEnabled) return;
      const ms = (performance.now() - t0).toFixed(0).padStart(6);
      // eslint-disable-next-line no-console
      console.log(`[send +${ms}ms] ${label}`, extra ?? "");
    };
    trace("handleSend:start");

    // /compact — manual compaction trigger. Runs the same compactor used
    // by the auto-trigger at 80%, then exits without sending an LLM
    // turn. Lets users proactively shrink the prompt before a costly
    // turn (e.g. before asking a research-heavy question).
    if (text.trim() === "/compact" && (!attachedImages || attachedImages.length === 0)) {
      const tabSnap = useTabStore.getState().getActiveTab();
      if (!tabSnap?.conversationId) {
        addToast({ type: "info", message: "Nothing to compact yet — start the conversation first." });
        return;
      }
      const cfg = configs.find((c) => c.id === tabSnap.agentId);
      const prov = cfg ? providers.find((p) => p.id === cfg.providerId) : undefined;
      if (!cfg || !prov || !prov.enabled) {
        addToast({ type: "error", message: "Cannot compact: provider not configured." });
        return;
      }
      try {
        const { compactConversation } = await import("@/agents/compactor");
        const llmProvider = createProvider(prov);
        const result = await compactConversation(tabSnap.conversationId, llmProvider, cfg.modelId);
        if (!result) {
          addToast({ type: "info", message: "Not enough messages to compact yet." });
        }
        // On success, the compactor itself fires the conversation:compacted
        // event handled below — toast + UI refresh happen automatically.
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        addToast({ type: "error", message: `Compaction failed: ${msg}` });
      }
      return;
    }

    const tabSnapshot = useTabStore.getState().getActiveTab();
    if (!tabSnapshot) return;
    const currentTabId = tabSnapshot.id;
    const agentId = tabSnapshot.agentId;

    const activeConfig = configs.find((c) => c.id === agentId);
    if (!activeConfig) {
      addToast({ type: "error", message: "No agent selected." });
      return;
    }

    const provider = providers.find((p) => p.id === activeConfig.providerId);
    if (!provider || !provider.enabled) {
      addToast({
        type: "error",
        message: 'No provider configured. Click "Connection Settings" at the bottom of the sidebar to add one.',
        duration: 8000,
      });
      return;
    }

    const instanceId = `${currentTabId}-inst`;
    let instance = instances.get(instanceId);
    if (!instance) {
      const base = createInstance(activeConfig);
      instance = { ...base, instanceId };
      setInstance(instanceId, instance);
    }
    if (instance.status === "running") {
      addToast({ type: "info", message: "Agent is already running in this tab." });
      return;
    }

    if (provider.type === "claude" || provider.type === "openai-compatible") {
      const hasKey = await hasProviderApiKey(provider.id);
      if (!hasKey) {
        addToast({
          type: "error",
          message: `API key not set for ${provider.name}. Go to Settings.`,
        });
        return;
      }
    }

    let convId = tabSnapshot.conversationId;
    trace("convId from tab", { convId });
    // Validate that the tab's conversationId still exists in DB. Tab state in
    // localStorage outlives the DB row when a conversation/agent has been
    // deleted in a previous session, so we may have a dangling id. Without
    // this check, saveMessage below would hit FOREIGN KEY constraint failed
    // (code 787) because messages.conversation_id references conversations(id).
    if (convId) {
      const existing = await getConversation(convId);
      trace("getConversation done", { found: !!existing });
      if (!existing) convId = null;
    }
    if (!convId) {
      const now = isoNow();
      const conv = {
        id: nanoid(),
        agentId,
        title: text.slice(0, 50),
        createdAt: now,
        updatedAt: now,
      };
      await createConversation(conv);
      addConversation(conv);
      useTabStore.getState().updateTabConversation(currentTabId, conv.id, conv.title);
      convId = conv.id;
      // Only navigate if this tab is still the active one (user may have switched)
      if (useTabStore.getState().activeTabId === currentTabId) {
        navigate({ to: "/chat/$id", params: { id: conv.id } });
      }
    }

    const userContent: import("@/types").MessageContent[] = [
      { type: "text" as const, text },
      ...(attachedImages ?? []),
    ];
    const userMsg = {
      id: nanoid(),
      conversationId: convId,
      role: "user" as const,
      content: userContent,
      tokenCount: null,
      model: null,
      telemetryId: null,
      createdAt: isoNow(),
    };
    useTabStore.getState().addTabMessage(currentTabId, userMsg);

    const llmProvider = createProvider(provider);
    const fallbackProviders = await resolveFallbackProviders(activeConfig);
    trace("provider ready", { type: provider.type, fallbacks: fallbackProviders.length });
    useTabStore.getState().setTabStreaming(currentTabId, true);
    trace("typing bubble shown");

    const toolCallArgs = new Map<string, string>();

    // Watch approval store to flag this tab as needing attention
    const unsubApproval = useApprovalStore.subscribe((state) => {
      const hasPending = state.pendingRequests.some((r) => r.status === "pending");
      useTabStore.getState().setTabNeedsAttention(currentTabId, hasPending);
    });

    const callbacks: StreamCallbacks = {
      onMessageStart: () => {},
      onTextDelta: (delta) => {
        useTabStore.getState().appendTabStreamingText(currentTabId, delta);
      },
      onThinkingDelta: (delta) => {
        useTabStore.getState().appendTabStreamingThinking(currentTabId, delta);
      },
      onThinkingEnd: () => {
        useTabStore.getState().setTabIsThinking(currentTabId, false);
      },
      onToolCallStart: (toolCallId, toolName) => {
        toolCallArgs.set(toolCallId, "");
        useTabStore.getState().addTabStreamingToolCall(currentTabId, toolCallId, toolName);
      },
      onToolCallDelta: (toolCallId, partialJson) => {
        const prev = toolCallArgs.get(toolCallId) ?? "";
        toolCallArgs.set(toolCallId, prev + partialJson);
        try {
          const parsed = JSON.parse(toolCallArgs.get(toolCallId)!);
          useTabStore.getState().updateTabStreamingToolCall(currentTabId, toolCallId, parsed);
        } catch {
          // partial JSON not yet parseable
        }
      },
      onToolCallEnd: (toolCallId, _toolName, args) => {
        useTabStore.getState().updateTabStreamingToolCall(currentTabId, toolCallId, args);
        useTabStore.getState().finishTabStreamingToolCall(currentTabId, toolCallId);
      },
      onMessageEnd: (usage) => {
        updateInstance(instanceId, { status: "idle" });
        if (processId) {
          processManager.recordTokenUsage(processId, usage.inputTokens, usage.outputTokens);
        }
      },
      onError: (err) => {
        useTabStore.getState().clearTabStreaming(currentTabId);
        addToast({ type: "error", message: err.message });
      },
    };

    let processId: string | null = null;

    try {
      try {
        trace("processManager.spawn:start");
        const { process: spawnedProcess } = await processManager.spawn({
          agentId: agentId,
          conversationId: convId,
          priority: "interactive",
          tokenBudget: activeConfig.processBudget,
        });
        processId = spawnedProcess.id;
        trace("processManager.spawn:done", { processId });
      } catch (spawnErr) {
        // Process manager is best-effort. If it fails (e.g. DB migration not yet run, budget exceeded),
        // surface the warning but continue with the agent turn — chat must not be blocked.
        const msg = spawnErr instanceof Error ? spawnErr.message : String(spawnErr);
        trace("processManager.spawn:err", { msg });
        addToast({ type: "info", message: `Process tracking unavailable: ${msg}` });
      }

      const skillPrompts = resolveSkillPrompts(activeConfig.skillIds ?? []);

      // Memory retrieval + episodic write now live inside executeAgentTurn
      // (single shared path for chat/workflow/delegation/scheduled), gated by
      // the agent's memoryConfig. Nothing to do here.
      trace("executeAgentTurn:start");
      const assistantMsg = await executeAgentTurn(
        activeConfig,
        instance,
        userContent,
        llmProvider,
        convId,
        callbacks,
        fallbackProviders.length > 0 ? fallbackProviders : undefined,
        skillPrompts.length > 0 ? skillPrompts : undefined,
        undefined, // memoryContext — resolved inside executeAgentTurn
        undefined, // delegationDepth
        undefined, // memorySources — resolved inside executeAgentTurn
      );
      trace("executeAgentTurn:done", { content_blocks: assistantMsg.content.length });
      useTabStore.getState().clearTabStreaming(currentTabId);
      useTabStore.getState().addTabMessage(currentTabId, assistantMsg);

      if (useTabStore.getState().activeTabId !== currentTabId) {
        useTabStore.getState().setTabNeedsAttention(currentTabId, true);
        addToast({ type: "info", message: `${activeConfig.name} finished in background tab` });
      }

      if (processId) {
        await processManager.markCompleted(processId);
      }

    } catch (err) {
      useTabStore.getState().clearTabStreaming(currentTabId);
      const message = err instanceof Error ? err.message : String(err);
      // executeAgentTurn already surfaces its own errors via onError; only toast here for pre-LLM failures (e.g. processManager.spawn).
      if (!processId) {
        addToast({ type: "error", message: `Failed to start agent turn: ${message}` });
      }
      const currentStatus = useAgentStore.getState().instances.get(instanceId)?.status;
      if (currentStatus === "running" || currentStatus === "error") {
        updateInstance(instanceId, { status: "idle" });
      }
      if (processId) {
        await processManager.markFailed(processId, message).catch(() => {});
      }
    } finally {
      unsubApproval();
    }
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <TabBar />
      {hasActiveTab ? (
        <>
          <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border/60 bg-card/30 px-5">
            <div className="flex h-7 w-7 items-center justify-center rounded-xl bg-primary-muted">
              <svg className="h-4 w-4 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
            </div>
            <div className="flex items-center gap-2.5 min-w-0">
              <span className="text-[15px] font-medium truncate">{activeConfig?.name}</span>
              <span className="text-xs text-muted-foreground/70 bg-muted px-2 py-0.5 rounded font-mono">
                {activeConfig?.modelId}
              </span>
            </div>
          </div>
          <MessageList />
          <ChatInput onSend={handleSend} disabled={isActiveStreaming} />
        </>
      ) : (
        <EmptyState />
      )}
      {pendingApprovals.map((req) => (
        <ToolApprovalModal
          key={req.id}
          request={req}
          agentName={activeConfig?.name}
          onClose={() => resolveApproval(req.id, "rejected")}
        />
      ))}
    </div>
  );
}
