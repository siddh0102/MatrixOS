import { createFileRoute } from "@tanstack/react-router";
import { WorkflowListPage } from "@/components/workflows/workflow-list-page";

export const Route = createFileRoute("/workflows/")({
  component: WorkflowListPage,
});
