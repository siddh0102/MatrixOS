import { Handle, Position } from "@xyflow/react";
import type { WorkflowStep, StepRunStatus } from "@/types";

interface Props {
  data: { step: WorkflowStep; isSelected: boolean; status?: StepRunStatus };
}

export function ToolCallNode({ data }: Props) {
  return (
    <div className={`rounded-lg border-2 px-4 py-3 min-w-[180px] bg-purple-50 dark:bg-purple-950/30 ${data.isSelected ? "border-primary" : "border-purple-300 dark:border-purple-700"}`}>
      <Handle type="target" position={Position.Top} className="!bg-purple-500" />
      <div className="flex items-center justify-center gap-2">
        <svg className="h-4 w-4 text-purple-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M11.42 15.17l-5.1-5.1m0 0l5.1-5.1m-5.1 5.1h14.88" />
        </svg>
        <span className="text-sm font-medium text-center">{data.step.name}</span>
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-purple-500" />
    </div>
  );
}
