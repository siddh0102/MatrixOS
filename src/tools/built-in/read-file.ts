import type { BuiltInToolHandler, Tool } from "@/types";

export const READ_FILE_DEFINITION: Omit<Tool, "id"> = {
  serverId: "built-in",
  name: "read_file",
  description:
    "Read the contents of a local file. Returns the file content as a UTF-8 string.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Absolute path to the file to read",
      },
    },
    required: ["path"],
  },
  tags: ["built-in", "filesystem"],
};

export const readFileHandler: BuiltInToolHandler = async (args, ctx) => {
  const path = args["path"];
  if (typeof path !== "string" || !path) {
    throw new Error("Missing required argument: path (string)");
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("fs_read", { ctx: ctx.callContext, path });
};
