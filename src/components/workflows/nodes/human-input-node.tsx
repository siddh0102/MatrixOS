import { Handle, Position } from "@xyflow/react";
import type { WorkflowStep, StepRunStatus } from "@/types";

interface Props {
  data: { step: WorkflowStep; isSelected: boolean; status?: StepRunStatus };
}

export function HumanInputNode({ data }: Props) {
  return (
    <div className={`rounded-lg border-2 px-4 py-3 min-w-[180px] bg-orange-50 dark:bg-orange-950/30 ${data.isSelected ? "border-primary" : "border-orange-300 dark:border-orange-700"}`}>
      <Handle type="target" position={Position.Top} className="!bg-orange-500" />
      <div className="flex items-center justify-center gap-2">
        <svg className="h-4 w-4 text-orange-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z" />
        </svg>
        <span className="text-sm font-medium text-center">{data.step.name}</span>
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-orange-500" />
    </div>
  );
}
