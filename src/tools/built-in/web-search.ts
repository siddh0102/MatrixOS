import type { BuiltInToolHandler, Tool } from "@/types";

interface TavilyResult {
  title: string;
  url: string;
  content: string;
  score: number;
}

export const WEB_SEARCH_DEFINITION: Omit<Tool, "id"> = {
  serverId: "built-in",
  name: "web_search",
  description:
    "Search the web via the Tavily API. Returns the top results as " +
    "`[{title, url, content}]` — `content` is a cleaned, relevant extract of " +
    "the page, so you often do NOT need a separate web_fetch. Requires a Tavily " +
    "API key configured in Settings.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The search query. Plain text.",
      },
      max_results: {
        type: "number",
        description: "Maximum number of results to return. Default 5, hard cap 20.",
      },
    },
    required: ["query"],
  },
  tags: ["built-in", "web", "search"],
};

export const webSearchHandler: BuiltInToolHandler = async (args) => {
  const query = args["query"];
  const maxRequested = args["max_results"];

  if (typeof query !== "string" || !query.trim()) {
    throw new Error("Missing required argument: query (non-empty string)");
  }
  const maxResults = Math.min(
    typeof maxRequested === "number" && maxRequested > 0 ? maxRequested : 5,
    20,
  );

  const { invoke } = await import("@tauri-apps/api/core");
  let results: TavilyResult[];
  try {
    results = await invoke<TavilyResult[]>("tavily_search", {
      query: query.trim(),
      maxResults,
    });
  } catch (err) {
    // RustError objects aren't Error instances; pull code/message out.
    const e = err as { code?: string; message?: string };
    if (e?.code === "AUTH_MISSING") {
      return "[web_search not configured] No Tavily API key set. Add one in Settings → Observability, then retry.";
    }
    throw new Error(`web_search failed: ${e?.message ?? String(err)}`);
  }

  if (results.length === 0) {
    return `[0 results for "${query}"]`;
  }

  const header = `[${results.length} result${results.length === 1 ? "" : "s"} for "${query}"]`;
  const body = results
    .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.content.slice(0, 500)}`)
    .join("\n\n");
  return header + "\n" + body;
};
