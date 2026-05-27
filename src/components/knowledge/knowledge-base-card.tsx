import { useState } from "react";
import type { KnowledgeBase, KnowledgeDocument } from "@/types";
import { addDocumentToKB, removeDocumentFromKB } from "@/memory/knowledge-base-store";

interface KnowledgeBaseCardProps {
  kb: KnowledgeBase;
  allDocuments: KnowledgeDocument[];
  onEdit: () => void;
  onDelete: () => void;
  onUpdated: (kb: KnowledgeBase) => void;
}

export function KnowledgeBaseCard({ kb, allDocuments, onEdit, onDelete, onUpdated }: KnowledgeBaseCardProps) {
  const [expanded, setExpanded] = useState(false);

  async function handleAddDoc(docId: string) {
    await addDocumentToKB(kb.id, docId);
    onUpdated({ ...kb, documentIds: [...kb.documentIds, docId] });
  }

  async function handleRemoveDoc(docId: string) {
    await removeDocumentFromKB(kb.id, docId);
    onUpdated({ ...kb, documentIds: kb.documentIds.filter((d) => d !== docId) });
  }

  const kbDocs = allDocuments.filter((d) => kb.documentIds.includes(d.id));
  const availableDocs = allDocuments.filter((d) => !kb.documentIds.includes(d.id));

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-medium truncate">{kb.name}</h3>
          {kb.description && (
            <p className="text-xs text-muted-foreground mt-0.5 truncate">{kb.description}</p>
          )}
          <p className="text-xs text-muted-foreground mt-0.5">
            {kb.documentIds.length} document{kb.documentIds.length !== 1 ? "s" : ""}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setExpanded((e) => !e)}
            className="rounded px-2 py-1 text-xs border border-border hover:bg-muted transition-colors"
          >
            {expanded ? "Collapse" : "Manage Docs"}
          </button>
          <button
            onClick={onEdit}
            className="rounded px-2 py-1 text-xs border border-border hover:bg-muted transition-colors"
          >
            Edit
          </button>
          <button
            onClick={onDelete}
            className="rounded px-2 py-1 text-xs text-muted-foreground hover:text-destructive transition-colors"
          >
            Delete
          </button>
        </div>
      </div>

      {expanded && (
        <div className="space-y-2 border-t border-border pt-3">
          <p className="text-xs font-medium text-muted-foreground">Documents in this KB</p>
          {kbDocs.length === 0 ? (
            <p className="text-xs text-muted-foreground">No documents added yet.</p>
          ) : (
            <ul className="space-y-1">
              {kbDocs.map((doc) => (
                <li key={doc.id} className="flex items-center justify-between gap-2">
                  <span className="text-xs truncate flex-1">{doc.name}</span>
                  <button
                    onClick={() => handleRemoveDoc(doc.id)}
                    className="text-xs text-muted-foreground hover:text-destructive transition-colors shrink-0"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}

          {availableDocs.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">Add document</p>
              {availableDocs.map((doc) => (
                <button
                  key={doc.id}
                  onClick={() => handleAddDoc(doc.id)}
                  className="flex w-full items-center gap-2 rounded px-2 py-1 text-xs hover:bg-muted transition-colors text-left"
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-primary shrink-0" />
                  {doc.name}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
