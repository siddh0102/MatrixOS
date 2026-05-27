import { createFileRoute } from "@tanstack/react-router";
import { AgentEditorPage } from "@/components/agents/agent-editor-page";

export const Route = createFileRoute("/agents/new")({
  validateSearch: (search: Record<string, unknown>) => {
    if (typeof search.templateId === "string") {
      return { templateId: search.templateId };
    }
    return {} as { templateId?: string };
  },
  component: AgentEditorPage,
});
