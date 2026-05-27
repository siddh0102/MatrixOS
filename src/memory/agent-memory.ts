import type { AgentConfig, MessageSource } from "@/types";
import type { ILLMProvider } from "@/types/provider";
import { retrieveMemoryContext } from "@/memory/memory-manager";
import { saveEpisodicEntry } from "@/memory/episodic-store";
import { useKnowledgeStore } from "@/stores/knowledge-store";

/**
 * Single shared memory path for ALL agent turns (chat, workflow, delegation,
 * scheduled). Called from inside executeAgentTurn so every execution path
 * behaves identically. Both functions are fail-soft: a memory error (e.g. the
 * embedding worker is absent in the background window) degrades to "no memory",
 * never breaks the turn.
 */

/** Retrieve memory context + semantic sources for an agent's turn. */
export async function retrieveForAgent(
  config: AgentConfig,
  query: string,
): Promise<{ contextText?: string; sources?: MessageSource[] }> {
  if (!config.memoryConfig?.enabled) return {};
  const embeddingConfig = useKnowledgeStore.getState().embeddingConfig;
  if (!embeddingConfig) return {};
  try {
    const ctx = await retrieveMemoryContext(query, config.id, config.memoryConfig, embeddingConfig);
    const sources: MessageSource[] | undefined =
      ctx.semantic.length > 0
        ? ctx.semantic.map((r) => ({
            type: "semantic" as const,
            documentId: r.document.id,
            documentName: r.document.name,
            chunkId: r.chunk.id,
            chunkIndex: r.chunk.chunkIndex,
            score: r.score,
            excerpt: r.chunk.text.slice(0, 200),
          }))
        : undefined;
    return { contextText: ctx.formattedText || undefined, sources };
  } catch {
    return {};
  }
}

/**
 * Record an episodic memory after a turn. "Smart" mode: distill the exchange to
 * durable facts via a cheap LLM call before storing; if distillation fails, fall
 * back to the raw transcript that saveEpisodicEntry builds by default.
 */
export async function recordEpisodicForAgent(
  config: AgentConfig,
  provider: ILLMProvider,
  conversationId: string,
  userMessageId: string,
  assistantMessageId: string,
  query: string,
  response: string,
): Promise<void> {
  if (!config.memoryConfig?.enabled || !config.memoryConfig.episodicEnabled) return;
  const embeddingConfig = useKnowledgeStore.getState().embeddingConfig;
  if (!embeddingConfig) return;
  try {
    const summary = await distill(config, provider, query, response);
    await saveEpisodicEntry(
      conversationId,
      config.id,
      userMessageId,
      assistantMessageId,
      query,
      response,
      embeddingConfig,
      summary,
    );
  } catch {
    /* fail-soft — memory write never blocks the turn */
  }
}

async function distill(
  config: AgentConfig,
  provider: ILLMProvider,
  query: string,
  response: string,
): Promise<string | undefined> {
  try {
    const resp = await provider.sendMessage({
      model: config.modelId,
      systemPrompt:
        "Extract the durable, reusable facts worth remembering from this exchange " +
        "as 2-5 terse bullet points. Omit pleasantries, restated questions, and " +
        "one-off details. Output only the bullets.",
      messages: [
        { role: "user", content: [{ type: "text", text: `TASK:\n${query}\n\nRESPONSE:\n${response}` }] },
      ],
      maxTokens: 256,
      temperature: 0,
      callContext: { type: "User" },
    });
    const text = resp.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .trim();
    return text || undefined;
  } catch {
    return undefined; // → saveEpisodicEntry uses its raw-transcript default
  }
}
