import { useState, useEffect, useCallback } from "react";
import { listAuditEntries, type AuditEntry, type ListAuditFilters } from "@/memory/audit-store";
import { Select } from "@/components/ui/select";

const EVENT_TYPES = [
  "provider.connected",
  "provider.disconnected",
  "provider.key_set",
  "provider.key_deleted",
  "tool.executed",
  "tool.failed",
  "tool.approved",
  "tool.rejected",
  "tool.timed_out",
  "agent.created",
  "agent.updated",
  "agent.deleted",
  "conversation.exported",
];

const PAGE_SIZE = 50;

function formatDate(iso: string) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function EventBadge({ type }: { type: string }) {
  const isError = type.includes("failed") || type.includes("rejected") || type.includes("deleted");
  const isSuccess = type.includes("approved") || type.includes("executed") || type.includes("connected") || type.includes("created");

  return (
    <span
      className={
        isError
          ? "rounded px-1.5 py-0.5 text-xs font-medium bg-destructive/15 text-destructive"
          : isSuccess
          ? "rounded px-1.5 py-0.5 text-xs font-medium bg-green-500/15 text-green-600 dark:text-green-400"
          : "rounded px-1.5 py-0.5 text-xs font-medium bg-muted text-muted-foreground"
      }
    >
      {type}
    </span>
  );
}

export function AuditLogViewer() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [eventTypeFilter, setEventTypeFilter] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const filters: ListAuditFilters = {};
      if (eventTypeFilter) filters.eventType = eventTypeFilter;
      const result = await listAuditEntries(filters, PAGE_SIZE, page * PAGE_SIZE);
      setEntries(result.rows);
      setTotal(result.total);
    } finally {
      setLoading(false);
    }
  }, [eventTypeFilter, page]);

  useEffect(() => {
    void load();
  }, [load]);

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div className="flex flex-col gap-4 max-w-3xl">
      <div className="flex items-center gap-3">
        <Select
          value={eventTypeFilter}
          onChange={(e) => {
            setEventTypeFilter(e.target.value);
            setPage(0);
          }}
          className="w-56"
        >
          <option value="">All event types</option>
          {EVENT_TYPES.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </Select>
        <span className="text-sm text-muted-foreground ml-auto">{total} entries</span>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">No audit entries found.</p>
      ) : (
        <div className="rounded-lg border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Time</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Event</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Target</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Actor</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {entries.map((entry) => (
                <tr key={entry.id} className="hover:bg-muted/30">
                  <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">
                    {formatDate(entry.createdAt)}
                  </td>
                  <td className="px-3 py-2">
                    <EventBadge type={entry.eventType} />
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {entry.targetId ?? entry.targetType ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground capitalize">
                    {entry.actor}
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
            className="rounded px-2 py-1 border border-border hover:bg-accent disabled:opacity-40"
          >
            ← Prev
          </button>
          <span className="text-muted-foreground">
            Page {page + 1} of {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={page >= totalPages - 1}
            className="rounded px-2 py-1 border border-border hover:bg-accent disabled:opacity-40"
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}
