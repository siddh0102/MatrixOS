import { Handle, Position } from "@xyflow/react";

interface Props {
  data: { name: string; delegatedBy: string };
}

/**
 * Read-only node representing an agent reached via delegation (the
 * orchestrator's `delegationConfig.allowedAgentIds`), not a formal workflow
 * step. Rendered as a ghost (dashed, muted, non-interactive) so the graph
 * shows the full set of agents that participate in the run without implying
 * these are editable/deletable steps.
 */
export function DelegatedAgentNode({ data }: Props) {
  return (
    <div className="rounded-lg border-2 border-dashed border-purple-300 dark:border-purple-700 bg-purple-50/60 dark:bg-purple-950/20 px-3 py-2 min-w-[160px] opacity-90">
      <Handle type="target" position={Position.Top} className="!bg-purple-400" isConnectable={false} />
      <div className="flex items-center justify-center gap-2">
        <svg className="h-4 w-4 text-purple-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
        </svg>
        <span className="text-sm font-medium text-center">{data.name}</span>
      </div>
      <p className="mt-0.5 text-[10px] uppercase tracking-wide text-purple-500/80 text-center">
        delegated
      </p>
    </div>
  );
}
