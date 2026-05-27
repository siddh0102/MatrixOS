import { useState, useEffect } from "react";
import type { AgentConfig, ScheduledJob } from "@/types";
import { isValidCron, describeCron } from "@/scheduling/scheduler";
import { useAgentStore } from "@/stores/agent-store";
import { useConversationStore } from "@/stores/conversation-store";

const COMMON_TIMEZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Asia/Kolkata",
  "Asia/Tokyo",
  "Asia/Shanghai",
  "Australia/Sydney",
];

const PRESETS = [
  { label: "Every minute", value: "* * * * *" },
  { label: "Every 30 minutes", value: "*/30 * * * *" },
  { label: "Every hour", value: "0 * * * *" },
  { label: "Every day at 9am", value: "0 9 * * *" },
  { label: "Every Monday at 8am", value: "0 8 * * 1" },
];

interface CreateJobParams {
  agentId: string;
  cronExpression: string;
  timezone: string;
  prompt: string;
  targetConversationId: string | null;
}

interface ScheduleEditorDialogProps {
  open: boolean;
  onClose: () => void;
  job: ScheduledJob | null;
  onSave: (params: CreateJobParams) => Promise<void>;
}

export function ScheduleEditorDialog({ open, onClose, job, onSave }: ScheduleEditorDialogProps) {
  const configs = useAgentStore((s) => s.configs);
  const conversations = useConversationStore((s) => s.conversations);

  const defaultTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const [agentId, setAgentId] = useState(configs[0]?.id ?? "");
  const [cron, setCron] = useState("0 9 * * *");
  const [timezone, setTimezone] = useState(defaultTz);
  const [prompt, setPrompt] = useState("");
  const [targetConvId, setTargetConvId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (job) {
      setAgentId(job.agentId);
      setCron(job.cronExpression);
      setTimezone(job.timezone);
      setPrompt(job.prompt);
      setTargetConvId(job.targetConversationId);
    } else {
      setAgentId(configs[0]?.id ?? "");
      setCron("0 9 * * *");
      setTimezone(defaultTz);
      setPrompt("");
      setTargetConvId(null);
    }
  }, [open, job]);

  if (!open) return null;

  const cronValid = isValidCron(cron);
  const description = cronValid ? describeCron(cron) : "Invalid expression";

  async function handleSave() {
    if (!cronValid || !prompt.trim() || !agentId) return;
    setSaving(true);
    try {
      await onSave({ agentId, cronExpression: cron, timezone, prompt: prompt.trim(), targetConversationId: targetConvId });
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-xl border border-border bg-card shadow-xl p-6 space-y-4">
        <h2 className="text-base font-semibold">{job ? "Edit Schedule" : "Create Schedule"}</h2>

        <div className="space-y-1">
          <label className="text-sm font-medium">Agent</label>
          <select
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
          >
            {configs.map((c: AgentConfig) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">Cron expression</label>
          <div className="flex flex-wrap gap-1">
            {PRESETS.map((p) => (
              <button
                key={p.value}
                type="button"
                onClick={() => setCron(p.value)}
                className={`rounded-full px-2.5 py-0.5 text-xs border transition-colors ${
                  cron === p.value
                    ? "bg-primary text-primary-foreground border-primary"
                    : "border-border hover:bg-muted"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
          <input
            type="text"
            value={cron}
            onChange={(e) => setCron(e.target.value)}
            placeholder="0 9 * * *"
            className={`w-full rounded-lg border bg-background px-3 py-2 text-sm font-mono ${
              cronValid ? "border-input" : "border-destructive"
            }`}
          />
          <p className={`text-xs ${cronValid ? "text-muted-foreground" : "text-destructive"}`}>
            {description}
          </p>
        </div>

        <div className="space-y-1">
          <label className="text-sm font-medium">Timezone</label>
          <select
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
          >
            {COMMON_TIMEZONES.includes(defaultTz)
              ? COMMON_TIMEZONES.map((tz) => <option key={tz} value={tz}>{tz}</option>)
              : [defaultTz, ...COMMON_TIMEZONES].map((tz) => <option key={tz} value={tz}>{tz}</option>)
            }
          </select>
        </div>

        <div className="space-y-1">
          <label className="text-sm font-medium">Prompt</label>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={3}
            placeholder="What should the agent do when this runs?"
            className="w-full resize-none rounded-lg border border-input bg-background px-3 py-2 text-sm"
          />
        </div>

        <div className="space-y-1">
          <label className="text-sm font-medium">Target conversation</label>
          <select
            value={targetConvId ?? ""}
            onChange={(e) => setTargetConvId(e.target.value || null)}
            className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
          >
            <option value="">Create new each time</option>
            {conversations.map((c) => (
              <option key={c.id} value={c.id}>{c.title}</option>
            ))}
          </select>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-sm border border-border hover:bg-muted transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !cronValid || !prompt.trim() || !agentId}
            className="rounded-lg px-4 py-2 text-sm bg-primary text-primary-foreground disabled:opacity-50 disabled:pointer-events-none hover:bg-primary-hover transition-colors"
          >
            {saving ? "Saving…" : job ? "Save" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
