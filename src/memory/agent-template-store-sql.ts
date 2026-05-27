import { dbExecute, dbSelect } from "@/kernel/ipc-bridge";
import type { LibraryAgentTemplate, LibraryIconType } from "@/types";
import { isoNow } from "@/lib/utils";
import { appendAudit } from "@/memory/audit-store";
import { getPreference, setPreference } from "@/memory/preferences-store";

const SEEN_BUNDLED_AGENT_TEMPLATES_PREF = "library.seen_bundled_agent_template_ids";

export type AgentTemplateOrigin = "bundled" | "user" | "imported";

interface AgentTemplateRow {
  id: string;
  name: string;
  description: string;
  category: string;
  system_prompt: string;
  temperature: number;
  max_tokens: number;
  max_conversation_history: number;
  icon: string;
  tags_json: string;
  author: string;
  version: string;
  suggested_skill_ids_json: string;
  sort_order: number;
  origin: string;
  created_at: string;
  updated_at: string;
}

function rowToTemplate(row: AgentTemplateRow): LibraryAgentTemplate {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category,
    systemPrompt: row.system_prompt,
    temperature: row.temperature,
    maxTokens: row.max_tokens,
    maxConversationHistory: row.max_conversation_history,
    icon: row.icon as LibraryIconType,
    tags: JSON.parse(row.tags_json) as string[],
    author: row.author,
    version: row.version,
    suggestedSkillIds: JSON.parse(row.suggested_skill_ids_json) as string[],
    sortOrder: row.sort_order,
  };
}

export async function listAgentTemplates(): Promise<LibraryAgentTemplate[]> {
  const rows = await dbSelect<AgentTemplateRow>(
    "SELECT * FROM agent_templates ORDER BY sort_order ASC, name ASC",
  );
  return rows.map(rowToTemplate);
}

export async function saveAgentTemplate(
  template: LibraryAgentTemplate,
  origin: AgentTemplateOrigin = "user",
): Promise<void> {
  const existing = await dbSelect<{ id: string }>(
    "SELECT id FROM agent_templates WHERE id = ?",
    [template.id],
  );
  const isNew = existing.length === 0;
  const now = isoNow();

  await dbExecute(
    `INSERT OR REPLACE INTO agent_templates (
        id, name, description, category, system_prompt,
        temperature, max_tokens, max_conversation_history,
        icon, tags_json, author, version, suggested_skill_ids_json,
        sort_order, origin, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT created_at FROM agent_templates WHERE id = ?), ?), ?)`,
    [
      template.id,
      template.name,
      template.description,
      template.category,
      template.systemPrompt,
      template.temperature,
      template.maxTokens,
      template.maxConversationHistory,
      template.icon,
      JSON.stringify(template.tags),
      template.author,
      template.version,
      JSON.stringify(template.suggestedSkillIds),
      template.sortOrder,
      origin,
      template.id,
      now,
      now,
    ],
  );

  appendAudit({
    eventType: isNew ? "agent_template.created" : "agent_template.updated",
    actor: "user",
    targetType: "agent_template",
    targetId: template.id,
    details: { name: template.name, origin },
  }).catch(() => {});
}

export async function deleteAgentTemplate(id: string): Promise<void> {
  const rows = await dbSelect<{ name: string }>(
    "SELECT name FROM agent_templates WHERE id = ?",
    [id],
  );
  const name = rows[0]?.name ?? id;
  await dbExecute("DELETE FROM agent_templates WHERE id = ?", [id]);
  appendAudit({
    eventType: "agent_template.deleted",
    actor: "user",
    targetType: "agent_template",
    targetId: id,
    details: { name },
  }).catch(() => {});
}

/**
 * Seed bundled agent templates into the local DB. Idempotent via the
 * `seen_bundled_agent_template_ids` preference — once an id is in that
 * set, future launches never re-insert it, so user-deleted bundled
 * templates stay deleted.
 */
export async function seedBundledAgentTemplates(
  bundle: LibraryAgentTemplate[],
): Promise<{ seeded: number; total: number }> {
  const seenList =
    (await getPreference<string[]>(SEEN_BUNDLED_AGENT_TEMPLATES_PREF)) ?? [];
  const seen = new Set(seenList);
  const existingIds = new Set(
    (await dbSelect<{ id: string }>("SELECT id FROM agent_templates")).map((r) => r.id),
  );
  const now = isoNow();
  let inserted = 0;
  const touchedIds: string[] = [];

  for (const tpl of bundle) {
    if (seen.has(tpl.id)) continue;
    if (existingIds.has(tpl.id)) {
      touchedIds.push(tpl.id);
      continue;
    }
    await dbExecute(
      `INSERT INTO agent_templates (
          id, name, description, category, system_prompt,
          temperature, max_tokens, max_conversation_history,
          icon, tags_json, author, version, suggested_skill_ids_json,
          sort_order, origin, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'bundled', ?, ?)`,
      [
        tpl.id,
        tpl.name,
        tpl.description,
        tpl.category,
        tpl.systemPrompt,
        tpl.temperature,
        tpl.maxTokens,
        tpl.maxConversationHistory,
        tpl.icon,
        JSON.stringify(tpl.tags),
        tpl.author,
        tpl.version,
        JSON.stringify(tpl.suggestedSkillIds),
        tpl.sortOrder,
        now,
        now,
      ],
    );
    touchedIds.push(tpl.id);
    inserted += 1;
  }

  if (touchedIds.length > 0) {
    for (const id of touchedIds) seen.add(id);
    await setPreference(SEEN_BUNDLED_AGENT_TEMPLATES_PREF, Array.from(seen));
  }

  return { seeded: inserted, total: bundle.length };
}
