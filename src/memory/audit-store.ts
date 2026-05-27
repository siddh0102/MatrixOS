import { dbSelect } from "@/kernel/ipc-bridge";
import { logger } from "@/lib/logger";

export interface AuditEntry {
  id: string;
  eventType: string;
  actor: string;
  targetType: string | null;
  targetId: string | null;
  details: Record<string, unknown> | null;
  createdAt: string;
}

let firstAuditFailureLogged = false;

export async function appendAudit(
  entry: Omit<AuditEntry, "id" | "createdAt">,
): Promise<void> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("audit_append", {
      entry: {
        eventType: entry.eventType,
        actor: entry.actor,
        targetType: entry.targetType,
        targetId: entry.targetId,
        details: entry.details ?? null,
      },
    });
  } catch (err) {
    if (!firstAuditFailureLogged) {
      firstAuditFailureLogged = true;
      logger.warn("audit-store: first write failure", err);
    }
  }
}

export interface ListAuditFilters {
  eventType?: string;
  targetType?: string;
  since?: string;
  until?: string;
}

interface AuditRow {
  id: string;
  event_type: string;
  actor: string;
  target_type: string | null;
  target_id: string | null;
  details_json: string | null;
  created_at: string;
}

interface CountRow {
  total: number;
}

export async function listAuditEntries(
  filters: ListAuditFilters = {},
  limit = 50,
  offset = 0,
): Promise<{ rows: AuditEntry[]; total: number }> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.eventType) {
    conditions.push("event_type = ?");
    params.push(filters.eventType);
  }
  if (filters.targetType) {
    conditions.push("target_type = ?");
    params.push(filters.targetType);
  }
  if (filters.since) {
    conditions.push("created_at >= ?");
    params.push(filters.since);
  }
  if (filters.until) {
    conditions.push("created_at <= ?");
    params.push(filters.until);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const countRows = await dbSelect<CountRow>(
    `SELECT COUNT(*) as total FROM audit_log ${where}`,
    params,
  );
  const total = countRows[0]?.total ?? 0;

  const rows = await dbSelect<AuditRow>(
    `SELECT * FROM audit_log ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  return {
    rows: rows.map((r) => ({
      id: r.id,
      eventType: r.event_type,
      actor: r.actor,
      targetType: r.target_type,
      targetId: r.target_id,
      details: r.details_json ? (JSON.parse(r.details_json) as Record<string, unknown>) : null,
      createdAt: r.created_at,
    })),
    total,
  };
}
