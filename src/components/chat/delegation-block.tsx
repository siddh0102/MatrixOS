import { useState } from "react";

interface DelegationBlockProps {
  targetAgentName: string;
  task: string;
  response: string;
  isStreaming?: boolean;
}

export function DelegationBlock({ targetAgentName, task, response, isStreaming }: DelegationBlockProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="my-2 rounded-lg border border-border/60 bg-card/60 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border/40 bg-muted/20">
        <svg className="h-3.5 w-3.5 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
        </svg>
        <span className="text-xs font-medium text-muted-foreground">
          Delegated to: <span className="text-foreground">{targetAgentName}</span>
        </span>
        {isStreaming && (
          <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
            <span className="inline-flex gap-0.5">
              <span className="h-1 w-1 rounded-full bg-muted-foreground animate-bounce [animation-delay:0ms]" />
              <span className="h-1 w-1 rounded-full bg-muted-foreground animate-bounce [animation-delay:150ms]" />
              <span className="h-1 w-1 rounded-full bg-muted-foreground animate-bounce [animation-delay:300ms]" />
            </span>
          </span>
        )}
      </div>

      <div className="px-3 py-2">
        <p className="text-xs text-muted-foreground mb-2">
          <span className="font-medium">Task:</span> {task.length > 100 ? task.slice(0, 100) + "…" : task}
        </p>
        {response && (
          <>
            <button
              onClick={() => setExpanded((e) => !e)}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <svg
                className={`h-3 w-3 transition-transform ${expanded ? "rotate-90" : ""}`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
              {expanded ? "Hide response" : "Show response"}
            </button>
            {expanded && (
              <pre className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-foreground/80 font-sans">
                {response}
              </pre>
            )}
          </>
        )}
      </div>
    </div>
  );
}
