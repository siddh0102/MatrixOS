import type { BuiltInToolHandler, Tool } from "@/types";

export const WRITE_FILE_DEFINITION: Omit<Tool, "id"> = {
  serverId: "built-in",
  name: "write_file",
  description:
    "Write text content to a local file. Creates parent directories if needed. Overwrites the file if it already exists.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Absolute path to the file to write",
      },
      contents: {
        type: "string",
        description: "UTF-8 text content to write to the file",
      },
    },
    required: ["path", "contents"],
  },
  tags: ["built-in", "filesystem"],
};

export const writeFileHandler: BuiltInToolHandler = async (args, ctx) => {
  const path = args["path"];
  const contents = args["contents"];
  if (typeof path !== "string" || !path) {
    throw new Error("Missing required argument: path (string)");
  }
  if (typeof contents !== "string") {
    throw new Error("Missing required argument: contents (string)");
  }
  const { invoke } = await import("@tauri-apps/api/core");
  const written = await invoke<number>("fs_write", {
    ctx: ctx.callContext,
    path,
    contents,
  });
  return `Wrote ${written} bytes to ${path}`;
};
