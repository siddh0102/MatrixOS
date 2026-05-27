import { useState } from "react";
import { cn } from "@/lib/utils";
import type { MessageSource } from "@/types";

interface SourcesBlockProps {
  sources: MessageSource[];
}

interface SourceGroup {
  documentId: string;
  documentName: string;
  chunks: MessageSource[];
}

/** Group flat MessageSource list by document, preserving order of first appearance. */
function groupByDocument(sources: MessageSource[]): SourceGroup[] {
  const order: string[] = [];
  const map = new Map<string, SourceGroup>();
  for (const s of sources) {
    let group = map.get(s.documentId);
    if (!group) {
      group = { documentId: s.documentId, documentName: s.documentName, chunks: [] };
      map.set(s.documentId, group);
      order.push(s.documentId);
    }
    group.chunks.push(s);
  }
  return order.map((id) => map.get(id)!).map((g) => ({
    ...g,
    // Within a document, show highest-score chunks first.
    chunks: [...g.chunks].sort((a, b) => b.score - a.score),
  }));
}

/**
 * Compact attribution UI rendered under assistant messages whose turn had
 * knowledge-base context injected. Collapsed by default — a single chip
 * shows the unique-document count; click expands to a per-document list
 * with chunk excerpts and similarity scores.
 *
 * N is intentionally the unique-document count rather than the chunk
 * count, because that matches how the LLM cites (`[filename]`) and is
 * what users actually want to verify ("did it look at the right book?").
 */
export function SourcesBlock({ sources }: SourcesBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const groups = groupByDocument(sources);
  const uniqueDocs = groups.length;

  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-0.5",
          "text-[11px] text-muted-foreground hover:text-foreground hover:bg-accent",
          "transition-colors",
        )}
        aria-expanded={expanded}
      >
        <span aria-hidden="true">🔍</span>
        <span>
          {uniqueDocs} source{uniqueDocs === 1 ? "" : "s"} used
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

      {expanded && (
        <div className="mt-2 space-y-3 rounded-lg border border-border bg-card/40 p-3 text-[12px]">
          {groups.map((g) => (
            <div key={g.documentId}>
              <div className="mb-1.5 font-medium text-foreground/90 break-all">
                {g.documentName}
                <span className="ml-1.5 text-muted-foreground/70">
                  · {g.chunks.length} chunk{g.chunks.length === 1 ? "" : "s"}
                </span>
              </div>
              <ul className="space-y-1.5">
                {g.chunks.map((c) => (
                  <li
                    key={c.chunkId}
                    className="rounded border border-border/60 bg-background/40 px-2 py-1.5"
                  >
                    <div className="mb-0.5 flex items-center gap-2 text-muted-foreground/70">
                      <span>chunk #{c.chunkIndex}</span>
                      <span>·</span>
                      <span>score {(c.score * 100).toFixed(0)}%</span>
                    </div>
                    <p className="whitespace-pre-wrap text-foreground/75 leading-snug">
                      {c.excerpt}
                      {c.excerpt.length >= 200 && "…"}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
