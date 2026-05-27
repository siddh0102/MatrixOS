import { createFileRoute } from "@tanstack/react-router";
import { AgentEditorPage } from "@/components/agents/agent-editor-page";

export const Route = createFileRoute("/agents/$id/edit")({
  component: AgentEditorPage,
});
