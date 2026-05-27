import { useState, useEffect, useCallback } from "react";
import { Select } from "@/components/ui/select";
import { getRequestLog, exportTelemetry } from "@/memory/telemetry-queries";
import type { LLMRequestLog } from "@/types";
import { useSettingsStore } from "@/stores/settings-store";

const PAGE_SIZE = 20;

interface RequestLogTableProps {
  since: string;
  until: string;
  onSelectRequest: (id: string) => void;
}

function formatMs(ms: number) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function formatTokens(n: number) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

function formatDate(iso: string) {
  try {
    return new Date(iso).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
  } catch {
    return iso;
  }
}

export function RequestLogTable({ since, until, onSelectRequest }: RequestLogTableProps) {
  const providers = useSettingsStore((s) => s.providers);
  const [rows, setRows] = useState<LLMRequestLog[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [providerFilter, setProviderFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<"" | "success" | "error">("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await getRequestLog(
        {
          providerId: providerFilter || undefined,
          status: (statusFilter as "success" | "error" | undefined) || undefined,
          since,
          until,
        },
        PAGE_SIZE,
        page * PAGE_SIZE,
      );
      setRows(result.rows);
      setTotal(result.total);
    } finally {
      setLoading(false);
    }
  }, [providerFilter, statusFilter, since, until, page]);

  useEffect(() => {
    void load();
  }, [load]);

  function handleExport(format: "json" | "csv") {
    exportTelemetry(since, until, format).then((content) => {
      const blob = new Blob([content], { type: format === "json" ? "application/json" : "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `telemetry-export.${format}`;
      a.click();
      URL.revokeObjectURL(url);
    });
  }

  const totalPages = Math.ceil(total / PAGE_SIZE);

  const providerName = (id: string) => providers.find((p) => p.id === id)?.name ?? id;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-center gap-2 flex-wrap">
        <Select value={providerFilter} onChange={(e) => { setProviderFilter(e.target.value); setPage(0); }} className="w-36 text-center [text-align-last:center]">
          <option value="">All providers</option>
          {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
        <Select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value as "" | "success" | "error"); setPage(0); }} className="w-32 text-center [text-align-last:center]">
          <option value="">All status</option>
          <option value="success">Success</option>
          <option value="error">Error</option>
        </Select>
        <div className="flex gap-2">
          <button
            onClick={() => handleExport("json")}
            className="rounded-lg border border-border px-4 py-2 text-xs hover:bg-accent transition-colors"
          >
            Export JSON
          </button>
          <button
            onClick={() => handleExport("csv")}
            className="rounded-lg border border-border px-4 py-2 text-xs hover:bg-accent transition-colors"
          >
            Export CSV
          </button>
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No requests found for this time range.</p>
      ) : (
        <div className="rounded-lg border border-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                <th className="px-3 py-2 text-center text-xs font-medium text-muted-foreground">Time</th>
                <th className="px-3 py-2 text-center text-xs font-medium text-muted-foreground">Provider</th>
                <th className="px-3 py-2 text-center text-xs font-medium text-muted-foreground">Model</th>
                <th className="px-3 py-2 text-center text-xs font-medium text-muted-foreground">Agent</th>
                <th className="px-3 py-2 text-center text-xs font-medium text-muted-foreground">Workflow</th>
                <th className="px-3 py-2 text-center text-xs font-medium text-muted-foreground">Tokens</th>
                <th className="px-3 py-2 text-center text-xs font-medium text-muted-foreground">Latency</th>
                <th className="px-3 py-2 text-center text-xs font-medium text-muted-foreground">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((row) => (
                <tr
                  key={row.id}
                  onClick={() => onSelectRequest(row.id)}
                  className="hover:bg-muted/30 cursor-pointer"
                >
                  <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap text-center">{formatDate(row.createdAt)}</td>
                  <td className="px-3 py-2 text-xs text-center">{providerName(row.providerId)}</td>
                  <td className="px-3 py-2 text-xs font-mono text-muted-foreground text-center">{row.modelId}</td>
                  <td className="px-3 py-2 text-xs text-center">{row.agentName ?? "—"}</td>
                  <td className="px-3 py-2 text-xs text-center text-muted-foreground">{row.workflowName ?? "—"}</td>
                  <td className="px-3 py-2 text-xs text-center">
                    {formatTokens(row.inputTokens)}↑ {formatTokens(row.outputTokens)}↓
                  </td>
                  <td className="px-3 py-2 text-xs text-center">{formatMs(row.latencyMs)}</td>
                  <td className="px-3 py-2 text-center">
                    <span className={
                      row.status === "success"
                        ? "text-xs text-green-600 dark:text-green-400"
                        : "text-xs text-destructive"
                    }>
                      {row.status === "success" ? "✓" : "✗"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center gap-2 text-sm">
          <button
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
            className="rounded px-2 py-1 border border-border hover:bg-accent disabled:opacity-40 text-xs"
          >
            ← Prev
          </button>
          <span className="text-muted-foreground text-xs">
            {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={page >= totalPages - 1}
            className="rounded px-2 py-1 border border-border hover:bg-accent disabled:opacity-40 text-xs"
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}
