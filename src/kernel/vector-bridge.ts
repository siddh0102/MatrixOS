import { invoke } from "@tauri-apps/api/core";
import type { VectorSearchResult } from "@/types";

export type VecTable = "vec_episodic" | "vec_semantic";

export async function vecUpsert(
  table: VecTable,
  id: string,
  embedding: number[],
  metadata: string,
): Promise<void> {
  await invoke("vec_upsert", { table, id, embedding, metadata });
}

export async function vecSearch(
  table: VecTable,
  queryEmbedding: number[],
  limit: number,
): Promise<VectorSearchResult[]> {
  return invoke<VectorSearchResult[]>("vec_search", {
    table,
    queryEmbedding,
    limit,
  });
}

export async function vecDelete(table: VecTable, id: string): Promise<void> {
  await invoke("vec_delete", { table, id });
}

export async function vecDeleteBatch(table: VecTable, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await invoke("vec_delete_batch", { table, ids });
}

export async function vecClear(table: VecTable): Promise<void> {
  await invoke("vec_clear", { table });
}

export async function vecRecreate(dimensions: number): Promise<void> {
  await invoke("vec_recreate", { dimensions });
}

export async function vecGetDimensions(): Promise<number> {
  return invoke<number>("vec_get_dimensions");
}

export async function extractPdfText(path: string): Promise<string> {
  return invoke<string>("extract_pdf_text", { path });
}

export async function extractDocxText(path: string): Promise<string> {
  return invoke<string>("extract_docx_text", { path });
}

export async function extractPptxText(path: string): Promise<string> {
  return invoke<string>("extract_pptx_text", { path });
}
