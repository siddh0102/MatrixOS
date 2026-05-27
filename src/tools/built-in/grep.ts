import type { BuiltInToolHandler, Tool } from "@/types";

interface GrepMatch {
  file: string;
  line_number: number;
  text: string;
}

interface GrepResult {
  matches: GrepMatch[];
  truncated: boolean;
}

export const GREP_DEFINITION: Omit<Tool, "id"> = {
  serverId: "built-in",
  name: "grep",
  description:
    "Search file contents for a regex (or fixed string) using ripgrep. " +
    "Use for locating where a function/identifier is defined or used across a codebase. " +
    "Returns matches as `file:line: <text>` blocks. " +
    "Respects .gitignore by default. " +
    "Requires `rg` (ripgrep) on PATH; if missing, the tool returns a clear install hint.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description:
          "Regex pattern (or fixed string if fixed_string=true). Use ripgrep syntax.",
      },
      path: {
        type: "string",
        description: "Absolute path to a file or directory to search.",
      },
      max_matches: {
        type: "number",
        description: "Maximum number of matches to return. Default 200, hard cap 2000.",
      },
      case_insensitive: {
        type: "boolean",
        description: "If true, case-insensitive match (rg -i). Default false.",
      },
      fixed_string: {
        type: "boolean",
        description:
          "If true, treat pattern as a literal string instead of a regex (rg -F). Default false.",
      },
      glob: {
        type: "string",
        description:
          "Optional glob filter, e.g. '*.ts' to limit to TypeScript files, '!*.test.*' to exclude tests (rg -g).",
      },
    },
    required: ["pattern", "path"],
  },
  tags: ["built-in", "filesystem", "search"],
};

export const grepHandler: BuiltInToolHandler = async (args) => {
  const pattern = args["pattern"];
  const path = args["path"];
  const maxMatches = args["max_matches"];
  const caseInsensitive = args["case_insensitive"];
  const fixedString = args["fixed_string"];
  const glob = args["glob"];

  if (typeof pattern !== "string" || !pattern) {
    throw new Error("Missing required argument: pattern (string)");
  }
  if (typeof path !== "string" || !path) {
    throw new Error("Missing required argument: path (string)");
  }

  const { invoke } = await import("@tauri-apps/api/core");
  const result = await invoke<GrepResult>("code_grep", {
    args: {
      pattern,
      path,
      maxMatches,
      caseInsensitive,
      fixedString,
      glob,
    },
  });

  const header = `[${result.matches.length}${result.truncated ? " (truncated)" : ""} match${
    result.matches.length === 1 ? "" : "es"
  }]`;
  if (result.matches.length === 0) {
    return header;
  }
  const body = result.matches
    .map((m) => `${m.file}:${m.line_number}: ${m.text}`)
    .join("\n");
  return header + "\n" + body;
};
