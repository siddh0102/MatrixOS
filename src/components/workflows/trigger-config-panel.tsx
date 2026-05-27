import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import type { WorkflowTrigger, TriggerType } from "@/types";
import { nanoid } from "nanoid";

interface TriggerConfigPanelProps {
  triggers: WorkflowTrigger[];
  onChange: (triggers: WorkflowTrigger[]) => void;
}

export function TriggerConfigPanel({ triggers, onChange }: TriggerConfigPanelProps) {
  const [addType, setAddType] = useState<TriggerType>("manual");

  function addTrigger() {
    const trigger: WorkflowTrigger = {
      id: nanoid(),
      type: addType,
      enabled: true,
      config: addType === "manual"
        ? { type: "manual" }
        : addType === "event"
          ? { type: "event", eventType: "", filter: undefined }
          : { type: "scheduled", cronExpression: "0 9 * * *", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    };
    onChange([...triggers, trigger]);
  }

  function removeTrigger(id: string) {
    onChange(triggers.filter((t) => t.id !== id));
  }

  function toggleTrigger(id: string) {
    onChange(triggers.map((t) => t.id === id ? { ...t, enabled: !t.enabled } : t));
  }

  function updateTriggerConfig(id: string, configUpdates: Record<string, unknown>) {
    onChange(triggers.map((t) => {
      if (t.id !== id) return t;
      return { ...t, config: { ...t.config, ...configUpdates } as any };
    }));
  }

  return (
    <div className="flex flex-col gap-3 p-4">
      <h3 className="text-sm font-medium text-center">Triggers</h3>

      {triggers.map((trigger) => (
        <div key={trigger.id} className="rounded-lg border border-border p-3 flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium capitalize text-center flex-1">{trigger.type}</span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => toggleTrigger(trigger.id)}
                className={`text-xs px-2 py-0.5 rounded ${trigger.enabled ? "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300" : "bg-muted text-muted-foreground"}`}
              >
                {trigger.enabled ? "On" : "Off"}
              </button>
              <button
                onClick={() => removeTrigger(trigger.id)}
                className="text-xs text-destructive hover:underline"
              >
                Remove
              </button>
            </div>
          </div>
          {trigger.config.type === "scheduled" && (
            <Input
              value={trigger.config.cronExpression}
              onChange={(e) => updateTriggerConfig(trigger.id, { cronExpression: e.target.value })}
              placeholder="0 9 * * *"
              className="text-xs font-mono"
            />
          )}
          {trigger.config.type === "event" && (
            <Input
              value={trigger.config.eventType}
              onChange={(e) => updateTriggerConfig(trigger.id, { eventType: e.target.value })}
              placeholder="conversation:message_added"
              className="text-xs font-mono"
            />
          )}
        </div>
      ))}

      <div className="flex items-center justify-center gap-2 mt-2">
        <select
          value={addType}
          onChange={(e) => setAddType(e.target.value as TriggerType)}
          className="rounded-lg border border-border bg-background px-2 py-1 text-xs"
        >
          <option value="manual">Manual</option>
          <option value="event">Event</option>
          <option value="scheduled">Scheduled</option>
        </select>
        <Button variant="ghost" size="sm" onClick={addTrigger}>+ Add</Button>
      </div>
    </div>
  );
}
