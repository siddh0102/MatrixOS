import { createFileRoute } from "@tanstack/react-router";
import { RunHistoryPage } from "@/components/workflows/run-history-page";

export const Route = createFileRoute("/workflows/$id/history")({
  component: RunHistoryPage,
  validateSearch: (search: Record<string, unknown>): { runId?: string } => {
    if (typeof search.runId === "string") return { runId: search.runId };
    return {};
  },
});
