import { useState } from "react";
import { cn } from "@/lib/utils";
import type { Message } from "@/types";

interface CompactionDividerProps {
  summaryMessage: Message;
  /** How many earlier messages were folded into this summary. */
  compactedCount: number;
}

/**
 * Rendered in the chat timeline at the position where compaction
 * happened. Collapsed by default: a thin horizontal rule with the
 * "🗜 N messages compacted" chip in the middle. Click to expand and
 * read the full summary text.
 *
 * The compacted original messages above this divider are still shown
 * (grayed via `compactedAt` styling on individual bubbles) so the user
 * can scroll back through their history — only the LLM is blind to them.
 */
export function CompactionDivider({ summaryMessage, compactedCount }: CompactionDividerProps) {
  const [expanded, setExpanded] = useState(false);

  const summaryText = summaryMessage.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");

  const docNames = summaryMessage.sources
    ?.filter((s) => s.type === "semantic")
    .map((s) => s.documentName)
    .filter((name, i, arr) => arr.indexOf(name) === i) ?? [];

  return (
    <div className="my-3">
      <div className="flex items-center gap-2 px-2">
        <div className="h-px flex-1 bg-border" />
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/30 px-3 py-0.5",
            "text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted/50",
            "transition-colors",
          )}
          aria-expanded={expanded}
          title="Earlier messages were summarized to keep the conversation within the model's context window"
        >
          <span aria-hidden="true">🗜</span>
          <span>
            {compactedCount} earlier message{compactedCount === 1 ? "" : "s"} compacted
          </span>
          <svg
            className={cn("h-3 w-3 transition-transform", expanded && "rotate-180")}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        <div className="h-px flex-1 bg-border" />
      </div>

      {expanded && (
        <div className="mx-auto mt-2 max-w-[85%] rounded-lg border border-border bg-card/40 px-3 py-2.5 text-[12.5px] text-foreground/80 leading-relaxed">
          <div className="mb-1.5 flex items-center justify-between text-[10.5px] uppercase tracking-wide text-muted-foreground/80">
            <span>Summary of earlier conversation</span>
            <span>{new Date(summaryMessage.createdAt).toLocaleString()}</span>
          </div>
          <p className="whitespace-pre-wrap">{summaryText}</p>
          {docNames.length > 0 && (
            <div className="mt-2 border-t border-border/40 pt-1.5 text-[11px] text-muted-foreground">
              Sources from earlier turns: {docNames.map((n) => `[${n}]`).join(", ")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
