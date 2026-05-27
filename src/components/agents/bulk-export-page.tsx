import { useState, useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useAgent } from "@/hooks/use-agent";
import { Button } from "@/components/ui/button";
import { useUIStore } from "@/stores/ui-store";
import { exportAgentsToDisk, type ExportTarget } from "@/agents/exporters";

export function BulkExportPage() {
  const navigate = useNavigate();
  const { configs } = useAgent();
  const addToast = useUIStore((s) => s.addToast);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState<ExportTarget>("claude");
  const [busy, setBusy] = useState(false);
  const [lastResult, setLastResult] = useState<{ rootDir: string; fileCount: number; warnings: string[]; perAgent: Array<{ agentId: string; fileCount: number; error?: string }> } | null>(null);

  const allSelected = configs.length > 0 && selectedIds.size === configs.length;
  const selectedList = useMemo(
    () => configs.filter((c) => selectedIds.has(c.id)),
    [configs, selectedIds],
  );

  function toggle(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAll() {
    setSelectedIds(new Set(configs.map((c) => c.id)));
  }

  function selectNone() {
    setSelectedIds(new Set());
  }

  async function handleExport() {
    if (selectedIds.size === 0) {
      addToast({ type: "info", message: "Select at least one agent to export." });
      return;
    }
    setBusy(true);
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const title = target === "claude"
        ? "Choose folder to export Claude Code agents into"
        : target === "copilot"
          ? "Choose folder to export GitHub Copilot agents into"
          : "Choose folder to export Claude + Copilot agents into";
      const chosen = await open({ directory: true, multiple: false, title });
      if (typeof chosen !== "string") {
        setBusy(false);
        return;
      }

      const { registerUserPath } = await import("@/lib/user-paths");
      await registerUserPath(chosen);
      const result = await exportAgentsToDisk([...selectedIds], target, chosen);
      setLastResult({ rootDir: chosen, ...result });

      const successCount = result.perAgent.filter((p) => !p.error).length;
      const failCount = result.perAgent.length - successCount;
      const warnMsg = result.warnings.length > 0 ? `, ${result.warnings.length} warning${result.warnings.length === 1 ? "" : "s"}` : "";
      addToast({
        type: failCount > 0 ? "info" : "success",
        message: `Exported ${successCount} agent${successCount === 1 ? "" : "s"} (${result.fileCount} file${result.fileCount === 1 ? "" : "s"})${failCount > 0 ? `, ${failCount} failed` : ""}${warnMsg}`,
      });
    } catch (err) {
      addToast({ type: "error", message: err instanceof Error ? err.message : "Bulk export failed" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-1 flex-col overflow-auto p-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Bulk Export Agents</h1>
        <Button variant="ghost" onClick={() => navigate({ to: "/agents" })}>
          &larr; Back to Agents
        </Button>
      </div>

      <div className="flex max-w-3xl flex-col gap-6">
        <section>
          <label className="mb-2 block text-sm font-medium text-center">Format</label>
          <div className="flex items-center justify-center gap-2">
            {(["claude", "copilot", "both"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTarget(t)}
                className={
                  "rounded-lg border px-4 py-2 text-sm transition-colors " +
                  (target === t
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border text-foreground hover:bg-accent")
                }
              >
                {t === "claude" ? "Claude Code" : t === "copilot" ? "GitHub Copilot" : "Both"}
              </button>
            ))}
          </div>
        </section>

        <section>
          <div className="mb-2 flex items-center justify-between">
            <label className="block text-sm font-medium">
              Agents ({selectedIds.size} of {configs.length} selected)
            </label>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={selectAll} disabled={allSelected || configs.length === 0}>
                Select all
              </Button>
              <Button variant="ghost" size="sm" onClick={selectNone} disabled={selectedIds.size === 0}>
                Select none
              </Button>
            </div>
          </div>

          {configs.length === 0 ? (
            <p className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground text-center">
              No agents yet. Create one first.
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-card">
              {configs.map((c) => (
                <li key={c.id} className="flex items-center gap-3 px-3 py-2">
                  <input
                    type="checkbox"
                    id={`bulk-export-${c.id}`}
                    checked={selectedIds.has(c.id)}
                    onChange={() => toggle(c.id)}
                    className="h-4 w-4"
                  />
                  <label htmlFor={`bulk-export-${c.id}`} className="flex flex-1 cursor-pointer items-center justify-between">
                    <span className="text-sm">{c.name}</span>
                    <span className="text-xs text-muted-foreground">{c.modelId}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <Button onClick={handleExport} disabled={busy || selectedIds.size === 0}>
            {busy ? "Exporting…" : `Export ${selectedList.length || ""} agent${selectedList.length === 1 ? "" : "s"}`}
          </Button>
        </section>

        {lastResult && (
          <section className="rounded-lg border border-border bg-card p-4">
            <h2 className="mb-2 text-sm font-medium text-center">Last export</h2>
            <p className="mb-3 text-xs text-muted-foreground text-center">
              Wrote {lastResult.fileCount} file{lastResult.fileCount === 1 ? "" : "s"} to <code className="bg-muted px-1">{lastResult.rootDir}</code>
            </p>
            <ul className="mb-3 flex flex-col gap-1 text-xs">
              {lastResult.perAgent.map((p) => {
                const name = configs.find((c) => c.id === p.agentId)?.name ?? p.agentId;
                return (
                  <li key={p.agentId} className={p.error ? "text-destructive" : "text-muted-foreground"}>
                    {name}: {p.error ? `failed — ${p.error}` : `${p.fileCount} file${p.fileCount === 1 ? "" : "s"}`}
                  </li>
                );
              })}
            </ul>
            {lastResult.warnings.length > 0 && (
              <details>
                <summary className="cursor-pointer text-xs text-muted-foreground">
                  {lastResult.warnings.length} warning{lastResult.warnings.length === 1 ? "" : "s"}
                </summary>
                <ul className="mt-2 flex flex-col gap-1 text-xs text-muted-foreground">
                  {lastResult.warnings.map((w, i) => (
                    <li key={i}>• {w}</li>
                  ))}
                </ul>
              </details>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
