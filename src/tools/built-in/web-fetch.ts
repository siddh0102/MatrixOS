import type { BuiltInToolHandler, Tool } from "@/types";
import { nanoid } from "nanoid";

export const WEB_FETCH_DEFINITION: Omit<Tool, "id"> = {
  serverId: "built-in",
  name: "web_fetch",
  description:
    "Fetch the text content of a URL via HTTP GET. Returns the response body as a string (truncated at 256 KB). Only text-based content types are supported.",
  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description:
          "The URL to fetch (must start with http:// or https://)",
      },
    },
    required: ["url"],
  },
  tags: ["built-in", "web"],
};

export const webFetchHandler: BuiltInToolHandler = async (args, ctx) => {
  const url = args["url"];
  if (typeof url !== "string" || !url) {
    throw new Error("Missing required argument: url (string)");
  }
  const { invoke } = await import("@tauri-apps/api/core");
  const requestId = nanoid();
  const resp = await invoke<{
    status: number;
    contentType: string;
    truncated: boolean;
    body: string;
  }>("web_fetch", { ctx: ctx.callContext, url, requestId });
  return JSON.stringify(resp);
};
