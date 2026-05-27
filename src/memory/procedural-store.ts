import { dbExecute, dbSelect } from "@/kernel/ipc-bridge";
import { appendAudit } from "@/memory/audit-store";
import { nanoid } from "nanoid";
import { isoNow } from "@/lib/utils";
import type { ProceduralTemplate } from "@/types";

interface ProceduralRow {
  id: string;
  name: string;
  description: string;
  category: string;
  content: string;
  tags_json: string;
  usage_count: number;
  created_at: string;
  updated_at: string;
}

function rowToTemplate(row: ProceduralRow): ProceduralTemplate {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category,
    content: row.content,
    tags: JSON.parse(row.tags_json) as string[],
    usageCount: row.usage_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listProceduralTemplates(): Promise<ProceduralTemplate[]> {
  const rows = await dbSelect<ProceduralRow>(
    "SELECT * FROM procedural_templates ORDER BY usage_count DESC, created_at DESC",
  );
  return rows.map(rowToTemplate);
}

export async function getProceduralByCategory(
  category: string,
  limit: number,
): Promise<ProceduralTemplate[]> {
  const rows = await dbSelect<ProceduralRow>(
    "SELECT * FROM procedural_templates WHERE category = ? ORDER BY usage_count DESC LIMIT ?",
    [category, limit],
  );
  return rows.map(rowToTemplate);
}

export async function saveProceduralTemplate(
  template: Omit<ProceduralTemplate, "id" | "usageCount" | "createdAt" | "updatedAt">,
): Promise<ProceduralTemplate> {
  const id = nanoid();
  const now = isoNow();

  await dbExecute(
    `INSERT INTO procedural_templates
       (id, name, description, category, content, tags_json, usage_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    [id, template.name, template.description, template.category, template.content,
     JSON.stringify(template.tags), now, now],
  );

  appendAudit({
    eventType: "memory.procedural.created",
    actor: "user",
    targetType: "procedural_template",
    targetId: id,
    details: { name: template.name },
  }).catch(() => {});

  return { ...template, id, usageCount: 0, createdAt: now, updatedAt: now };
}

export async function updateProceduralTemplate(
  id: string,
  updates: Partial<Pick<ProceduralTemplate, "name" | "description" | "category" | "content" | "tags">>,
): Promise<void> {
  const rows = await dbSelect<ProceduralRow>(
    "SELECT * FROM procedural_templates WHERE id = ?",
    [id],
  );
  if (rows.length === 0) return;

  const current = rowToTemplate(rows[0]);
  const merged = { ...current, ...updates };

  await dbExecute(
    `UPDATE procedural_templates
     SET name = ?, description = ?, category = ?, content = ?, tags_json = ?, updated_at = ?
     WHERE id = ?`,
    [merged.name, merged.description, merged.category, merged.content,
     JSON.stringify(merged.tags), isoNow(), id],
  );

  appendAudit({
    eventType: "memory.procedural.updated",
    actor: "user",
    targetType: "procedural_template",
    targetId: id,
    details: { name: merged.name },
  }).catch(() => {});
}

export async function deleteProceduralTemplate(id: string): Promise<void> {
  await dbExecute("DELETE FROM procedural_templates WHERE id = ?", [id]);

  appendAudit({
    eventType: "memory.procedural.deleted",
    actor: "user",
    targetType: "procedural_template",
    targetId: id,
    details: null,
  }).catch(() => {});
}

export async function incrementUsageCount(id: string): Promise<void> {
  await dbExecute(
    "UPDATE procedural_templates SET usage_count = usage_count + 1 WHERE id = ?",
    [id],
  );
}

export async function getProceduralByQuery(
  query: string,
  limit: number,
): Promise<ProceduralTemplate[]> {
  const keywords = query.toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2);

  if (keywords.length === 0) {
    const rows = await dbSelect<ProceduralRow>(
      "SELECT * FROM procedural_templates ORDER BY usage_count DESC LIMIT ?",
      [limit],
    );
    return rows.map(rowToTemplate);
  }

  const allRows = await dbSelect<ProceduralRow>(
    "SELECT * FROM procedural_templates",
  );
  const allTemplates = allRows.map(rowToTemplate);

  const scored = allTemplates.map((t) => {
    const searchText = [t.name, t.description, t.category, ...t.tags, t.content]
      .join(" ")
      .toLowerCase();
    const matchCount = keywords.filter((kw) => searchText.includes(kw)).length;
    return { template: t, matchCount };
  });

  return scored
    .filter((s) => s.matchCount > 0)
    .sort((a, b) => b.matchCount - a.matchCount || b.template.usageCount - a.template.usageCount)
    .slice(0, limit)
    .map((s) => s.template);
}
