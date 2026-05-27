import { Card, CardHeader, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { AgentConfig } from "@/types";
import { truncate } from "@/lib/utils";

interface AgentCardProps {
  config: AgentConfig;
  /** True when this agent is the one in the currently focused tab. Visual hint only. */
  isCurrent?: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onOpen: () => void;
}

export function AgentCard({
  config,
  isCurrent = false,
  onEdit,
  onDelete,
  onOpen,
}: AgentCardProps) {
  return (
    <Card className={`h-[160px] w-full flex flex-col overflow-hidden ${isCurrent ? "border-primary" : ""}`}>
      <CardHeader className="flex-col items-center text-center gap-1.5 min-w-0 w-full">
        <h3 className="w-full truncate font-semibold text-foreground">
          {truncate(config.name, 30)}
        </h3>
        <div className="flex w-full min-w-0 items-center justify-center gap-1.5">
          {isCurrent && <Badge variant="success">In focus</Badge>}
          <Badge variant="muted" className="min-w-0 truncate">
            {config.modelId}
          </Badge>
        </div>
      </CardHeader>
      <CardBody className="flex min-h-0 flex-1 flex-col items-center text-center">
        {config.description && (
          <p className="mb-3 line-clamp-2 w-full">{truncate(config.description, 120)}</p>
        )}
        <div className="flex items-center justify-center gap-2 mt-auto">
          <Button variant="ghost" size="sm" onClick={onOpen}>
            Open
          </Button>
          <Button variant="ghost" size="sm" onClick={onEdit}>
            Edit
          </Button>
          <Button variant="ghost" size="sm" onClick={onDelete}>
            Delete
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}
