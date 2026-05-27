import { dbExecute, dbSelect } from "@/kernel/ipc-bridge";
import type { ImportedSkill, SkillTemplate } from "@/types";
import { isoNow } from "@/lib/utils";
import { appendAudit } from "@/memory/audit-store";
import { getPreference, setPreference } from "@/memory/preferences-store";

const SEEN_BUNDLED_SKILLS_PREF = "library.seen_bundled_skill_ids";

interface SkillRow {
  id: string;
  source_template_id: string | null;
  source_version: string | null;
  name: string;
  description: string;
  category: string;
  prompt: string;
  tags_json: string;
  created_at: string;
  updated_at: string;
}

function rowToSkill(row: SkillRow): ImportedSkill {
  return {
    id: row.id,
    sourceTemplateId: row.source_template_id,
    sourceVersion: row.source_version,
    name: row.name,
    description: row.description,
    category: row.category,
    prompt: row.prompt,
    tags: JSON.parse(row.tags_json) as string[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listSkills(): Promise<ImportedSkill[]> {
  const rows = await dbSelect<SkillRow>(
    "SELECT * FROM skills ORDER BY created_at ASC",
  );
  return rows.map(rowToSkill);
}

export async function saveSkill(skill: ImportedSkill): Promise<void> {
  const existing = await dbSelect<{ id: string }>(
    "SELECT id FROM skills WHERE id = ?",
    [skill.id],
  );
  const isNew = existing.length === 0;

  await dbExecute(
    `INSERT OR REPLACE INTO skills
       (id, source_template_id, source_version, name, description, category, prompt, tags_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      skill.id,
      skill.sourceTemplateId,
      skill.sourceVersion,
      skill.name,
      skill.description,
      skill.category,
      skill.prompt,
      JSON.stringify(skill.tags),
      skill.createdAt,
      isoNow(),
    ],
  );

  appendAudit({
    eventType: isNew ? "skill.created" : "skill.updated",
    actor: "user",
    targetType: "skill",
    targetId: skill.id,
    details: { name: skill.name },
  }).catch(() => {});
}

/**
 * Seed bundled skills into the local skills table. Idempotent across
 * launches via a `seen_bundled_skill_ids` preference: any bundle entry not
 * yet seen by this install gets inserted; user-deleted skills are NOT
 * re-added because their id remains in the seen set after deletion.
 *
 * Returns the number of new rows inserted so the caller can log/toast.
 */
export async function seedBundledSkills(
  bundle: SkillTemplate[],
): Promise<{ seeded: number; total: number }> {
  const seenList =
    (await getPreference<string[]>(SEEN_BUNDLED_SKILLS_PREF)) ?? [];
  const seen = new Set(seenList);
  // Look up by source_template_id (not id) — early users imported via a UI
  // flow that assigned nanoid row IDs while pointing source_template_id at
  // the bundle slug. Inserting by bundle id would silently duplicate those.
  const existingTemplateIds = new Set(
    (
      await dbSelect<{ source_template_id: string | null }>(
        "SELECT source_template_id FROM skills WHERE source_template_id IS NOT NULL",
      )
    )
      .map((r) => r.source_template_id)
      .filter((v): v is string => v !== null),
  );
  const now = isoNow();
  let inserted = 0;
  const touchedIds: string[] = [];

  for (const tpl of bundle) {
    if (seen.has(tpl.id)) continue;
    if (existingTemplateIds.has(tpl.id)) {
      // Already present (possibly under a legacy nanoid id) — mark seen and
      // skip so future launches don't re-attempt.
      touchedIds.push(tpl.id);
      continue;
    }
    await dbExecute(
      `INSERT INTO skills
         (id, source_template_id, source_version, name, description, category, prompt, tags_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        tpl.id,
        tpl.id,
        tpl.version,
        tpl.name,
        tpl.description,
        tpl.category,
        tpl.prompt,
        JSON.stringify(tpl.tags),
        now,
        now,
      ],
    );
    touchedIds.push(tpl.id);
    inserted += 1;
  }

  if (touchedIds.length > 0) {
    for (const id of touchedIds) seen.add(id);
    await setPreference(SEEN_BUNDLED_SKILLS_PREF, Array.from(seen));
  }

  return { seeded: inserted, total: bundle.length };
}

export async function deleteSkill(id: string): Promise<void> {
  const rows = await dbSelect<SkillRow>(
    "SELECT * FROM skills WHERE id = ?",
    [id],
  );
  const name = rows[0]?.name ?? id;

  await dbExecute("DELETE FROM skills WHERE id = ?", [id]);

  appendAudit({
    eventType: "skill.deleted",
    actor: "user",
    targetType: "skill",
    targetId: id,
    details: { name },
  }).catch(() => {});
}
