import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import type { WorkflowVariable } from "@/types";

interface VariablesPanelProps {
  variables: WorkflowVariable[];
  onChange: (variables: WorkflowVariable[]) => void;
}

export function VariablesPanel({ variables, onChange }: VariablesPanelProps) {
  function addVariable() {
    onChange([...variables, { name: "", type: "string", defaultValue: "", description: "" }]);
  }

  function removeVariable(idx: number) {
    onChange(variables.filter((_, i) => i !== idx));
  }

  function updateVariable(idx: number, updates: Partial<WorkflowVariable>) {
    onChange(variables.map((v, i) => i === idx ? { ...v, ...updates } : v));
  }

  return (
    <div className="flex flex-col gap-3 p-4">
      <h3 className="text-sm font-medium text-center">Variables</h3>

      {variables.map((v, idx) => (
        <div key={idx} className="rounded-lg border border-border p-3 flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Input
              value={v.name}
              onChange={(e) => updateVariable(idx, { name: e.target.value })}
              placeholder="variableName"
              className="text-xs flex-1"
            />
            <select
              value={v.type}
              onChange={(e) => updateVariable(idx, { type: e.target.value as WorkflowVariable["type"] })}
              className="rounded-lg border border-border bg-background px-2 py-1 text-xs"
            >
              <option value="string">string</option>
              <option value="number">number</option>
              <option value="boolean">boolean</option>
              <option value="object">object</option>
              <option value="array">array</option>
            </select>
            <button onClick={() => removeVariable(idx)} className="text-xs text-destructive hover:underline">
              Remove
            </button>
          </div>
          <Input
            value={String(v.defaultValue ?? "")}
            onChange={(e) => updateVariable(idx, { defaultValue: e.target.value })}
            placeholder="Default value"
            className="text-xs"
          />
        </div>
      ))}

      <Button variant="ghost" size="sm" onClick={addVariable} className="self-center">
        + Add Variable
      </Button>
    </div>
  );
}
