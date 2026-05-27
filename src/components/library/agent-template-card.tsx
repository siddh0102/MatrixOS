import { useNavigate } from "@tanstack/react-router";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LibraryTemplateIcon } from "./library-template-icons";
import type { LibraryAgentTemplate } from "@/types";

interface AgentTemplateCardProps {
  template: LibraryAgentTemplate;
}

export function AgentTemplateCard({ template }: AgentTemplateCardProps) {
  const navigate = useNavigate();

  function handleUse() {
    navigate({
      to: "/agents/new",
      search: { templateId: template.id },
    });
  }

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary-muted">
          <LibraryTemplateIcon icon={template.icon} />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-medium truncate">{template.name}</h3>
          <Badge variant="muted">{template.category}</Badge>
        </div>
      </div>
      <p
        className="text-xs text-muted-foreground leading-relaxed overflow-hidden"
        style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}
      >
        {template.description}
      </p>
      {template.tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {template.tags.map((tag) => (
            <span
              key={tag}
              className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground"
            >
              {tag}
            </span>
          ))}
        </div>
      )}
      <Button onClick={handleUse} className="mt-auto">
        Use Template
      </Button>
    </Card>
  );
}
