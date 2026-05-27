import { Handle, Position } from "@xyflow/react";
import type { WorkflowStep, StepRunStatus } from "@/types";

interface Props {
  data: { step: WorkflowStep; isSelected: boolean; status?: StepRunStatus };
}

export function SubWorkflowNode({ data }: Props) {
  return (
    <div className={`rounded-lg border-2 px-4 py-3 min-w-[180px] bg-slate-50 dark:bg-slate-950/30 ${data.isSelected ? "border-primary" : "border-slate-300 dark:border-slate-700"}`}>
      <Handle type="target" position={Position.Top} className="!bg-slate-500" />
      <div className="flex items-center justify-center gap-2">
        <svg className="h-4 w-4 text-slate-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
        </svg>
        <span className="text-sm font-medium text-center">{data.step.name}</span>
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-slate-500" />
    </div>
  );
}
