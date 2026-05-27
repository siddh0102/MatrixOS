import { nanoid } from "nanoid";
import { isoNow } from "@/lib/utils";
import {
  getMessages,
  getActiveSummary,
  applyCompaction,
} from "@/memory/conversation-store";
import { eventBus } from "@/orchestration/event-bus";
import type {
  ILLMProvider,
  LLMMessage,
  Message,
  MessageContent,
  MessageSource,
} from "@/types";

/**
 * Number of most-recent message rows preserved verbatim across a
 * compaction. With 6 (3 user+assistant exchanges) the agent still has
 * fresh back-and-forth context after a compaction; older turns get
 * summarized.
 */
export const KEEP_VERBATIM_MESSAGES = 6;

/**
 * Hard cap on the summary length (tokens, ~4 chars each → ~3200 chars).
 * Prevents the summary from itself approaching the context window after
 * many compactions, and gives the LLM a clear length target.
 */
export const SUMMARY_TOKEN_CAP = 800;

/**
 * Minimum number of messages a conversation must have before compaction
 * is allowed. Compacting a tiny conversation is wasted effort and the
 * summary would carry less information than the originals.
 */
export const MIN_MESSAGES_TO_COMPACT = KEEP_VERBATIM_MESSAGES + 2;

const COMPACTION_SYSTEM_PROMPT =
  "You are a conversation summarizer. Read the conversation provided in the user message and output ONLY a concise summary — no preamble, no markdown headers, no closing remarks.";

/**
 * Render a Message into a plain-text line for the summarizer's input.
 * Drops thinking blocks (private chain-of-thought, not useful here) and
 * tool_call/tool_result blocks (verbose, low signal for summary). Keeps
 * text and image-presence indicators.
 */
function renderMessageForSummary(msg: Message): string | null {
  const text = msg.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  const imageCount = msg.content.filter((c) => c.type === "image").length;
  const toolCount = msg.content.filter(
    (c) => c.type === "tool_call" || c.type === "tool_result",
  ).length;
  if (!text && imageCount === 0 && toolCount === 0) return null;
  const role = msg.role === "user" ? "USER" : msg.role === "assistant" ? "ASSISTANT" : "SYSTEM";
  const tags: string[] = [];
  if (imageCount > 0) tags.push(`[${imageCount} image${imageCount === 1 ? "" : "s"}]`);
  if (toolCount > 0) tags.push(`[${toolCount} tool call${toolCount === 1 ? "" : "s"}]`);
  return `${role}:${tags.length ? " " + tags.join(" ") : ""}${text ? "\n" + text : ""}`;
}

/**
 * Aggregate unique document names from the `sources` field across a set
 * of messages. The compactor passes this hint to the LLM so the summary
 * can mention which knowledge documents shaped the earlier conversation
 * — the per-message "🔍 N sources" badge disappears when a message is
 * compacted, so this is how we keep the attribution alive.
 */
function aggregateSourceDocNames(messages: Message[]): string[] {
  const names = new Set<string>();
  for (const m of messages) {
    if (!m.sources) continue;
    for (const s of m.sources) {
      if (s.type === "semantic" && s.documentName) names.add(s.documentName);
    }
  }
  return Array.from(names);
}

export interface CompactionResult {
  /** Number of original messages folded into the new summary. */
  compactedCount: number;
  /** First ~200 chars of the new summary — for the success toast. */
  summaryPreview: string;
  /** Full summary text. */
  summaryText: string;
  /** Whether a prior summary was replaced (vs. first-ever compaction). */
  replacedPriorSummary: boolean;
}

/**
 * Splits the live history into [old, last K verbatim], asks the LLM to
 * summarize the [old] turns (folding in any prior summary), and persists
 * the new state atomically: prior summary deleted, old turns marked
 * `compacted_at = now`, new summary inserted.
 *
 * Returns `null` when there's nothing to compact (conversation too short,
 * or no old messages eligible).
 */
