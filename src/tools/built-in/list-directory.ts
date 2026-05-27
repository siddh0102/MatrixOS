import type { BuiltInToolHandler, Tool } from "@/types";

export const LIST_DIRECTORY_DEFINITION: Omit<Tool, "id"> = {
  serverId: "built-in",
  name: "list_directory",
  description:
    "List the files and subdirectories at a given absolute path. Directories appear first; entries are sorted case-insensitively by name. Returns a JSON array of { name, isDir, size }.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Absolute path to the directory to list",
      },
    },
    required: ["path"],
  },
  tags: ["built-in", "filesystem"],
};

interface DirEntry {
  name: string;
  isDir: boolean;
  size: number;
}

export const listDirectoryHandler: BuiltInToolHandler = async (args, ctx) => {
  const path = args["path"];
  if (typeof path !== "string" || !path) {
    throw new Error("Missing required argument: path (string)");
  }
  const { invoke } = await import("@tauri-apps/api/core");
  const entries = await invoke<DirEntry[]>("fs_list", {
    ctx: ctx.callContext,
    path,
  });
  return JSON.stringify(entries);
};
