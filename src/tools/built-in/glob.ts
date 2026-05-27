import type { BuiltInToolHandler, Tool } from "@/types";

interface GlobResult {
  matches: string[];
  truncated: boolean;
  base_dir: string;
}

export const GLOB_DEFINITION: Omit<Tool, "id"> = {
  serverId: "built-in",
  name: "glob",
  description:
    "Find filenames matching a glob pattern, recursively, under a base directory. " +
    "Use for locating files by name (e.g. `src/**/*.tsx`, `**/Cargo.toml`, `tests/**/test_*.py`). " +
    "Returns absolute paths sorted lexicographically. By default returns up to 1000 matches; raise via `max_results` (hard cap 10000). " +
    "Directories are excluded unless `include_dirs: true`. Symlinks are not followed.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description:
          "Glob pattern. Supports `*`, `**`, `?`, `[abc]`, `{a,b}`. Examples: `src/**/*.ts`, `**/*.{js,jsx}`.",
      },
      base_dir: {
        type: "string",
        description:
          "Absolute path to the directory to walk. Pattern is resolved relative to this.",
      },
      max_results: {
        type: "number",
        description: "Maximum number of paths to return. Default 1000, hard cap 10000.",
      },
      include_dirs: {
        type: "boolean",
        description:
          "If true, directory entries are included in results. Default false (files only).",
      },
    },
    required: ["pattern", "base_dir"],
  },
  tags: ["built-in", "filesystem", "search"],
};

export const globHandler: BuiltInToolHandler = async (args) => {
  const pattern = args["pattern"];
  const baseDir = args["base_dir"];
  const maxResults = args["max_results"];
  const includeDirs = args["include_dirs"];

  if (typeof pattern !== "string" || !pattern) {
    throw new Error("Missing required argument: pattern (string)");
  }
  if (typeof baseDir !== "string" || !baseDir) {
    throw new Error("Missing required argument: base_dir (string)");
  }
  if (maxResults !== undefined && typeof maxResults !== "number") {
    throw new Error("Invalid argument: max_results (number, optional)");
  }
  if (includeDirs !== undefined && typeof includeDirs !== "boolean") {
    throw new Error("Invalid argument: include_dirs (boolean, optional)");
  }

  const { invoke } = await import("@tauri-apps/api/core");
  const result = await invoke<GlobResult>("fs_glob", {
    args: {
      pattern,
      baseDir,
      maxResults,
      includeDirs,
    },
  });

  const header = `[${result.matches.length}${result.truncated ? " (truncated)" : ""} match${
    result.matches.length === 1 ? "" : "es"
  } under ${result.base_dir}]`;
  if (result.matches.length === 0) {
    return header;
  }
  return header + "\n" + result.matches.join("\n");
};
