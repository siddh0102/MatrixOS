import { useState, useEffect, useCallback } from "react";
import { Select } from "@/components/ui/select";
import { getToolExecutions } from "@/memory/telemetry-queries";
import type { ToolExecutionLog } from "@/types";

const PAGE_SIZE = 20;

interface ToolLogTableProps {
  since: string;
  until: string;
  onSelect: (exec: ToolExecutionLog) => void;
}

function formatMs(ms: number | null) {
  if (ms == null) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function formatDate(iso: string) {
  try {
    return new Date(iso).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
  } catch {
    return iso;
  }
}

export function ToolLogTable({ since, until, onSelect }: ToolLogTableProps) {
  const [rows, setRows] = useState<ToolExecutionLog[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await getToolExecutions(
        { search: search || undefined, status: statusFilter || undefined, since, until },
        PAGE_SIZE,
        page * PAGE_SIZE,
      );
      setRows(result.rows);
      setTotal(result.total);
    } catch {
      setRows([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [search, statusFilter, since, until, page]);

  useEffect(() => { void load(); }, [load]);

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-center gap-2 flex-wrap">
        <input
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(0); }}
          placeholder="Search tool…"
          className="w-40 rounded-lg border border-border bg-background px-3 py-1.5 text-xs text-center"
        />
        <Select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(0); }} className="w-36 text-center [text-align-last:center]">
          <option value="">All status</option>
          <option value="completed">Completed</option>
          <option value="failed">Failed</option>
          <option value="timed_out">Timed out</option>
        </Select>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground text-center">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center">No tool calls for this time range.</p>
      ) : (
        <div className="rounded-lg border border-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                <th className="px-3 py-2 text-center text-xs font-medium text-muted-foreground">Time</th>
                <th className="px-3 py-2 text-center text-xs font-medium text-muted-foreground">Tool</th>
                <th className="px-3 py-2 text-center text-xs font-medium text-muted-foreground">Agent</th>
                <th className="px-3 py-2 text-center text-xs font-medium text-muted-foreground">Workflow</th>
                <th className="px-3 py-2 text-center text-xs font-medium text-muted-foreground">Duration</th>
                <th className="px-3 py-2 text-center text-xs font-medium text-muted-foreground">Sandbox</th>
                <th className="px-3 py-2 text-center text-xs font-medium text-muted-foreground">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((row) => (
                <tr
                  key={row.id}
                  onClick={() => onSelect(row)}
                  className="hover:bg-muted/30 cursor-pointer"
                >
                  <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap text-center">{formatDate(row.createdAt)}</td>
                  <td className="px-3 py-2 text-xs font-mono text-center">{row.toolName}</td>
                  <td className="px-3 py-2 text-xs text-center">{row.agentName ?? "—"}</td>
                  <td className="px-3 py-2 text-xs text-center text-muted-foreground">{row.workflowName ?? "—"}</td>
                  <td className="px-3 py-2 text-xs text-center">{formatMs(row.durationMs)}</td>
                  <td className="px-3 py-2 text-xs text-center">
                    {row.sandboxDecision === "denied" ? (
                      <span className="text-destructive">denied</span>
                    ) : (
                      <span className="text-muted-foreground">{row.sandboxDecision ?? "—"}</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-center">
                    <span className={row.status === "completed" ? "text-xs text-green-600 dark:text-green-400" : "text-xs text-destructive"}>
                      {row.status === "completed" ? "✓" : "✗"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 text-sm">
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
