import { Input } from "@/components/ui/input";
import type { WorkflowStep, StepConfig, AgentTaskConfig, ConditionConfig, HumanInputConfig, TransformConfig, ToolCallConfig, SubWorkflowConfig, ErrorStrategy } from "@/types";
import { useAgentStore } from "@/stores/agent-store";

interface StepInspectorProps {
  step: WorkflowStep | null;
  onChange: (stepId: string, updates: Partial<WorkflowStep>) => void;
}

export function StepInspector({ step, onChange }: StepInspectorProps) {
  if (!step) {
    return (
      <div className="flex items-center justify-center p-4 text-sm text-muted-foreground">
        Select a node to configure
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 p-4 overflow-auto max-h-[300px]">
      <div>
        <label className="mb-1 block text-xs font-medium text-muted-foreground text-center">Step Name</label>
        <Input
          value={step.name}
          onChange={(e) => onChange(step.id, { name: e.target.value })}
        />
      </div>

      <div>
        <label className="mb-1 block text-xs font-medium text-muted-foreground text-center">Error Strategy</label>
        <select
          value={step.errorStrategy ?? "stop"}
          onChange={(e) => onChange(step.id, { errorStrategy: e.target.value as ErrorStrategy })}
          className="w-full rounded-lg border border-border bg-background px-3 py-1.5 text-sm"
        >
          <option value="stop">Stop workflow</option>
          <option value="skip">Skip and continue</option>
          <option value="fallback">Fallback</option>
        </select>
      </div>

      <div>
        <label className="mb-1 block text-xs font-medium text-muted-foreground text-center">Timeout (ms)</label>
        <Input
          type="number"
          value={step.timeoutMs ?? ""}
          onChange={(e) => onChange(step.id, { timeoutMs: e.target.value ? Number(e.target.value) : undefined })}
          placeholder="Default (workflow max)"
        />
      </div>

      <StepConfigEditor step={step} onChange={onChange} />
    </div>
  );
}

function StepConfigEditor({ step, onChange }: { step: WorkflowStep; onChange: (id: string, updates: Partial<WorkflowStep>) => void }) {
  const configs = useAgentStore((s) => s.configs);

  function updateConfig(updates: Partial<StepConfig>) {
    onChange(step.id, { config: { ...step.config, ...updates } as StepConfig });
  }

  switch (step.config.type) {
    case "agent_task": {
      const config = step.config as AgentTaskConfig;
      return (
        <>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground text-center">Agent</label>
            <select
              value={config.agentId}
              onChange={(e) => updateConfig({ agentId: e.target.value })}
              className="w-full rounded-lg border border-border bg-background px-3 py-1.5 text-sm"
            >
              <option value="">Select agent...</option>
              {configs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground text-center">Prompt</label>
            <textarea
              value={config.prompt}
              onChange={(e) => updateConfig({ prompt: e.target.value })}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm resize-none font-mono"
              rows={4}
              placeholder="Use ${stepId} to reference outputs"
            />
          </div>
        </>
      );
    }

    case "condition": {
      const config = step.config as ConditionConfig;
      return (
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground text-center">Expression</label>
          <Input
            value={config.expression}
            onChange={(e) => updateConfig({ expression: e.target.value })}
            placeholder="${step1.length} > 100"
            className="font-mono"
          />
        </div>
      );
    }

    case "human_input": {
      const config = step.config as HumanInputConfig;
      return (
        <>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground text-center">Prompt</label>
            <Input
              value={config.prompt}
              onChange={(e) => updateConfig({ prompt: e.target.value })}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground text-center">Input Type</label>
            <select
              value={config.inputType}
              onChange={(e) => updateConfig({ inputType: e.target.value as "text" | "choice" | "confirm" })}
              className="w-full rounded-lg border border-border bg-background px-3 py-1.5 text-sm"
            >
              <option value="text">Text</option>
              <option value="choice">Choice</option>
              <option value="confirm">Confirm</option>
            </select>
          </div>
        </>
      );
    }

    case "transform": {
      const config = step.config as TransformConfig;
      return (
        <>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground text-center">Expression</label>
            <textarea
              value={config.expression}
              onChange={(e) => updateConfig({ expression: e.target.value })}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm resize-none font-mono"
              rows={3}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground text-center">Output Variable</label>
            <Input
              value={config.outputVariable}
              onChange={(e) => updateConfig({ outputVariable: e.target.value })}
            />
          </div>
        </>
      );
    }

    case "tool_call": {
      const config = step.config as ToolCallConfig;
      return (
        <>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground text-center">Tool Name</label>
            <Input
              value={config.toolName}
              onChange={(e) => updateConfig({ toolName: e.target.value })}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground text-center">Server ID</label>
            <Input
              value={config.serverId}
              onChange={(e) => updateConfig({ serverId: e.target.value })}
            />
          </div>
        </>
      );
    }

    case "sub_workflow": {
      const config = step.config as SubWorkflowConfig;
      return (
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground text-center">Workflow ID</label>
          <Input
            value={config.workflowId}
            onChange={(e) => updateConfig({ workflowId: e.target.value })}
          />
        </div>
      );
    }

    default:
      return null;
  }
}
