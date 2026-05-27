import { Handle, Position } from "@xyflow/react";
import type { WorkflowStep, StepRunStatus } from "@/types";

interface Props {
  data: { step: WorkflowStep; isSelected: boolean; status?: StepRunStatus };
}

export function TransformNode({ data }: Props) {
  return (
    <div className={`rounded-lg border-2 px-4 py-3 min-w-[180px] bg-green-50 dark:bg-green-950/30 ${data.isSelected ? "border-primary" : "border-green-300 dark:border-green-700"}`}>
      <Handle type="target" position={Position.Top} className="!bg-green-500" />
      <div className="flex items-center justify-center gap-2">
        <svg className="h-4 w-4 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5" />
        </svg>
        <span className="text-sm font-medium text-center">{data.step.name}</span>
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-green-500" />
    </div>
  );
}
