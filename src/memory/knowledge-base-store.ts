import { dbExecute, dbSelect } from "@/kernel/ipc-bridge";
import type { KnowledgeBase } from "@/types";
import { nanoid } from "nanoid";
import { isoNow } from "@/lib/utils";

interface KBRow {
  id: string;
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
}

interface KBDocRow {
  knowledge_base_id: string;
  document_id: string;
}

async function getDocumentIdsForKB(kbId: string): Promise<string[]> {
  const rows = await dbSelect<KBDocRow>(
    "SELECT document_id FROM knowledge_base_documents WHERE knowledge_base_id = ?",
    [kbId],
  );
  return rows.map((r) => r.document_id);
}

async function rowToKB(row: KBRow): Promise<KnowledgeBase> {
  const documentIds = await getDocumentIdsForKB(row.id);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    documentIds,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listKnowledgeBases(): Promise<KnowledgeBase[]> {
  const rows = await dbSelect<KBRow>(
    "SELECT * FROM knowledge_bases ORDER BY created_at ASC",
  );
  return Promise.all(rows.map(rowToKB));
}

export async function createKnowledgeBase(
  name: string,
  description: string,
): Promise<KnowledgeBase> {
  const id = nanoid();
  const now = isoNow();
  await dbExecute(
    "INSERT INTO knowledge_bases (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    [id, name, description, now, now],
  );
  return { id, name, description, documentIds: [], createdAt: now, updatedAt: now };
}

export async function updateKnowledgeBase(
  id: string,
  updates: Partial<Pick<KnowledgeBase, "name" | "description">>,
): Promise<void> {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (updates.name !== undefined) { fields.push("name = ?"); values.push(updates.name); }
  if (updates.description !== undefined) { fields.push("description = ?"); values.push(updates.description); }
  if (fields.length === 0) return;
  fields.push("updated_at = ?");
  values.push(isoNow());
  values.push(id);
  await dbExecute(`UPDATE knowledge_bases SET ${fields.join(", ")} WHERE id = ?`, values);
}

export async function deleteKnowledgeBase(id: string): Promise<void> {
  await dbExecute("DELETE FROM knowledge_bases WHERE id = ?", [id]);
}

export async function addDocumentToKB(kbId: string, docId: string): Promise<void> {
  await dbExecute(
    "INSERT OR IGNORE INTO knowledge_base_documents (knowledge_base_id, document_id) VALUES (?, ?)",
    [kbId, docId],
  );
  await dbExecute("UPDATE knowledge_bases SET updated_at = ? WHERE id = ?", [isoNow(), kbId]);
}

export async function removeDocumentFromKB(kbId: string, docId: string): Promise<void> {
  await dbExecute(
    "DELETE FROM knowledge_base_documents WHERE knowledge_base_id = ? AND document_id = ?",
    [kbId, docId],
  );
  await dbExecute("UPDATE knowledge_bases SET updated_at = ? WHERE id = ?", [isoNow(), kbId]);
}

export async function getDocumentsInKB(kbId: string): Promise<string[]> {
  return getDocumentIdsForKB(kbId);
}
