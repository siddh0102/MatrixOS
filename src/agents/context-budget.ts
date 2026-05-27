import { estimateTokens } from "@/memory/embedding-service";
import type { LLMMessage, LLMToolDefinition } from "@/types";

/**
 * Per-message structural overhead in tokens. OpenAI-compatible chat formats
 * spend a few tokens encoding role/separator markers around each message;
 * this is a small constant added on top of content tokens to avoid
 * underestimating.
 */
const MESSAGE_OVERHEAD_TOKENS = 10;

/**
 * How close to `context_window` we allow the prompt to grow before
 * triggering compaction. 0.80 means "compact when prompt is 80% full",
 * leaving 20% headroom for the new user message + at least a minimal
 * response.
 */
export const COMPACTION_THRESHOLD = 0.80;

/**
 * Safety margin (tokens) subtracted from the context window when computing
 * `max_tokens` cap. Absorbs estimator drift between our 4-char heuristic
 * and the model's real tokenizer.
 */
export const TOKEN_SAFETY_MARGIN = 256;

/**
 * Rough token estimate for a single LLM content block. Mirrors the shape
 * of `LLMContentBlock` in types/provider.ts. Images, tool_use, and
 * tool_result are deliberately undercounted by content but overcounted by
 * a small constant — the model APIs charge for image tokens separately
 * and our budgeter doesn't need to be exact, just consistently
 * conservative.
 */
function estimateBlockTokens(block: LLMMessage["content"][number]): number {
  switch (block.type) {
    case "text":
      return estimateTokens(block.text);
    case "image":
      // Vision models charge ~85 tokens per low-res image, more for high-res.
      // We don't know which mode the host model uses; 200 is a conservative
      // floor that prevents wild underestimation when budgeting.
      return 200;
    case "thinking":
      return estimateTokens(block.thinking);
    case "tool_use":
      // Tool name + args JSON. JSON.stringify is cheap; the budgeter runs
      // once per turn, not per chunk.
      return estimateTokens(block.name) + estimateTokens(JSON.stringify(block.input)) + 5;
    case "tool_result":
      return estimateTokens(block.content) + 5;
  }
}

/**
 * Token cost of a single message including role/separator overhead.
 */
export function estimateMessageTokens(msg: LLMMessage): number {
  const contentTokens = msg.content.reduce(
    (sum, block) => sum + estimateBlockTokens(block),
    0,
  );
  return contentTokens + MESSAGE_OVERHEAD_TOKENS;
}

/**
 * Token cost of the tool definitions block — tools are serialized into
 * the request as JSON schemas which can be surprisingly heavy when tools
 * have rich descriptions.
 */
export function estimateToolsTokens(tools: readonly LLMToolDefinition[] | undefined): number {
  if (!tools || tools.length === 0) return 0;
  // JSON.stringify gives a faithful upper bound on what's sent to the LLM
  // (the actual provider may strip some metadata but never add).
  return estimateTokens(JSON.stringify(tools));
}

/**
 * Total tokens that will be sent in the request prompt — system prompt,
 * all messages with their structural overhead, and tool definitions.
 * Does NOT include `max_tokens` (the response budget); callers compare
 * against context_window separately for that.
 */
export function estimatePromptTokens(
  systemPrompt: string,
  messages: readonly LLMMessage[],
  tools?: readonly LLMToolDefinition[],
): number {
  const sys = estimateTokens(systemPrompt);
  const msgs = messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
  const toolsT = estimateToolsTokens(tools);
  return sys + msgs + toolsT;
}

export interface BudgetVerdict {
  /** Estimated tokens for the prompt as it stands. */
  promptTokens: number;
  /** Model's advertised context window. */
  contextWindow: number;
  /** Threshold above which compaction should fire (= contextWindow * 0.80). */
  threshold: number;
  /** True when promptTokens ≥ threshold. */
  shouldCompact: boolean;
  /**
   * Safe `max_tokens` value for the response: leaves at least 256 tokens
   * of headroom against the context window. Clamped to ≥ 256 so we never
   * tell the LLM to produce nothing — if the prompt has already saturated
   * the window, the caller should compact rather than send a degenerate
   * request.
   *
   * Special case: when the agent's requestedMaxTokens is 0 ("let the model
   * decide"), this is passed through as 0 — providers then omit the cap
   * entirely (or use their unlimited sentinel) and the model stops on its
   * own EOS / the server's context ceiling. Compaction still applies, so
   * the prompt itself can never overflow even in this mode.
   */
  safeMaxTokens: number;
}

/**
 * Decide whether to compact and how to cap `max_tokens`. Pure function —
 * no I/O, safe to call on every turn.
 */
export function budgetVerdict(
  systemPrompt: string,
  messages: readonly LLMMessage[],
  tools: readonly LLMToolDefinition[] | undefined,
  requestedMaxTokens: number,
  contextWindow: number,
): BudgetVerdict {
  const promptTokens = estimatePromptTokens(systemPrompt, messages, tools);
  const threshold = Math.floor(contextWindow * COMPACTION_THRESHOLD);
  const shouldCompact = promptTokens >= threshold;
  const availableForResponse = Math.max(
    256,
    contextWindow - promptTokens - TOKEN_SAFETY_MARGIN,
  );
  // 0 is the "let the model decide" sentinel: the agent has opted out of an
  // explicit response cap. Pass it through untouched so providers omit
  // max_tokens (or use their unlimited sentinel). shouldCompact above still
  // guards the prompt side, so this can't cause a context overflow.
  const safeMaxTokens =
    requestedMaxTokens === 0
      ? 0
      : Math.max(256, Math.min(requestedMaxTokens, availableForResponse));
  return { promptTokens, contextWindow, threshold, shouldCompact, safeMaxTokens };
}
