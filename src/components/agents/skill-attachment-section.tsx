import { useNavigate } from "@tanstack/react-router";
import { useLibraryStore } from "@/stores/library-store";
import { Button } from "@/components/ui/button";

interface SkillAttachmentSectionProps {
  selectedSkillIds: string[];
  onToggle: (skillId: string) => void;
  onReorder: (skillIds: string[]) => void;
  onEdit: (skillId: string) => void;
  agentId?: string;
  draftKey?: string;
}

export function SkillAttachmentSection({
  selectedSkillIds,
  onToggle,
  onReorder,
  onEdit,
  agentId,
  draftKey,
}: SkillAttachmentSectionProps) {
  const navigate = useNavigate();
  const importedSkills = useLibraryStore((s) => s.importedSkills);

  const librarySearch = agentId
    ? { tab: "skills" as const, from: agentId }
    : draftKey
      ? { tab: "skills" as const, draft: draftKey }
      : { tab: "skills" as const };

  if (importedSkills.length === 0) {
    return (
      <div>
        <label className="mb-2 block text-sm text-muted-foreground">Skills</label>
        <p className="mb-2 text-xs text-muted-foreground/70">No skills imported yet.</p>
        <Button
          variant="ghost"
          onClick={() => navigate({ to: "/library", search: librarySearch })}
        >
          Browse Library
        </Button>
      </div>
    );
  }

  const selectedSkills = selectedSkillIds
    .map((id) => importedSkills.find((s) => s.id === id))
    .filter(Boolean) as typeof importedSkills;

  function handleMoveUp(index: number) {
    if (index === 0) return;
    const newIds = [...selectedSkillIds];
    [newIds[index - 1], newIds[index]] = [newIds[index], newIds[index - 1]];
    onReorder(newIds);
  }

  function handleMoveDown(index: number) {
    if (index >= selectedSkillIds.length - 1) return;
    const newIds = [...selectedSkillIds];
    [newIds[index], newIds[index + 1]] = [newIds[index + 1], newIds[index]];
    onReorder(newIds);
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <label className="text-sm text-muted-foreground">Skills</label>
        <Button
          variant="ghost"
          className="text-xs"
          onClick={() => navigate({ to: "/library", search: librarySearch })}
        >
          Manage Skills
        </Button>
      </div>

      {selectedSkills.length > 0 ? (
        <div className="space-y-1.5">
          <span className="text-xs text-muted-foreground/60">
            Attached (order = prompt composition order):
          </span>
          {selectedSkills.map((skill, idx) => (
            <div key={skill.id} className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-1.5">
              <span className="flex-1 text-sm truncate">{skill.name}</span>
              <button
                type="button"
                onClick={() => handleMoveUp(idx)}
                disabled={idx === 0}
                className="rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
                title="Move up"
              >
                ↑
              </button>
              <button
                type="button"
                onClick={() => handleMoveDown(idx)}
                disabled={idx === selectedSkills.length - 1}
                className="rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
                title="Move down"
              >
                ↓
              </button>
              <button
                type="button"
                onClick={() => onEdit(skill.id)}
                className="rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                title="Edit skill"
              >
                Edit
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onToggle(skill.id);
                }}
                className="rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                title="Remove from agent"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground/70">
          No skills attached. Use Manage Skills to attach skills to this agent.
        </p>
      )}
    </div>
  );
}
