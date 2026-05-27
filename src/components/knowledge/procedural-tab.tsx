import { useState, useEffect } from "react";
import { useKnowledge } from "@/hooks/use-knowledge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import type { ProceduralTemplate } from "@/types";

export function ProceduralTab() {
  const { proceduralTemplates, createProcedural, updateProcedural, deleteProcedural } = useKnowledge();

  const [editing, setEditing] = useState<ProceduralTemplate | null>(null);
  const [creating, setCreating] = useState(false);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <Button onClick={() => setCreating(true)}>
          + New Template
        </Button>
        <span className="text-xs text-muted-foreground">
          {proceduralTemplates.length} template{proceduralTemplates.length !== 1 ? "s" : ""}
        </span>
      </div>

      {proceduralTemplates.length > 0 && (
        <div className="space-y-2 max-w-2xl">
          {proceduralTemplates.map((t) => (
            <div
              key={t.id}
              className="flex items-center justify-between rounded-lg border border-border px-4 py-3"
            >
              <div className="min-w-0 flex-1">
                <span className="text-sm font-medium">{t.name}</span>
                {t.description && (
                  <p className="text-xs text-muted-foreground truncate">{t.description}</p>
                )}
                <span className="text-xs text-muted-foreground/60">
                  {t.category} &middot; Used {t.usageCount} time{t.usageCount !== 1 ? "s" : ""}
                </span>
              </div>
              <div className="flex gap-2 ml-3">
                <button
                  onClick={() => setEditing(t)}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  Edit
                </button>
                <button
                  onClick={() => deleteProcedural(t.id)}
                  className="text-xs text-muted-foreground hover:text-destructive"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {proceduralTemplates.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No templates yet. Create reusable prompt patterns here.
        </p>
      )}

      <ProceduralEditorDialog
        open={creating}
        onClose={() => setCreating(false)}
        template={null}
        onSave={async (data) => {
          await createProcedural(data);
          setCreating(false);
        }}
      />

      <ProceduralEditorDialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        template={editing}
        onSave={async (data) => {
          if (editing) {
            await updateProcedural(editing.id, data);
            setEditing(null);
          }
        }}
      />
    </div>
  );
}

// ── Inline Editor Dialog ──

interface ProceduralEditorDialogProps {
  open: boolean;
  onClose: () => void;
  template: ProceduralTemplate | null;
  onSave: (data: { name: string; description: string; category: string; content: string; tags: string[] }) => Promise<void>;
}

function ProceduralEditorDialog({ open, onClose, template, onSave }: ProceduralEditorDialogProps) {
  const [name, setName] = useState(template?.name ?? "");
  const [description, setDescription] = useState(template?.description ?? "");
  const [category, setCategory] = useState(template?.category ?? "general");
  const [content, setContent] = useState(template?.content ?? "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setName(template?.name ?? "");
    setDescription(template?.description ?? "");
    setCategory(template?.category ?? "general");
    setContent(template?.content ?? "");
  }, [template?.id]);

  async function handleSave() {
    setSaving(true);
    try {
      await onSave({ name, description, category, content, tags: [] });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={template ? "Edit Template" : "New Template"}
    >
      <div className="flex flex-col gap-4">
        <div>
          <label className="mb-1 block text-sm text-muted-foreground">Name</label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Template name" />
        </div>
        <div>
          <label className="mb-1 block text-sm text-muted-foreground">Description</label>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional description" />
        </div>
        <div>
          <label className="mb-1 block text-sm text-muted-foreground">Category</label>
          <Input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="general" />
        </div>
        <div>
          <label className="mb-1 block text-sm text-muted-foreground">Content</label>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={8}
            placeholder="Reusable prompt pattern..."
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none"
          />
        </div>
        <div className="flex gap-2">
          <Button onClick={handleSave} disabled={saving || !name || !content}>
            {template ? "Save" : "Create"}
          </Button>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
        </div>
      </div>
    </Dialog>
  );
}
