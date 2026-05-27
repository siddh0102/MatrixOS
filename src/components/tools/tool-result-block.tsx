import { useState } from "react";
import { cn } from "@/lib/utils";

interface ToolResultBlockProps {
  toolCallId: string;
  toolName?: string;
  result: string;
  isError: boolean;
  durationMs?: number | null;
}

export function ToolResultBlock({
  toolName,
  result,
  isError,
  durationMs,
}: ToolResultBlockProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className={cn(
        "my-1 rounded-lg border px-3 py-2 text-sm",
        isError
          ? "border-red-500/30 bg-red-500/5"
          : "border-green-500/30 bg-green-500/5",
      )}
    >
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 text-left"
      >
        <span className={cn("text-xs", isError ? "text-red-500" : "text-green-500")}>
          {isError ? "✗" : "✓"}
        </span>
        <span className="font-medium text-foreground">
          {toolName ?? "Tool Result"}
        </span>
        {durationMs != null && (
          <span className="text-xs text-muted-foreground">
            {durationMs}ms
          </span>
        )}
        <span className="ml-auto text-xs text-muted-foreground">
          {expanded ? "▲" : "▼"}
        </span>
      </button>
      {expanded && (
        <pre className="mt-2 max-h-40 overflow-auto rounded bg-background p-2 text-xs">
          {result}
        </pre>
      )}
    </div>
  );
}
