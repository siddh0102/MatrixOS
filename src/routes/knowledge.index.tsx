import { createFileRoute } from "@tanstack/react-router";
import { KnowledgePage } from "@/components/knowledge/knowledge-page";

export const Route = createFileRoute("/knowledge/")({
  component: KnowledgePage,
});