export async function compactConversation(
  conversationId: string,
  provider: ILLMProvider,
  model: string,
  signal?: AbortSignal,
): Promise<CompactionResult | null> {
  const live = await getMessages(conversationId);
  if (live.length < MIN_MESSAGES_TO_COMPACT) {
    return null;
  }

  // Split — last K stay verbatim, everything earlier is compaction fuel.
  const keepStart = Math.max(0, live.length - KEEP_VERBATIM_MESSAGES);
  const toCompact = live.slice(0, keepStart);
  if (toCompact.length === 0) return null;

  // Pull the existing summary (if any) so we can fold it into the new one.
  // Without this, recursive compactions would discard earlier summaries
  // and lose info further and further back.
  const priorSummary = await getActiveSummary(conversationId);

  // Render the inputs into a single user-message payload the LLM
  // summarizes. The compaction LLM call is non-streaming: we just want
  // the final summary text and don't need partial chunks.
  const lines: string[] = [];
  if (priorSummary && priorSummary.text.trim()) {
    lines.push(
      "PRIOR SUMMARY OF EARLIER MESSAGES:\n" + priorSummary.text.trim(),
      "",
      "MESSAGES SINCE THAT SUMMARY:",
    );
  } else {
    lines.push("MESSAGES TO SUMMARIZE:");
  }
  for (const m of toCompact) {
    const rendered = renderMessageForSummary(m);
    if (rendered) lines.push("", rendered);
  }
  const docNames = aggregateSourceDocNames(toCompact);
  const sourcesHint = docNames.length > 0
    ? `\n\nThe earlier turns drew on these knowledge-base documents: ${docNames.map((n) => `[${n}]`).join(", ")}. Mention them naturally when relevant in your summary.`
    : "";

  const userPrompt = [
    `Summarize the conversation below in 200–400 words. Preserve: the user's stated goals, key facts and decisions established, open questions or follow-ups. Be specific — keep names, numbers, file paths, and any code symbols verbatim. Do not invent facts. ${docNames.length > 0 ? "When citing sources, use the [filename] format already established in the conversation." : ""}${sourcesHint}`,
    "",
    "---",
    "",
    lines.join("\n"),
  ].join("\n");

  const llmMessages: LLMMessage[] = [
    { role: "user", content: [{ type: "text", text: userPrompt }] },
  ];

  const response = await provider.sendMessage({
    model,
    systemPrompt: COMPACTION_SYSTEM_PROMPT,
    messages: llmMessages,
    maxTokens: SUMMARY_TOKEN_CAP,
    temperature: 0.3,
    signal,
  });

  const summaryText = response.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  if (!summaryText) {
    // Defensive: an empty summary would lose all the compacted info.
    // Skip the persist step and let the caller decide what to do.
    throw new Error("Compaction LLM returned an empty summary");
  }

  // Carry source attribution forward as a synthetic MessageSource[] on
  // the summary row, so the summary chip in the UI can still show
  // "🔍 N sources" reflecting what was used earlier.
  const carryForwardSources: MessageSource[] = [];
  const seen = new Set<string>();
  for (const m of toCompact) {
    if (!m.sources) continue;
    for (const s of m.sources) {
      if (s.type !== "semantic") continue;
      if (seen.has(s.documentId)) continue;
      seen.add(s.documentId);
      carryForwardSources.push(s);
    }
  }

  const summaryContent: MessageContent[] = [{ type: "text", text: summaryText }];
  const newSummary: Message = {
    id: nanoid(),
    conversationId,
    role: "system",
    content: summaryContent,
    tokenCount: response.usage.outputTokens || null,
    model: response.model || null,
    telemetryId: null,
    createdAt: isoNow(),
    sources: carryForwardSources.length > 0 ? carryForwardSources : undefined,
    isSummary: true,
    compactedAt: null,
  };

  await applyCompaction(
    conversationId,
    toCompact.map((m) => m.id),
    newSummary,
  );

  const result: CompactionResult = {
    compactedCount: toCompact.length,
    summaryPreview: summaryText.slice(0, 200),
    summaryText,
    replacedPriorSummary: priorSummary !== null,
  };

  // Fire the event so the chat UI can refresh and toast. Both the auto
  // trigger in agent-runtime AND the manual /compact path go through
  // here, so subscribers are wired once.
  eventBus.emit(
    "conversation:compacted",
    {
      conversationId,
      compactedCount: result.compactedCount,
      summaryPreview: result.summaryPreview,
      replacedPriorSummary: result.replacedPriorSummary,
    },
    "compactor",
  );

  return result;
}
