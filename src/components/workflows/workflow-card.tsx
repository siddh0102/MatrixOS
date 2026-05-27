import { Card, CardHeader, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { WorkflowDefinition, WorkflowRun } from "@/types";

interface WorkflowCardProps {
  workflow: WorkflowDefinition;
  lastRun: WorkflowRun | null;
  onOpen: () => void;
  onRunNow: () => void;
  onHistory: () => void;
  onDelete: () => void;
}

export function WorkflowCard({ workflow, lastRun, onOpen, onRunNow, onHistory, onDelete }: WorkflowCardProps) {
  const triggerIcons = workflow.triggers
    .filter((t) => t.enabled)
    .map((t) => t.type);

  return (
    <Card className="flex flex-col">
      <CardHeader className="flex-col items-center text-center gap-1">
        <h3 className="font-semibold text-foreground text-center">{workflow.name}</h3>
        <div className="flex items-center justify-center gap-1.5">
          {triggerIcons.includes("scheduled") && (
            <Badge variant="muted">Scheduled</Badge>
          )}
          {triggerIcons.includes("event") && (
            <Badge variant="muted">Event</Badge>
          )}
          {triggerIcons.includes("manual") && (
            <Badge variant="muted">Manual</Badge>
          )}
        </div>
      </CardHeader>
      <CardBody className="flex flex-1 flex-col items-center text-center">
        {workflow.description && (
          <p className="mb-2 line-clamp-2 text-center">{workflow.description}</p>
        )}
        <div className="flex items-center justify-center gap-3 text-xs text-muted-foreground mb-3">
          <span>{workflow.steps.length} steps</span>
          <span>v{workflow.version}</span>
          {lastRun && (
            <span className={lastRun.status === "completed" ? "text-green-500" : lastRun.status === "failed" ? "text-destructive" : ""}>
              Last: {lastRun.status}
            </span>
          )}
        </div>
        <div className="flex items-center justify-center gap-2 mt-auto">
          <Button variant="ghost" size="sm" onClick={onOpen}>Edit</Button>
          <Button variant="ghost" size="sm" onClick={onRunNow}>Run</Button>
          <Button variant="ghost" size="sm" onClick={onHistory}>History</Button>
          <Button variant="ghost" size="sm" onClick={onDelete}>Delete</Button>
        </div>
      </CardBody>
    </Card>
  );
}
