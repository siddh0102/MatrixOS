import { useEffect, useState } from "react";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import type { LibraryAgentTemplate, LibraryIconType } from "@/types";

const ICON_OPTIONS: LibraryIconType[] = [
  "assistant",
  "code",
  "research",
  "writing",
  "orchestrator",
  "data",
  "devops",
  "support",
  "review",
  "creative",
];

interface AgentTemplateEditorDialogProps {
  open: boolean;
  onClose: () => void;
  // Pre-existing template when editing; null when creating.
  template: LibraryAgentTemplate | null;
  knownCategories: string[];
  onSave: (template: LibraryAgentTemplate) => Promise<void>;
}

export function AgentTemplateEditorDialog({
  open,
  onClose,
  template,
  knownCategories,
  onSave,
}: AgentTemplateEditorDialogProps) {
  const isCreate = template === null;
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [temperature, setTemperature] = useState(0.7);
  const [maxTokens, setMaxTokens] = useState(4096);
  const [maxHistory, setMaxHistory] = useState(50);
  const [icon, setIcon] = useState<LibraryIconType>("assistant");
  const [tagsInput, setTagsInput] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (template) {
      setName(template.name);
      setDescription(template.description);
      setCategory(template.category);
      setSystemPrompt(template.systemPrompt);
      setTemperature(template.temperature);
      setMaxTokens(template.maxTokens);
      setMaxHistory(template.maxConversationHistory);
      setIcon(template.icon);
      setTagsInput(template.tags.join(", "));
    } else {
      setName("");
      setDescription("");
      setCategory(knownCategories[0] ?? "general");
      setSystemPrompt("You are a helpful AI assistant.");
      setTemperature(0.7);
      setMaxTokens(4096);
      setMaxHistory(50);
      setIcon("assistant");
      setTagsInput("");
    }
  }, [open, template, knownCategories]);

  async function handleSave() {
    if (!name.trim() || !systemPrompt.trim() || !category.trim()) return;
    const tags = tagsInput
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const id = template?.id ?? slugify(name) + "-" + Math.random().toString(36).slice(2, 8);
    const next: LibraryAgentTemplate = {
      id,
      name: name.trim(),
      description: description.trim(),
      category: category.trim(),
      systemPrompt,
      temperature,
      maxTokens,
      maxConversationHistory: maxHistory,
      icon,
      tags,
      author: template?.author ?? "user",
      version: template?.version ?? "1.0",
      suggestedSkillIds: template?.suggestedSkillIds ?? [],
      sortOrder: template?.sortOrder ?? 1000,
    };
    setSaving(true);
    try {
      await onSave(next);
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={isCreate ? "Create Agent Template" : "Edit Agent Template"}
      className="max-w-2xl"
    >
      <div className="flex flex-col gap-4">
        <div>
          <label className="mb-1 block text-sm text-muted-foreground">Name</label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Backend Architect"
          />
        </div>

        <div>
          <label className="mb-1 block text-sm text-muted-foreground">Description</label>
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="One-sentence summary that appears on the card"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-sm text-muted-foreground">Category</label>
            <Input
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              list="agent-template-categories"
              placeholder="e.g. Backend Design"
            />
            <datalist id="agent-template-categories">
              {knownCategories.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </div>
          <div>
            <label className="mb-1 block text-sm text-muted-foreground">Icon</label>
            <select
              value={icon}
              onChange={(e) => setIcon(e.target.value as LibraryIconType)}
              className="h-9 w-full rounded-lg border border-border bg-background px-3 text-sm focus:border-primary focus:outline-none"
            >
              {ICON_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label className="mb-1 block text-sm text-muted-foreground">System Prompt</label>
          <textarea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            rows={10}
            placeholder="The full system prompt for agents created from this template."
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none"
          />
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="mb-1 block text-sm text-muted-foreground">
              Temperature ({temperature.toFixed(2)})
            </label>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={temperature}
              onChange={(e) => setTemperature(Number(e.target.value))}
              className="w-full"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm text-muted-foreground">Max Tokens</label>
            <Input
              type="number"
              min={0}
              value={String(maxTokens)}
              onChange={(e) => setMaxTokens(Number(e.target.value) || 0)}
            />
            <p className="mt-1 text-center text-xs text-muted-foreground">
              0 = let the model decide
            </p>
          </div>
          <div>
            <label className="mb-1 block text-sm text-muted-foreground">Max History</label>
            <Input
              type="number"
              value={String(maxHistory)}
              onChange={(e) => setMaxHistory(Number(e.target.value) || 0)}
            />
          </div>
        </div>

        <div>
          <label className="mb-1 block text-sm text-muted-foreground">
            Tags (comma-separated)
          </label>
          <Input
            value={tagsInput}
            onChange={(e) => setTagsInput(e.target.value)}
            placeholder="backend, architecture, api"
          />
        </div>

        <div className="flex items-center gap-2">
          <Button
            onClick={handleSave}
            disabled={saving || !name.trim() || !systemPrompt.trim() || !category.trim()}
          >
            {isCreate ? "Create Template" : "Save"}
          </Button>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}
