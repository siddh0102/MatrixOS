export interface Conversation {
  readonly id: string;
  readonly agentId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export type MessageContent =
  | TextContent
  | ImageContent
  | ThinkingContent
  | ToolCallContent
  | ToolResultContent
  | ErrorContent;

export interface TextContent {
  readonly type: "text";
  readonly text: string;
}

export interface ImageContent {
  readonly type: "image";
  readonly mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  readonly base64: string;
  readonly altText?: string;
  readonly widthPx?: number;
  readonly heightPx?: number;
}

export interface ThinkingContent {
  readonly type: "thinking";
  readonly text: string;
  readonly durationMs?: number;
}

export interface ToolCallContent {
  readonly type: "tool_call";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly arguments: Record<string, unknown>;
}

export interface ToolResultContent {
  readonly type: "tool_result";
  readonly toolCallId: string;
  readonly result: string;
  readonly isError: boolean;
}

export interface ErrorContent {
  readonly type: "error";
  readonly message: string;
  readonly code: string;
}

export interface Message {
  readonly id: string;
  readonly conversationId: string;
  readonly role: "user" | "assistant" | "system";
  readonly content: MessageContent[];
  readonly tokenCount: number | null;
  readonly model: string | null;
  readonly telemetryId: string | null;
  readonly createdAt: string;
  /**
   * Retrieved source chunks that were injected into the LLM prompt for
   * this turn. Set only on assistant messages where memory retrieval ran
   * AND returned at least one semantic match. Surfaced in the chat UI as
   * the "🔍 N sources used" badge. Persisted in `messages.sources_json`.
   */
  readonly sources?: import("./memory").MessageSource[];
  /**
   * True on the synthetic system-role row that holds the active
   * compaction summary. At most one such row per conversation. Persisted
   * as `messages.is_summary` (migration 018).
   */
  readonly isSummary?: boolean;
  /**
   * ISO timestamp when this message was folded into a summary.
   * Compacted messages stay on disk so the chat UI can still render
   * them (grayed out), but `getMessages` filters them out of the LLM
   * history. Persisted as `messages.compacted_at` (migration 018).
   */
  readonly compactedAt?: string | null;
}
