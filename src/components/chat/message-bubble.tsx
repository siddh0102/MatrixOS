import { useState } from "react";
import { cn } from "@/lib/utils";
import { ToolCallBlock } from "@/components/tools/tool-call-block";
import { ToolResultBlock } from "@/components/tools/tool-result-block";
import { CallReplayDialog } from "@/components/dashboard/call-replay-dialog";
import { ThinkingBlock } from "./thinking-block";
import { MarkdownMessage } from "./markdown-message";
import { DelegationBlock } from "./delegation-block";
import { ImageViewerDialog } from "./image-viewer-dialog";
import { SourcesBlock } from "./sources-block";
import type { Message, ImageContent } from "@/types";

interface MessageBubbleProps {
  message: Message;
  streamingThinking?: string;
  isThinking?: boolean;
}

function UserAvatar() {
  return (
    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-[#ffb347]/15 border border-[#ffb347]/30 shadow-[0_0_8px_rgba(255,179,71,0.2)]">
      <svg className="h-4 w-4 text-[#ffb347]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
      </svg>
    </div>
  );
}

function AssistantAvatar() {
  return (
    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-primary/10 border border-primary/30 shadow-[0_0_8px_rgba(79,195,247,0.2)]">
      <svg className="h-4 w-4 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 002 2z" />
      </svg>
    </div>
  );
}

interface ContextMenuState {
  x: number;
  y: number;
}

export function MessageBubble({ message, streamingThinking, isThinking }: MessageBubbleProps) {
  const isUser = message.role === "user";
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [replayRequestId, setReplayRequestId] = useState<string | null>(null);
  const [viewingImage, setViewingImage] = useState<ImageContent | null>(null);

  const hasToolResults = message.content.some((c) => c.type === "tool_result");
  if (isUser && hasToolResults) {
    return (
      <div className="flex w-full justify-start animate-fade-in">
        <div className="max-w-[85%] space-y-1">
          {message.content.map((block, i) => {
            if (block.type === "tool_result") {
              return (
                <ToolResultBlock
                  key={`${block.toolCallId}-${i}`}
                  toolCallId={block.toolCallId}
                  result={block.result}
                  isError={block.isError}
                />
              );
            }
            return null;
          })}
        </div>
      </div>
    );
  }

  const textParts = message.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");

  const imageParts = message.content.filter(
    (c): c is ImageContent => c.type === "image",
  );

  const thinkingBlocks = message.content.filter(
    (c): c is { type: "thinking"; text: string; durationMs?: number } => c.type === "thinking",
  );

  const toolCallBlocks = message.content.filter(
    (c): c is { type: "tool_call"; toolCallId: string; toolName: string; arguments: Record<string, unknown> } =>
      c.type === "tool_call",
  );

  const delegationCalls = toolCallBlocks.filter((tc) => tc.toolName === "delegate_to_agent");
  const normalToolCalls = toolCallBlocks.filter((tc) => tc.toolName !== "delegate_to_agent");

  const canInspect = !isUser && !!message.telemetryId;

  function handleContextMenu(e: React.MouseEvent) {
    if (!canInspect) return;
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
  }

  return (
    <>
      <div
        className={cn(
          "flex w-full gap-3 animate-fade-in",
          isUser ? "justify-end" : "justify-start",
        )}
        onContextMenu={handleContextMenu}
      >
        {!isUser && <AssistantAvatar />}
        <div className="max-w-[85%] space-y-1">
          {/* Streaming thinking (from live stream) */}
          {isThinking && streamingThinking !== undefined && (
            <ThinkingBlock text={streamingThinking} isStreaming />
          )}

          {/* Persisted thinking blocks */}
          {thinkingBlocks.map((tb, i) => (
            <ThinkingBlock key={i} text={tb.text} durationMs={tb.durationMs} />
          ))}

          {/* Images in user messages */}
          {imageParts.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {imageParts.map((img, i) => (
                <img
                  key={i}
                  src={`data:${img.mimeType};base64,${img.base64}`}
                  alt={img.altText ?? `Image ${i + 1}`}
                  className="max-w-[200px] max-h-[200px] rounded-lg border border-border object-cover cursor-pointer hover:opacity-90 transition-opacity"
                  onClick={() => setViewingImage(img)}
                />
              ))}
            </div>
          )}

          {textParts && (
            <div
              className={cn(
                "w-fit px-2 py-1 text-[15px] leading-relaxed",
                isUser
                  ? "bg-[#ffb347]/10 text-[#ffcc80] border border-[#ffb347]/30 rounded-2xl rounded-br-md shadow-[0_0_8px_rgba(255,179,71,0.1)]"
                  : "bg-primary/5 text-[#b3e5fc] border border-primary/15 rounded-2xl rounded-bl-md shadow-[0_0_8px_rgba(79,195,247,0.05)]",
              )}
            >
              {isUser ? (
                // User text is shown verbatim — render exactly what they
                // typed, including any literal markdown characters.
                <p className="whitespace-pre-wrap break-words leading-relaxed">
                  {textParts}
                </p>
              ) : (
                // Assistant output is markdown (headings, lists, code, tables).
                <MarkdownMessage text={textParts} />
              )}
            </div>
          )}

          {!isUser && message.sources && message.sources.length > 0 && (
            <SourcesBlock sources={message.sources} />
          )}

          {/* Delegation blocks */}
          {delegationCalls.map((tc) => {
            const args = tc.arguments as { agentId?: string; task?: string; context?: string };
            const toolResult = message.content.find(
              (c) => c.type === "tool_result" && c.toolCallId === tc.toolCallId,
            );
            return (
              <DelegationBlock
                key={tc.toolCallId}
                targetAgentName={args.agentId ?? "Agent"}
                task={args.task ?? ""}
                response={toolResult && toolResult.type === "tool_result" ? toolResult.result : ""}
              />
            );
          })}

          {/* Normal tool calls */}
          {normalToolCalls.map((tc) => (
            <ToolCallBlock
              key={tc.toolCallId}
              toolCallId={tc.toolCallId}
              toolName={tc.toolName}
              args={tc.arguments}
            />
          ))}
        </div>
        {isUser && <UserAvatar />}
      </div>

      {contextMenu && canInspect && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setContextMenu(null)}
          />
          <ul
            className="fixed z-50 rounded-lg border border-border bg-card py-1 shadow-lg text-sm"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            <li>
              <button
                onClick={() => {
                  setContextMenu(null);
                  setReplayRequestId(message.telemetryId!);
                }}
                className="w-full px-3 py-1.5 text-left hover:bg-accent transition-colors"
              >
                Inspect call
              </button>
            </li>
          </ul>
        </>
      )}

      {replayRequestId && (
        <CallReplayDialog
          requestId={replayRequestId}
          onClose={() => setReplayRequestId(null)}
        />
      )}

      <ImageViewerDialog image={viewingImage} onClose={() => setViewingImage(null)} />
    </>
  );
}
