import { createFileRoute } from "@tanstack/react-router";
import { WorkflowEditorPage } from "@/components/workflows/workflow-editor-page";

export const Route = createFileRoute("/workflows/$id/")({
  component: WorkflowEditorPage,
});
