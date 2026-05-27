import { Handle, Position } from "@xyflow/react";
import type { WorkflowStep, StepRunStatus } from "@/types";

interface Props {
  data: { step: WorkflowStep; isSelected: boolean; status?: StepRunStatus };
}

export function AgentTaskNode({ data }: Props) {
  return (
    <div className={`rounded-lg border-2 px-4 py-3 min-w-[180px] bg-blue-50 dark:bg-blue-950/30 ${data.isSelected ? "border-primary" : "border-blue-300 dark:border-blue-700"} ${statusBorder(data.status)}`}>
      <Handle type="target" position={Position.Top} className="!bg-blue-500" />
      <div className="flex items-center justify-center gap-2">
        <svg className="h-4 w-4 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0" />
        </svg>
        <span className="text-sm font-medium text-center">{data.step.name}</span>
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-blue-500" />
    </div>
  );
}

function statusBorder(status?: StepRunStatus): string {
  if (!status) return "";
  if (status === "completed") return "ring-2 ring-green-400";
  if (status === "failed") return "ring-2 ring-red-400";
  if (status === "running") return "ring-2 ring-yellow-400 animate-pulse";
  return "";
}
