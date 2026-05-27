import { createFileRoute } from "@tanstack/react-router";
import { LibraryPage } from "@/components/library/library-page";

export const Route = createFileRoute("/library/")({
  validateSearch: (search: Record<string, unknown>) => {
    const out: { tab?: "agents" | "skills"; from?: string; draft?: string } = {};
    if (search.tab === "agents" || search.tab === "skills") {
      out.tab = search.tab as "agents" | "skills";
    }
    if (typeof search.from === "string" && search.from.length > 0) {
      out.from = search.from;
    }
    if (typeof search.draft === "string" && search.draft.length > 0) {
      out.draft = search.draft;
    }
    return out;
  },
  component: LibraryPage,
});
