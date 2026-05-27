import { nanoid } from "nanoid";
import { isoNow } from "@/lib/utils";
import { createConversation } from "@/memory/conversation-store";
import { useConversationStore } from "@/stores/conversation-store";

export async function createNewConversation(agentId: string): Promise<string | null> {
  const now = isoNow();
  const conv = {
    id: nanoid(),
    agentId,
    title: "New Conversation",
    createdAt: now,
    updatedAt: now,
  };
  try {
    await createConversation(conv);
    useConversationStore.getState().addConversation(conv);
    useConversationStore.getState().setActiveConversation(conv.id);
    useConversationStore.getState().setMessages([]);
    return conv.id;
  } catch {
    return null;
  }
}
