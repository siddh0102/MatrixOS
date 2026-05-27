import { useState } from "react";
import { cn } from "@/lib/utils";

interface ThinkingBlockProps {
  text: string;
  durationMs?: number;
  isStreaming?: boolean;
}

export function ThinkingBlock({ text, durationMs, isStreaming }: ThinkingBlockProps) {
  const [expanded, setExpanded] = useState(!!isStreaming);

  const duration = durationMs !== undefined
    ? `${(durationMs / 1000).toFixed(1)}s`
    : null;

  return (
    <div className="my-2 rounded-lg border border-border/50 bg-muted/20 overflow-hidden">
      <button
        onClick={() => setExpanded((e) => !e)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-muted-foreground hover:bg-muted/30 transition-colors"
      >
        {isStreaming ? (
          <span className="flex items-center gap-1">
            <span className="inline-flex gap-0.5">
              <span className="h-1 w-1 rounded-full bg-muted-foreground animate-bounce [animation-delay:0ms]" />
              <span className="h-1 w-1 rounded-full bg-muted-foreground animate-bounce [animation-delay:150ms]" />
              <span className="h-1 w-1 rounded-full bg-muted-foreground animate-bounce [animation-delay:300ms]" />
            </span>
            Thinking...
          </span>
        ) : (
          <span>
            {duration ? `Thought for ${duration}` : "Thinking"}
          </span>
        )}
        <svg
          className={cn("ml-auto h-3 w-3 transition-transform", expanded && "rotate-180")}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {expanded && (
        <div className="border-t border-border/30 px-3 py-2">
          <pre className="whitespace-pre-wrap text-xs italic leading-relaxed text-muted-foreground/80 font-mono">
            {text}
          </pre>
        </div>
      )}
    </div>
  );
}
