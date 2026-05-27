import { useState, useEffect } from "react";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import type { ImportedSkill } from "@/types";

interface SkillEditorDialogProps {
  open: boolean;
  onClose: () => void;
  skill: ImportedSkill | null;
  onSave: (id: string, updates: { name: string; prompt: string }) => Promise<void>;
  onReset: ((id: string) => Promise<void>) | null;
}

export function SkillEditorDialog({
  open,
  onClose,
  skill,
  onSave,
  onReset,
}: SkillEditorDialogProps) {
  const isCreateMode = skill === null;
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (skill) {
      setName(skill.name);
      setPrompt(skill.prompt);
    } else if (open) {
      setName("");
      setPrompt("");
    }
  }, [skill, open]);

  async function handleSave() {
    setSaving(true);
    try {
      await onSave(skill?.id ?? "", { name, prompt });
      onClose();
    } finally {
      setSaving(false);
    }
  }

  async function handleReset() {
    if (!skill || !onReset) return;
    setSaving(true);
    try {
      await onReset(skill.id);
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title={isCreateMode ? "Create Custom Skill" : "Edit Skill"}>
      <div className="flex flex-col gap-4">
        <div>
          <label className="mb-1 block text-sm text-muted-foreground">Name</label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. My Custom Skill"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm text-muted-foreground">Prompt</label>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={8}
            placeholder="System prompt snippet that will be appended to the agent's base prompt..."
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none"
          />
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={handleSave} disabled={saving || !name || !prompt}>
            {isCreateMode ? "Create" : "Save"}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {onReset && skill?.sourceTemplateId && (
            <Button
              variant="ghost"
              onClick={handleReset}
              disabled={saving}
              className="ml-auto text-muted-foreground"
            >
              Reset to Catalog Default
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
