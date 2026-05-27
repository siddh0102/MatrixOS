import { dbExecute, dbSelect } from "@/kernel/ipc-bridge";
import { vecUpsert, vecSearch, vecDeleteBatch } from "@/kernel/vector-bridge";
import { extractPdfText, extractDocxText, extractPptxText } from "@/kernel/vector-bridge";
import { embedText, embedBatch, estimateTokens } from "@/memory/embedding-service";
import { chunkText, chunkMarkdown, chunkCode } from "@/memory/chunker";
import { appendAudit } from "@/memory/audit-store";
import { nanoid } from "nanoid";
import { isoNow } from "@/lib/utils";
import type {
  KnowledgeDocument,
  DocumentChunk,
  EmbeddingConfig,
  ImportProgress,
} from "@/types";

// ── Row types ──

interface DocumentRow {
  id: string;
  name: string;
  file_type: string;
  file_path: string | null;
  total_chunks: number;
  total_tokens_estimate: number;
  created_at: string;
  updated_at: string;
}

interface ChunkRow {
  id: string;
  document_id: string;
  chunk_index: number;
  text: string;
  token_estimate: number;
  pinned: number;
  created_at: string;
}

function rowToDocument(row: DocumentRow): KnowledgeDocument {
  return {
    id: row.id,
    name: row.name,
    fileType: row.file_type as KnowledgeDocument["fileType"],
    filePath: row.file_path,
    totalChunks: row.total_chunks,
    totalTokensEstimate: row.total_tokens_estimate,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToChunk(row: ChunkRow): DocumentChunk {
  return {
    id: row.id,
    documentId: row.document_id,
    chunkIndex: row.chunk_index,
    text: row.text,
    tokenEstimate: row.token_estimate,
    pinned: row.pinned === 1,
    createdAt: row.created_at,
  };
}

// ── Document Import ──

/**
 * Imports a document end-to-end: extract text → chunk → embed → store.
 *
 * Pass `signal` to support cancellation. On abort, the function throws a
 * DOMException with name "AbortError" AND deletes any partial DB state
 * (knowledge_documents row + document_chunks rows + vec_semantic entries)
 * that was inserted before the cancel landed.
 */
export async function importDocument(
  name: string,
  fileType: KnowledgeDocument["fileType"],
  filePath: string,
  embeddingConfig: EmbeddingConfig,
  onProgress?: (progress: ImportProgress) => void,
  signal?: AbortSignal,
): Promise<KnowledgeDocument> {
  const docId = nanoid();
  const now = isoNow();

  const throwIfAborted = () => {
    if (signal?.aborted) {
      throw new DOMException("Import cancelled", "AbortError");
    }
  };

  // Track whether the parent row has been INSERTed so cleanup-on-abort knows
  // whether to call deleteDocument (which handles FK + vec cleanup) vs no-op.
  let parentInserted = false;
  let totalChunks = 0;
  let totalTokens = 0;

  try {
    throwIfAborted();

    onProgress?.({ phase: "reading", current: 0, total: 1 });
    let text: string;
    if (fileType === "pdf") {
      text = await extractPdfText(filePath);
    } else if (fileType === "docx") {
      text = await extractDocxText(filePath);
    } else if (fileType === "pptx") {
      text = await extractPptxText(filePath);
    } else {
      const { invoke } = await import("@tauri-apps/api/core");
      text = await invoke<string>("fs_read", { ctx: { type: "User" }, path: filePath });
    }

    throwIfAborted();
    onProgress?.({ phase: "chunking", current: 0, total: 1 });
    const chunker =
      fileType === "markdown" ? chunkMarkdown
      : fileType === "code" ? chunkCode
      : chunkText;
    const textChunks = chunker(text);
    totalChunks = textChunks.length;

    if (totalChunks === 0) {
      // pdf-extract / docx-extract / pptx-extract returned empty text OR
      // the chunker produced zero chunks. Either way there's nothing to
      // embed; leaving a 0/0 document row is misleading. Throw a clear
      // error and let the catch block do the cleanup (no parent row yet,
      // so cleanup is a no-op).
      throw new Error(
        `No text extracted from ${name}. The file may be scanned, encrypted, ` +
        `or use a PDF encoding that pdf-extract cannot decode.`,
      );
    }

    // Insert the parent knowledge_documents row FIRST so document_chunks.document_id
    // FK constraint is satisfied. Counts get UPDATEd at the end once known. Phase C
    // enabled PRAGMA foreign_keys=ON which made the previous chunks-before-parent
    // ordering fail with FOREIGN KEY constraint failed.
    await dbExecute(
      `INSERT INTO knowledge_documents
         (id, name, file_type, file_path, total_chunks, total_tokens_estimate, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, 0, ?, ?)`,
      [docId, name, fileType, filePath, now, now],
    );
    parentInserted = true;

    const BATCH_SIZE = 10;
    for (let i = 0; i < textChunks.length; i += BATCH_SIZE) {
      throwIfAborted();
      const batch = textChunks.slice(i, i + BATCH_SIZE);
      onProgress?.({ phase: "embedding", current: i, total: totalChunks });

      const embeddings = await embedBatch(
        batch.map((c) => c.text),
        embeddingConfig,
        "document",
      );

      for (let j = 0; j < batch.length; j++) {
        const chunk = batch[j];
        const chunkId = nanoid();
        totalTokens += chunk.tokenEstimate;

        await dbExecute(
          `INSERT INTO document_chunks
             (id, document_id, chunk_index, text, token_estimate, pinned, created_at)
           VALUES (?, ?, ?, ?, ?, 0, ?)`,
          [chunkId, docId, chunk.index, chunk.text, chunk.tokenEstimate, now],
        );

        await vecUpsert(
          "vec_semantic",
          chunkId,
          embeddings[j],
          JSON.stringify({ type: "semantic", chunkId, documentId: docId }),
        );
      }
    }

    throwIfAborted();
    onProgress?.({ phase: "storing", current: totalChunks, total: totalChunks });
    await dbExecute(
      `UPDATE knowledge_documents
          SET total_chunks = ?, total_tokens_estimate = ?, updated_at = ?
        WHERE id = ?`,
      [totalChunks, totalTokens, now, docId],
    );
  } catch (err) {
    // On abort (or any other failure), purge the partial doc + chunks + vec entries.
    // deleteDocument handles all three: vec_semantic cleanup, document_chunks DELETE,
    // and knowledge_documents DELETE. Safe to call only if the parent was inserted.
    if (parentInserted) {
      try { await deleteDocument(docId); } catch { /* best-effort */ }
    }
    throw err;
  }

  onProgress?.({ phase: "done", current: totalChunks, total: totalChunks });

  appendAudit({
    eventType: "memory.document.imported",
    actor: "user",
    targetType: "knowledge_document",
    targetId: docId,
    details: { name, fileType, totalChunks, totalTokens },
  }).catch(() => {});

  return {
    id: docId,
    name,
    fileType,
    filePath,
    totalChunks,
    totalTokensEstimate: totalTokens,
    createdAt: now,
    updatedAt: now,
  };
}

// ── Search ──

export async function searchDocuments(
  query: string,
  config: EmbeddingConfig,
  limit: number,
  threshold: number,
  documentIds?: string[],
): Promise<Array<{ chunk: DocumentChunk; document: KnowledgeDocument; score: number }>> {
  const queryEmbedding = await embedText(query, config, "query");
  const vecResults = await vecSearch("vec_semantic", queryEmbedding, limit * 2);

  const maxDistance = 1 - threshold;
  const filtered = vecResults.filter((r) => r.distance <= maxDistance);
  if (filtered.length === 0) return [];

  const vecEntries = filtered.map((vec) => ({
    ...JSON.parse(vec.metadata) as { chunkId: string; documentId: string },
    score: 1 - vec.distance,
  }));

  const scopedEntries = documentIds?.length
    ? vecEntries.filter((e) => documentIds.includes(e.documentId))
    : vecEntries;
  if (scopedEntries.length === 0) return [];

  const chunkIds = [...new Set(scopedEntries.map((e) => e.chunkId))];
  const docIds = [...new Set(scopedEntries.map((e) => e.documentId))];

  const chunkPlaceholders = chunkIds.map(() => "?").join(",");
  const docPlaceholders = docIds.map(() => "?").join(",");

  const [chunkRows, docRows] = await Promise.all([
    dbSelect<ChunkRow>(
      `SELECT * FROM document_chunks WHERE id IN (${chunkPlaceholders})`,
      chunkIds,
    ),
    dbSelect<DocumentRow>(
      `SELECT * FROM knowledge_documents WHERE id IN (${docPlaceholders})`,
      docIds,
    ),
  ]);

  const chunkMap = new Map(chunkRows.map((r) => [r.id, r]));
  const docMap = new Map(docRows.map((r) => [r.id, r]));

  const results: Array<{ chunk: DocumentChunk; document: KnowledgeDocument; score: number }> = [];
  for (const entry of scopedEntries) {
    const chunkRow = chunkMap.get(entry.chunkId);
    const docRow = docMap.get(entry.documentId);
    if (!chunkRow || !docRow) continue;
    results.push({
      chunk: rowToChunk(chunkRow),
      document: rowToDocument(docRow),
      score: entry.score,
    });
    if (results.length >= limit) break;
  }

  return results;
}

// ── CRUD ──

export async function listDocuments(): Promise<KnowledgeDocument[]> {
  const rows = await dbSelect<DocumentRow>(
    "SELECT * FROM knowledge_documents ORDER BY created_at DESC",
  );
  return rows.map(rowToDocument);
}

export async function getDocumentChunks(documentId: string): Promise<DocumentChunk[]> {
  const rows = await dbSelect<ChunkRow>(
    "SELECT * FROM document_chunks WHERE document_id = ? ORDER BY chunk_index ASC",
    [documentId],
  );
  return rows.map(rowToChunk);
}

export async function deleteDocument(documentId: string): Promise<void> {
  const chunkRows = await dbSelect<{ id: string }>(
    "SELECT id FROM document_chunks WHERE document_id = ?",
    [documentId],
  );
  if (chunkRows.length > 0) {
    await vecDeleteBatch("vec_semantic", chunkRows.map((r) => r.id));
  }

  await dbExecute("DELETE FROM knowledge_documents WHERE id = ?", [documentId]);

  appendAudit({
    eventType: "memory.document.deleted",
    actor: "user",
    targetType: "knowledge_document",
    targetId: documentId,
    details: null,
  }).catch(() => {});
}

export async function reimportDocument(
  documentId: string,
  embeddingConfig: EmbeddingConfig,
  onProgress?: (progress: ImportProgress) => void,
): Promise<KnowledgeDocument> {
  const docRows = await dbSelect<DocumentRow>(
    "SELECT * FROM knowledge_documents WHERE id = ?",
    [documentId],
  );
  if (docRows.length === 0) throw new Error("Document not found");
  const doc = rowToDocument(docRows[0]);
  if (!doc.filePath) throw new Error("No file path — cannot reimport");

  const pinnedChunkIndices = new Set(
    (await dbSelect<{ chunk_index: number }>(
      "SELECT chunk_index FROM document_chunks WHERE document_id = ? AND pinned = 1",
      [documentId],
    )).map((r) => r.chunk_index),
  );

  const oldChunkRows = await dbSelect<{ id: string }>(
    "SELECT id FROM document_chunks WHERE document_id = ?",
    [documentId],
  );
  if (oldChunkRows.length > 0) {
    await vecDeleteBatch("vec_semantic", oldChunkRows.map((r) => r.id));
  }
  await dbExecute("DELETE FROM document_chunks WHERE document_id = ?", [documentId]);

  onProgress?.({ phase: "reading", current: 0, total: 1 });
  let text: string;
  if (doc.fileType === "pdf") {
    text = await extractPdfText(doc.filePath);
  } else if (doc.fileType === "docx") {
    text = await extractDocxText(doc.filePath);
  } else if (doc.fileType === "pptx") {
    text = await extractPptxText(doc.filePath);
  } else {
    const { invoke } = await import("@tauri-apps/api/core");
    text = await invoke<string>("fs_read", { ctx: { type: "User" }, path: doc.filePath });
  }

  onProgress?.({ phase: "chunking", current: 0, total: 1 });
  const chunker =
    doc.fileType === "markdown" ? chunkMarkdown
    : doc.fileType === "code" ? chunkCode
    : chunkText;
  const textChunks = chunker(text);

  const totalChunks = textChunks.length;
  let totalTokens = 0;
  const now = isoNow();

  const BATCH_SIZE = 10;
  for (let i = 0; i < textChunks.length; i += BATCH_SIZE) {
    const batch = textChunks.slice(i, i + BATCH_SIZE);
    onProgress?.({ phase: "embedding", current: i, total: totalChunks });
    const embeddings = await embedBatch(batch.map((c) => c.text), embeddingConfig, "document");

    for (let j = 0; j < batch.length; j++) {
      const chunk = batch[j];
      const chunkId = nanoid();
      const pinned = pinnedChunkIndices.has(chunk.index) ? 1 : 0;
      totalTokens += chunk.tokenEstimate;

      await dbExecute(
        `INSERT INTO document_chunks
           (id, document_id, chunk_index, text, token_estimate, pinned, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [chunkId, documentId, chunk.index, chunk.text, chunk.tokenEstimate, pinned, now],
      );
      await vecUpsert("vec_semantic", chunkId, embeddings[j],
        JSON.stringify({ type: "semantic", chunkId, documentId }));
    }
  }

  onProgress?.({ phase: "storing", current: totalChunks, total: totalChunks });
  await dbExecute(
    `UPDATE knowledge_documents SET total_chunks = ?, total_tokens_estimate = ?, updated_at = ? WHERE id = ?`,
    [totalChunks, totalTokens, now, documentId],
  );

  onProgress?.({ phase: "done", current: totalChunks, total: totalChunks });

  return { ...doc, totalChunks, totalTokensEstimate: totalTokens, updatedAt: now };
}

/**
 * Re-embed every row in `document_chunks` and write the vectors to
 * `vec_semantic`. Used after a dimension/model change where the vec table
 * was rebuilt but the chunk text rows survived — avoids re-extracting and
 * re-chunking source PDFs (which can be very slow).
 *
 * The function is idempotent: if vec_semantic already has a vector for a
 * chunk id, vecUpsert overwrites it; if not, it inserts. The function does
 * NOT clear vec_semantic first — call vecRecreate beforehand if you need
 * to start clean.
 */
export async function reembedAllChunks(
  embeddingConfig: EmbeddingConfig,
  onProgress?: (progress: ImportProgress) => void,
  signal?: AbortSignal,
): Promise<{ embedded: number; skipped: number }> {
  const chunks = await dbSelect<ChunkRow>(
    "SELECT id, document_id, text FROM document_chunks ORDER BY document_id, chunk_index",
  );
  const total = chunks.length;
  if (total === 0) {
    onProgress?.({ phase: "done", current: 0, total: 0 });
    return { embedded: 0, skipped: 0 };
  }

  const BATCH_SIZE = 10;
  let embedded = 0;
  let skipped = 0;

  for (let i = 0; i < total; i += BATCH_SIZE) {
    if (signal?.aborted) {
      const err = new Error("Re-embed cancelled");
      err.name = "AbortError";
      throw err;
    }
    const batch = chunks.slice(i, i + BATCH_SIZE);
    onProgress?.({ phase: "embedding", current: i, total });

    // Filter out rows whose text is empty/whitespace — embeddings would
    // be undefined or zero-vector and pollute the index.
    const embeddable = batch.filter((c) => c.text.trim().length > 0);
    skipped += batch.length - embeddable.length;
    if (embeddable.length === 0) continue;

    const vectors = await embedBatch(
      embeddable.map((c) => c.text),
      embeddingConfig,
      "document",
    );

    for (let j = 0; j < embeddable.length; j++) {
      const chunk = embeddable[j];
      await vecUpsert(
        "vec_semantic",
        chunk.id,
        vectors[j],
        JSON.stringify({ type: "semantic", chunkId: chunk.id, documentId: chunk.document_id }),
      );
      embedded++;
    }
  }

  onProgress?.({ phase: "done", current: total, total });
  return { embedded, skipped };
}

export async function toggleChunkPin(chunkId: string, pinned: boolean): Promise<void> {
  await dbExecute(
    "UPDATE document_chunks SET pinned = ? WHERE id = ?",
    [pinned ? 1 : 0, chunkId],
  );
}

export async function getPinnedChunks(): Promise<Array<{ chunk: DocumentChunk; document: KnowledgeDocument }>> {
  const chunkRows = await dbSelect<ChunkRow>(
    "SELECT * FROM document_chunks WHERE pinned = 1 ORDER BY created_at ASC",
  );
  if (chunkRows.length === 0) return [];

  // Batch-resolve parent documents (avoids N+1 queries)
  const docIds = [...new Set(chunkRows.map((r) => r.document_id))];
  const docPlaceholders = docIds.map(() => "?").join(",");
  const docRows = await dbSelect<DocumentRow>(
    `SELECT * FROM knowledge_documents WHERE id IN (${docPlaceholders})`,
    docIds,
  );
  const docMap = new Map(docRows.map((r) => [r.id, r]));

  const results: Array<{ chunk: DocumentChunk; document: KnowledgeDocument }> = [];
  for (const row of chunkRows) {
    const docRow = docMap.get(row.document_id);
    if (!docRow) continue;
    results.push({
      chunk: rowToChunk(row),
      document: rowToDocument(docRow),
    });
  }
  return results;
}

// suppress unused import warning — estimateTokens is re-exported for memory-manager
void estimateTokens;
