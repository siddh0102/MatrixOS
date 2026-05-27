import { createFileRoute } from "@tanstack/react-router";
import { AgentListPage } from "@/components/agents/agent-list-page";

export const Route = createFileRoute("/agents/")({
  component: AgentListPage,
});
