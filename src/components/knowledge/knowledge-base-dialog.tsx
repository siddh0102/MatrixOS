import { useState, useEffect } from "react";
import type { KnowledgeBase } from "@/types";

interface KnowledgeBaseDialogProps {
  open: boolean;
  onClose: () => void;
  kb?: KnowledgeBase;
  onSave: (name: string, description: string) => Promise<void>;
}

export function KnowledgeBaseDialog({ open, onClose, kb, onSave }: KnowledgeBaseDialogProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setName(kb?.name ?? "");
      setDescription(kb?.description ?? "");
    }
  }, [open, kb]);

  if (!open) return null;

  async function handleSave() {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await onSave(name.trim(), description.trim());
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-xl border border-border bg-card shadow-xl p-6 space-y-4">
        <h2 className="text-base font-semibold">
          {kb ? "Edit Knowledge Base" : "New Knowledge Base"}
        </h2>

        <div className="space-y-1">
          <label className="text-sm font-medium">Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Company Docs"
            className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
            autoFocus
          />
        </div>

        <div className="space-y-1">
          <label className="text-sm font-medium">Description</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            placeholder="Optional description"
            className="w-full resize-none rounded-lg border border-input bg-background px-3 py-2 text-sm"
          />
        </div>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-sm border border-border hover:bg-muted transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !name.trim()}
            className="rounded-lg px-4 py-2 text-sm bg-primary text-primary-foreground disabled:opacity-50 hover:bg-primary-hover transition-colors"
          >
            {saving ? "Saving…" : kb ? "Save" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
