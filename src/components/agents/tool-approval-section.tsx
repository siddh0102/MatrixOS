import { Select } from "@/components/ui/select";
import type { ApprovalConfig } from "@/types";
import type { Tool } from "@/types";

interface ToolApprovalSectionProps {
  approvalMode: ApprovalConfig["mode"];
  onModeChange: (mode: ApprovalConfig["mode"]) => void;
  perToolOverrides: Record<string, "auto" | "prompt" | "deny">;
  onOverrideChange: (key: string, value: "auto" | "prompt" | "deny" | null) => void;
  tools: Tool[];
}

export function ToolApprovalSection({
  approvalMode,
  onModeChange,
  perToolOverrides,
  onOverrideChange,
  tools,
}: ToolApprovalSectionProps) {
  return (
    <div className="flex flex-col gap-3">
      <label className="block text-sm text-muted-foreground">Tool Approval</label>

      <div className="flex gap-4">
        {(["always-ask", "auto-approve", "auto-reject"] as const).map((mode) => (
          <label key={mode} className="flex items-center gap-1.5 text-sm">
            <input
              type="radio"
              name="approval"
              checked={approvalMode === mode}
              onChange={() => onModeChange(mode)}
            />
            {mode.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ")}
          </label>
        ))}
      </div>

      {tools.length > 0 && (
        <div>
          <p className="text-xs text-muted-foreground mb-2">Per-Tool Overrides</p>
          <div className="rounded-lg border border-border divide-y divide-border">
            {tools.map((t) => {
              const key = `${t.serverId}:${t.name}`;
              const current = perToolOverrides[key] ?? "";
              return (
                <div key={key} className="flex items-center justify-between px-3 py-2">
                  <span className="text-xs font-mono text-muted-foreground">{key}</span>
                  <Select
                    value={current}
                    onChange={(e) => {
                      const val = e.target.value;
                      if (!val) {
                        onOverrideChange(key, null);
                      } else {
                        onOverrideChange(key, val as "auto" | "prompt" | "deny");
                      }
                    }}
                    className="w-28 text-xs"
                  >
                    <option value="">(default)</option>
                    <option value="auto">Auto</option>
                    <option value="prompt">Prompt</option>
                    <option value="deny">Deny</option>
                  </Select>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
