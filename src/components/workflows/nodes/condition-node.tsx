import { Handle, Position } from "@xyflow/react";
import type { WorkflowStep, StepRunStatus } from "@/types";

interface Props {
  data: { step: WorkflowStep; isSelected: boolean; status?: StepRunStatus };
}

export function ConditionNode({ data }: Props) {
  return (
    <div className={`rounded-lg border-2 px-4 py-3 min-w-[180px] bg-amber-50 dark:bg-amber-950/30 ${data.isSelected ? "border-primary" : "border-amber-300 dark:border-amber-700"}`}>
      <Handle type="target" position={Position.Top} className="!bg-amber-500" />
      <div className="flex items-center justify-center gap-2">
        <svg className="h-4 w-4 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9 5.25h.008v.008H12v-.008z" />
        </svg>
        <span className="text-sm font-medium text-center">{data.step.name}</span>
      </div>
      <Handle type="source" position={Position.Bottom} id="true" className="!bg-green-500 !left-[30%]" />
      <Handle type="source" position={Position.Bottom} id="false" className="!bg-red-500 !left-[70%]" />
    </div>
  );
}
