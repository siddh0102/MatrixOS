import { useState } from "react";
import type { SandboxConfig } from "@/types";

interface SandboxSectionProps {
  sandbox: SandboxConfig;
  onChange: (config: SandboxConfig) => void;
}

export function SandboxSection({ sandbox, onChange }: SandboxSectionProps) {
  const [newPath, setNewPath] = useState("");

  function addPath() {
    const trimmed = newPath.trim();
    if (!trimmed || sandbox.allowedPaths.includes(trimmed)) return;
    onChange({ ...sandbox, allowedPaths: [...sandbox.allowedPaths, trimmed] });
    setNewPath("");
  }

  function removePath(path: string) {
    onChange({ ...sandbox, allowedPaths: sandbox.allowedPaths.filter((p: string) => p !== path) });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <label className="text-sm text-muted-foreground">
          Sandbox <span className="text-xs text-muted-foreground/60">(built-in tools only)</span>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={sandbox.enabled}
            onChange={(e) => onChange({ ...sandbox, enabled: e.target.checked })}
          />
          Enable directory restrictions
        </label>
      </div>

      {sandbox.enabled && (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">Allowed Directories</p>
          <div className="rounded-lg border border-border divide-y divide-border">
            {sandbox.allowedPaths.length === 0 ? (
              <p className="px-3 py-2 text-xs text-muted-foreground/60">
                No directories allowed — all paths blocked.
              </p>
            ) : (
              sandbox.allowedPaths.map((p: string) => (
                <div key={p} className="flex items-center justify-between px-3 py-2">
                  <span className="text-xs font-mono text-foreground">{p}</span>
                  <button
                    type="button"
                    onClick={() => removePath(p)}
                    className="text-xs text-muted-foreground hover:text-destructive"
                  >
                    ✕
                  </button>
                </div>
              ))
            )}
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              value={newPath}
              onChange={(e) => setNewPath(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addPath()}
              placeholder="C:\path\to\directory"
              className="flex-1 rounded-lg border border-border bg-background px-3 py-1.5 text-sm focus:border-primary focus:outline-none"
            />
            <button
              type="button"
              onClick={addPath}
              className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-accent transition-colors"
            >
              + Add
            </button>
          </div>
          <p className="text-xs text-muted-foreground/60">
            Note: MCP server tools run in their own processes and are not restricted by this sandbox.
          </p>
        </div>
      )}
    </div>
  );
}
