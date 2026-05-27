import { createFileRoute } from "@tanstack/react-router";
import { BulkExportPage } from "@/components/agents/bulk-export-page";

export const Route = createFileRoute("/agents/export")({
  component: BulkExportPage,
});
