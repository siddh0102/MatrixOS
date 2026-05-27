import { useState } from "react";
import { cn } from "@/lib/utils";

interface ToolCallBlockProps {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  isStreaming?: boolean;
}

export function ToolCallBlock({
  toolName,
  args,
  isStreaming = false,
}: ToolCallBlockProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="my-1 rounded-lg border border-border/60 bg-card/50 px-3 py-2 text-sm">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 text-left"
      >
        <span
          className={cn(
            "inline-block h-2 w-2 rounded-full",
            isStreaming ? "animate-pulse bg-yellow-500" : "bg-primary",
          )}
        />
        <span className="font-medium text-foreground">
          {isStreaming ? `Calling ${toolName}...` : toolName}
        </span>
        <span className="ml-auto text-xs text-muted-foreground">
          {expanded ? "▲" : "▼"}
        </span>
      </button>
      {expanded && (
        <pre className="mt-2 max-h-40 overflow-auto rounded bg-background p-2 text-xs">
          {JSON.stringify(args, null, 2)}
        </pre>
      )}
    </div>
  );
}
