import { useState, useEffect } from "react";
import type { KnowledgeBase, KnowledgeDocument } from "@/types";
import {
  listKnowledgeBases,
  createKnowledgeBase,
  updateKnowledgeBase,
  deleteKnowledgeBase,
} from "@/memory/knowledge-base-store";
import { KnowledgeBaseCard } from "./knowledge-base-card";
import { KnowledgeBaseDialog } from "./knowledge-base-dialog";
import { Button } from "@/components/ui/button";
import { useKnowledgeStore } from "@/stores/knowledge-store";

export function KnowledgeBasesTab() {
  const documents = useKnowledgeStore((s) => s.documents);
  const [bases, setBases] = useState<KnowledgeBase[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingKB, setEditingKB] = useState<KnowledgeBase | undefined>(undefined);

  useEffect(() => {
    listKnowledgeBases()
      .then(setBases)
      .finally(() => setLoading(false));
  }, []);

  async function handleCreate(name: string, description: string) {
    const kb = await createKnowledgeBase(name, description);
    setBases((prev) => [...prev, kb]);
  }

  async function handleEdit(kb: KnowledgeBase, name: string, description: string) {
    await updateKnowledgeBase(kb.id, { name, description });
    setBases((prev) => prev.map((b) => (b.id === kb.id ? { ...b, name, description } : b)));
  }

  async function handleDelete(kbId: string) {
    await deleteKnowledgeBase(kbId);
    setBases((prev) => prev.filter((b) => b.id !== kbId));
  }

  if (loading) {
    return <div className="py-8 text-center text-sm text-muted-foreground">Loading…</div>;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <Button onClick={() => { setEditingKB(undefined); setDialogOpen(true); }}>
          + New Knowledge Base
        </Button>
        <span className="text-xs text-muted-foreground">
          {bases.length} knowledge base{bases.length !== 1 ? "s" : ""}
        </span>
      </div>

      {bases.length === 0 ? (
        <div className="py-8 text-center text-sm text-muted-foreground">
          No knowledge bases yet.{" "}
          <button
            onClick={() => { setEditingKB(undefined); setDialogOpen(true); }}
            className="text-primary underline underline-offset-2"
          >
            Create one
          </button>
        </div>
      ) : (
        <div className="space-y-3 max-w-2xl">
          {bases.map((kb) => (
            <KnowledgeBaseCard
              key={kb.id}
              kb={kb}
              allDocuments={documents as KnowledgeDocument[]}
              onEdit={() => { setEditingKB(kb); setDialogOpen(true); }}
              onDelete={() => handleDelete(kb.id)}
              onUpdated={(updated) => setBases((prev) => prev.map((b) => (b.id === updated.id ? updated : b)))}
            />
          ))}
        </div>
      )}

      <KnowledgeBaseDialog
        open={dialogOpen}
        onClose={() => { setDialogOpen(false); setEditingKB(undefined); }}
        kb={editingKB}
        onSave={async (name, description) => {
          if (editingKB) {
            await handleEdit(editingKB, name, description);
          } else {
            await handleCreate(name, description);
          }
        }}
      />
    </div>
  );
}
