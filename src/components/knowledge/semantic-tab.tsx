import { useState } from "react";
import { useKnowledge } from "@/hooks/use-knowledge";
import { useKnowledgeStore } from "@/stores/knowledge-store";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import type { KnowledgeDocument, DocumentChunk } from "@/types";

function inferFileType(name: string): KnowledgeDocument["fileType"] {
  const ext = name.split(".").pop()?.toLowerCase() ?? "text";
  if (ext === "pdf") return "pdf";
  if (ext === "docx") return "docx";
  if (ext === "pptx") return "pptx";
  if (ext === "md") return "markdown";
  if (["ts", "tsx", "js", "jsx", "py", "rs", "go"].includes(ext)) return "code";
  return "text";
}

// Module-scope queue driver. Lives outside the component so navigation/unmount
// doesn't kill it. The store is the single source of truth for "is anything
// running"; this just dispatches the next item if there isn't one already.
let processorActive = false;
async function processQueue(
  importDoc: (
    name: string,
    fileType: KnowledgeDocument["fileType"],
    path: string,
    onProgress?: (p: import("@/types").ImportProgress) => void,
    signal?: AbortSignal,
  ) => Promise<KnowledgeDocument | null>,
) {
  if (processorActive) return; // already running
  processorActive = true;
  try {
    const store = useKnowledgeStore.getState;
    // Track the user's batch size at start for the "i of N" label.
    const initialQueue = store().importQueue;
    const total = initialQueue.length;
    let index = 0;

    while (store().importQueue.length > 0) {
      const queue = store().importQueue;
      const next = queue[0];
      index++;

      const controller = new AbortController();
      useKnowledgeStore.setState({
        currentImport: {
          name: next.name,
          index,
          total,
          progress: null,
          abortController: controller,
        },
        importQueue: queue.slice(1),
      });

      try {
        await importDoc(
          next.name,
          next.fileType,
          next.path,
          (p) => useKnowledgeStore.getState().setCurrentProgress(p),
          controller.signal,
        );
      } catch (err) {
        const name = (err as { name?: string } | null)?.name;
        if (name === "AbortError") {
          // User cancelled — drop the remaining queue and exit cleanly.
          useKnowledgeStore.setState({ importQueue: [], currentImport: null });
          return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[semantic-tab] import failed:", err);
        // Surface the failure so the user knows WHICH file in the batch failed.
        const { useUIStore } = await import("@/stores/ui-store");
        useUIStore.getState().addToast({
          type: "error",
          message: `Failed to import ${next.name}: ${msg}`,
        });
        // Continue with the next file rather than aborting the whole batch.
      }
    }
  } finally {
    useKnowledgeStore.setState({ currentImport: null });
    processorActive = false;
  }
}

export function SemanticTab() {
  const { documents, embeddingConfig, importDoc, reimportDoc, reembedAll, deleteDoc, searchSemantic } = useKnowledge();

  // Import state lives in the zustand store so it survives tab switches.
  // The actual processing loop is launched here in handleImport, but the
  // closure persists independently of this component's lifecycle.
  const currentImport = useKnowledgeStore((s) => s.currentImport);
  const importQueue = useKnowledgeStore((s) => s.importQueue);
  const cancelImport = useKnowledgeStore((s) => s.cancelImport);
  const importing = currentImport != null;

  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<
    Array<{ chunk: DocumentChunk; document: KnowledgeDocument; score: number }>
  >([]);
  const [searching, setSearching] = useState(false);
  const [reembedding, setReembedding] = useState(false);
  const [reembedProgress, setReembedProgress] = useState<import("@/types").ImportProgress | null>(null);

  async function handleImport() {
    if (!embeddingConfig || importing) return;
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      multiple: true,
      filters: [
        { name: "Documents", extensions: ["pdf", "docx", "pptx", "md", "txt", "ts", "tsx", "js", "jsx", "py", "rs", "go"] },
      ],
    });
    if (!selected) return;

    const rawPaths: string[] = Array.isArray(selected)
      ? selected.map((s) => (typeof s === "string" ? s : (s as { path: string }).path))
      : [typeof selected === "string" ? selected : (selected as { path: string }).path];

    if (rawPaths.length === 0) return;

    const items = rawPaths.map((p) => {
      const name = p.split(/[/\\]/).pop() ?? "Document";
      return { name, path: p, fileType: inferFileType(name) };
    });

    const { registerUserPath } = await import("@/lib/user-paths");
    for (const it of items) {
      await registerUserPath(it.path);
    }

    // Enqueue all files, then drive the queue. Processing is sequential —
    // running embedding work in parallel would just thrash the worker.
    useKnowledgeStore.getState().enqueueImports(items);
    processQueue(importDoc);
  }

  async function handleSearch() {
    if (!searchQuery.trim()) return;
    setSearching(true);
    try {
      const r = await searchSemantic(searchQuery);
      setSearchResults(r);
    } finally {
      setSearching(false);
    }
  }

  async function handleReembed() {
    if (!embeddingConfig || reembedding) return;
    setReembedding(true);
    setReembedProgress({ phase: "embedding", current: 0, total: 0 });
    try {
      const result = await reembedAll((p) => setReembedProgress(p));
      const { useUIStore } = await import("@/stores/ui-store");
      useUIStore.getState().addToast({
        type: "success",
        message: result
          ? `Re-embedded ${result.embedded} chunk${result.embedded === 1 ? "" : "s"}${result.skipped > 0 ? ` (${result.skipped} empty skipped)` : ""}.`
          : "No embedding config set.",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const { useUIStore } = await import("@/stores/ui-store");
      useUIStore.getState().addToast({ type: "error", message: `Re-embed failed: ${msg}` });
    } finally {
      setReembedding(false);
      setReembedProgress(null);
    }
  }

  if (!embeddingConfig) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">
        Configure an embedding provider in Settings to enable document import.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3 flex-wrap">
        <Button onClick={handleImport} disabled={importing}>
          {importing
            ? (() => {
                const p = currentImport?.progress;
                const batchLabel =
                  currentImport && currentImport.total > 1
                    ? `(${currentImport.index}/${currentImport.total}) `
                    : "";
                const chunkLabel =
                  p && p.total > 0 ? ` ${p.current}/${p.total}` : "";
                return `Importing… ${batchLabel}${p?.phase ?? ""}${chunkLabel}`;
              })()
            : "Import Documents"}
        </Button>
        {importing && (
          <Button variant="ghost" onClick={cancelImport}>
            Cancel
          </Button>
        )}
        {importing && currentImport && (
          <span className="text-xs text-muted-foreground truncate max-w-xs" title={currentImport.name}>
            {currentImport.name}
            {importQueue.length > 0 && ` · ${importQueue.length} queued`}
          </span>
        )}
        {!importing && (
          <span className="text-xs text-muted-foreground">
            {documents.length} document{documents.length !== 1 ? "s" : ""} imported
          </span>
        )}
        {!importing && documents.length > 0 && (
          <Button
            variant="ghost"
            onClick={handleReembed}
            disabled={reembedding}
            title="Re-embed every existing chunk's text into the vector index. Use after switching embedding models or when retrieval returns no matches even though documents are imported."
          >
            {reembedding && reembedProgress
              ? `Re-embedding… ${reembedProgress.current}/${reembedProgress.total}`
              : "Re-embed All"}
          </Button>
        )}
      </div>

      {documents.length > 0 && (
        <div className="space-y-2 max-w-2xl">
          {documents.map((doc) => (
            <div
              key={doc.id}
              className="flex items-center justify-between rounded-lg border border-border px-4 py-2"
            >
              <div>
                <span className="text-sm font-medium">{doc.name}</span>
                <span className="ml-2 text-xs text-muted-foreground">
                  {doc.totalChunks} chunks &middot; ~{doc.totalTokensEstimate} tokens
                </span>
              </div>
              <div className="flex gap-2">
                {doc.filePath && (
                  <button
                    onClick={() => reimportDoc(doc.id, (p) => useKnowledgeStore.getState().setCurrentProgress(p))}
                    className="text-xs text-muted-foreground hover:text-foreground"
                    title="Re-import from source file (preserves pinned chunks)"
                  >
                    Re-import
                  </button>
                )}
                <button
                  onClick={() => deleteDoc(doc.id)}
                  className="text-xs text-muted-foreground hover:text-destructive"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="mt-4">
        <label className="mb-2 block text-sm text-muted-foreground">Test Search</label>
        <div className="flex gap-2 max-w-2xl">
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search your documents..."
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            className="flex-1"
          />
          <Button onClick={handleSearch} disabled={searching || !searchQuery.trim()}>
            Search
          </Button>
        </div>
      </div>

      {searchResults.length > 0 && (
        <div className="space-y-3 max-w-3xl">
          {searchResults.map(({ chunk, document, score }) => (
            <div
              key={chunk.id}
              className="rounded-lg border border-border bg-card p-4"
            >
              <div className="mb-2 flex items-center gap-2">
                <span className="text-xs font-medium">{document.name}</span>
                <span className="text-xs text-muted-foreground">
                  Chunk #{chunk.chunkIndex} &middot; Score: {(score * 100).toFixed(0)}%
                </span>
              </div>
              <pre className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
                {chunk.text}
              </pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
