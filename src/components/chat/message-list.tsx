import { useEffect, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useTabStore } from "@/stores/tab-store";
import type { Message } from "@/types";
import type { StreamingToolCall } from "@/stores/conversation-store";
import { MessageBubble } from "./message-bubble";
import { MarkdownMessage } from "./markdown-message";
import { ThinkingBlock } from "./thinking-block";
import { ToolCallBlock } from "@/components/tools/tool-call-block";
import { CompactionDivider } from "./compaction-divider";

const EMPTY_MESSAGES: Message[] = [];
const EMPTY_TOOL_CALLS: StreamingToolCall[] = [];

function TypingDots() {
  return (
    <div className="flex w-full justify-start animate-fade-in">
      <div className="max-w-[80%] rounded-2xl rounded-bl-md border border-border/60 bg-card px-4 py-3">
        <div className="flex gap-1.5">
          <span className="h-2 w-2 animate-bounce rounded-full bg-muted-foreground/40 [animation-delay:0ms]" />
          <span className="h-2 w-2 animate-bounce rounded-full bg-muted-foreground/40 [animation-delay:150ms]" />
          <span className="h-2 w-2 animate-bounce rounded-full bg-muted-foreground/40 [animation-delay:300ms]" />
        </div>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 px-8">
      <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-muted">
        <svg className="h-5 w-5 text-muted-foreground/60" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
        </svg>
      </div>
      <div className="text-center max-w-xs">
        <p className="text-sm text-muted-foreground/60 leading-relaxed">
          Send a message to start the conversation
        </p>
      </div>
    </div>
  );
}

export function MessageList() {
  const messages = useTabStore(
    (s) => s.tabStates[s.activeTabId ?? ""]?.messages ?? EMPTY_MESSAGES,
  );
  const streamingText = useTabStore(
    (s) => s.tabStates[s.activeTabId ?? ""]?.streamingText ?? "",
  );
  const streamingThinking = useTabStore(
    (s) => s.tabStates[s.activeTabId ?? ""]?.streamingThinking ?? "",
  );
  const isThinking = useTabStore(
    (s) => s.tabStates[s.activeTabId ?? ""]?.isThinking ?? false,
  );
  const streamingToolCalls = useTabStore(
    (s) => s.tabStates[s.activeTabId ?? ""]?.streamingToolCalls ?? EMPTY_TOOL_CALLS,
  );
  const isStreaming = useTabStore(
    (s) => s.tabStates[s.activeTabId ?? ""]?.isStreaming ?? false,
  );

  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 120,
    overscan: 5,
  });

  useEffect(() => {
    if (messages.length > 0) {
      virtualizer.scrollToIndex(messages.length - 1, { align: "end" });
    }
  }, [messages.length]);

  useEffect(() => {
    if (isStreaming && messages.length > 0) {
      virtualizer.scrollToIndex(messages.length - 1, { align: "end" });
    }
  }, [streamingText, streamingToolCalls]);

  if (messages.length === 0 && !isStreaming) {
    return <EmptyState />;
  }

  const hasStreamingContent =
    streamingText ||
    streamingThinking ||
    isThinking ||
    (streamingToolCalls && streamingToolCalls.length > 0);

  return (
    <div ref={parentRef} className="flex-1 overflow-y-auto overflow-x-hidden px-5 py-4">
      <div
        style={{ height: virtualizer.getTotalSize(), position: "relative" }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const msg = messages[virtualRow.index];
          // A compaction summary row is rendered as the divider; the
          // count it displays is "how many rows just above me have a
          // compactedAt timestamp" — those are the ones it folded.
          if (msg.isSummary) {
            let count = 0;
            for (let i = virtualRow.index - 1; i >= 0; i--) {
              const prev = messages[i];
              if (prev.compactedAt) count++;
              else break;
            }
            return (
              <div
                key={msg.id}
                ref={virtualizer.measureElement}
                data-index={virtualRow.index}
                style={{
                  position: "absolute",
                  top: virtualRow.start,
                  width: "100%",
                  paddingBottom: "12px",
                }}
              >
                <CompactionDivider summaryMessage={msg} compactedCount={count} />
              </div>
            );
          }
          return (
            <div
              key={msg.id}
              ref={virtualizer.measureElement}
              data-index={virtualRow.index}
              style={{
                position: "absolute",
                top: virtualRow.start,
                width: "100%",
                paddingBottom: "12px",
              }}
              // Compacted-out original messages are still rendered but
              // visually muted to signal "the agent no longer sees this
              // in context — it now lives in the summary above".
              className={msg.compactedAt ? "opacity-50" : undefined}
            >
              <MessageBubble message={msg} />
            </div>
          );
        })}
      </div>

      {isStreaming && hasStreamingContent && (
        <div className="flex w-full justify-start animate-fade-in">
          <div className="box-border max-w-[85%] min-w-0 space-y-1">
            {(isThinking || streamingThinking) && (
              <ThinkingBlock text={streamingThinking} isStreaming={isThinking} />
            )}
            {streamingText && (
              <div className="rounded-2xl rounded-bl-md border border-border/60 bg-card px-5 py-3 text-[15px] text-card-foreground shadow-sm overflow-hidden">
                <div className="min-w-0 max-w-full [overflow-wrap:anywhere]">
                  <MarkdownMessage text={streamingText} />
                  <span className="ml-0.5 inline-block h-4 w-[2.5px] animate-pulse bg-primary align-text-bottom" />
                </div>
              </div>
            )}
            {streamingToolCalls?.map((tc) => (
              <ToolCallBlock
                key={tc.id}
                toolCallId={tc.id}
                toolName={tc.name}
                args={tc.args ?? {}}
                isStreaming={tc.streaming}
              />
            ))}
          </div>
        </div>
      )}

      {isStreaming && !hasStreamingContent && <TypingDots />}
    </div>
  );
}
