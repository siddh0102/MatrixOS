import { useConversationStore } from "@/stores/conversation-store";
import { useTabStore } from "@/stores/tab-store";
import {
  listConversations,
  deleteConversation as dbDeleteConversation,
  updateConversationTitle as dbUpdateTitle,
} from "@/memory/conversation-store";
import { deleteEpisodicByConversation } from "@/memory/episodic-store";

export function useConversation() {
  const conversations = useConversationStore((s) => s.conversations);
  const activeConversationId = useConversationStore(
    (s) => s.activeConversationId,
  );
  const setConversations = useConversationStore((s) => s.setConversations);
  const setActiveConversation = useConversationStore(
    (s) => s.setActiveConversation,
  );
  const removeConversation = useConversationStore((s) => s.removeConversation);

  async function loadConversations(agentId: string): Promise<void> {
    const convs = await listConversations(agentId);
    setConversations(convs);
  }

  async function deleteConversation(id: string): Promise<void> {
    const tab = useTabStore.getState().findTabByConversation(id);
    if (tab) useTabStore.getState().closeTab(tab.id);

    // Clean up episodic vectors in the separate vec DB before main DB deletion
    await deleteEpisodicByConversation(id).catch(() => {});
    await dbDeleteConversation(id);
    removeConversation(id);
    if (activeConversationId === id) {
      setActiveConversation(null);
    }
  }

  async function renameConversation(id: string, title: string): Promise<void> {
    await dbUpdateTitle(id, title);
    useConversationStore.getState().setConversations(
      conversations.map((c) => (c.id === id ? { ...c, title } : c)),
    );
    const tab = useTabStore.getState().findTabByConversation(id);
    if (tab) useTabStore.getState().updateTabTitle(tab.id, title);
  }

  return {
    conversations,
    activeConversationId,
    setActiveConversation,
    loadConversations,
    deleteConversation,
    renameConversation,
  };
}
