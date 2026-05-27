import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ImportedSkill } from "@/types";

interface SkillCardProps {
  skill: ImportedSkill;
  hasUpdate: boolean;
  isCustom: boolean;
  onEdit: () => void;
  onAttachToAgents: () => void;
  onDelete: () => void;
  onApplyUpdate?: () => void;
  // From-agent context (rendered when navigated to library from an agent editor)
  fromAgentName?: string;
  attachedToFromAgent?: boolean;
  onAddToFromAgent?: () => void;
}

export function SkillCard({
  skill,
  hasUpdate,
  isCustom,
  onEdit,
  onAttachToAgents,
  onDelete,
  onApplyUpdate,
  fromAgentName,
  attachedToFromAgent,
  onAddToFromAgent,
}: SkillCardProps) {
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-medium truncate flex-1">{skill.name}</h3>
        <Badge variant="muted">{skill.category}</Badge>
        {isCustom && <Badge variant="muted">Custom</Badge>}
        {hasUpdate && <Badge variant="warning">Update Available</Badge>}
      </div>
      <p
        className="text-xs text-muted-foreground leading-relaxed overflow-hidden"
        style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}
      >
        {skill.description}
      </p>
      {skill.tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {skill.tags.map((tag) => (
            <span
              key={tag}
              className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground"
            >
              {tag}
            </span>
          ))}
        </div>
      )}
      <div className="flex flex-wrap gap-2 mt-auto">
        {fromAgentName && onAddToFromAgent && (
          <Button
            onClick={onAddToFromAgent}
            disabled={attachedToFromAgent}
            variant={attachedToFromAgent ? "ghost" : "primary"}
            className="flex-1"
          >
            {attachedToFromAgent ? "Added" : "Add"}
          </Button>
        )}
        {hasUpdate && onApplyUpdate && (
          <Button onClick={onApplyUpdate} variant="secondary">
            Update
          </Button>
        )}
        <Button variant="ghost" onClick={onAttachToAgents}>
          Attach to agents…
        </Button>
        <Button variant="ghost" onClick={onEdit}>
          Edit
        </Button>
        <Button
          variant="ghost"
          onClick={onDelete}
          className="text-muted-foreground hover:text-destructive"
        >
          Delete
        </Button>
      </div>
    </Card>
  );
}
