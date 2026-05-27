import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useAgent } from "@/hooks/use-agent";
import { AgentCard } from "./agent-card";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { importAgentFromFile } from "@/agents/agent-import";
import { useUIStore } from "@/stores/ui-store";
import { useTabStore } from "@/stores/tab-store";
import { listConversations } from "@/memory/conversation-store";
import { useConversationStore } from "@/stores/conversation-store";

export function AgentListPage() {
  const navigate = useNavigate();
  const { configs, currentAgentId, deleteAgent } = useAgent();
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const addToast = useUIStore((s) => s.addToast);

  async function handleImportAgent() {
    try {
      const result = await importAgentFromFile();
      if (!result) return;
      addToast({ type: "success", message: `Agent "${result.config.name}" imported successfully` });
      for (const warning of result.warnings) {
        addToast({ type: "info", message: warning, duration: 8000 });
      }
    } catch (err) {
      addToast({ type: "error", message: err instanceof Error ? err.message : "Import failed" });
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    try {
      await deleteAgent(deleteTarget);
    } catch (err) {
      addToast({
        type: "error",
        message: `Failed to delete agent: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setDeleteTarget(null);
    }
  }

  async function handleOpen(agentId: string) {
    const store = useTabStore.getState();
    const existing = store.findTabByAgent(agentId);
    if (existing) {
      store.setActiveTab(existing.id);
      if (existing.conversationId) {
        navigate({ to: "/chat/$id", params: { id: existing.conversationId } });
      } else {
        navigate({ to: "/chat" });
      }
      return;
    }

    const agentName = configs.find((c) => c.id === agentId)?.name ?? "Agent";
    const convs = await listConversations(agentId).catch(() => []);
    useConversationStore.getState().setConversations(convs);

    if (convs.length > 0) {
      const tabId = store.openTab(agentId, convs[0].id, convs[0].title);
      if (!tabId) { addToast({ type: "info", message: "Maximum 10 tabs reached." }); return; }
      navigate({ to: "/chat/$id", params: { id: convs[0].id } });
    } else {
      const tabId = store.openTab(agentId, null, agentName);
      if (!tabId) { addToast({ type: "info", message: "Maximum 10 tabs reached." }); return; }
      navigate({ to: "/chat" });
    }
  }

  return (
    <div className="flex flex-1 flex-col overflow-auto p-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Agents</h1>
        <div className="flex gap-2">
          <Button onClick={() => navigate({ to: "/agents/export" })}>
            Bulk Export
          </Button>
          <Button onClick={handleImportAgent}>
            Import Agent
          </Button>
          <Button onClick={() => navigate({ to: "/agents/new", search: {} })}>
            + New Agent
          </Button>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {configs.map((config) => (
          <AgentCard
            key={config.id}
            config={config}
            isCurrent={config.id === currentAgentId}
            onOpen={() => handleOpen(config.id)}
            onEdit={() =>
              navigate({
                to: "/agents/$id/edit",
                params: { id: config.id },
              })
            }
            onDelete={() => setDeleteTarget(config.id)}
          />
        ))}
      </div>

      {configs.length === 0 && (
        <div className="flex flex-1 items-center justify-center text-muted-foreground">
          No agents configured. Create one to get started.
        </div>
      )}

      <Dialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title="Delete Agent"
      >
        <p className="mb-4 text-sm text-muted-foreground">
          This will permanently delete this agent and all associated
          conversations. This action cannot be undone.
        </p>
        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            onClick={() => setDeleteTarget(null)}
          >
            Cancel
          </Button>
          <Button onClick={handleDelete}>Delete</Button>
        </div>
      </Dialog>
    </div>
  );
}
