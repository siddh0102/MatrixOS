import type { BuiltInToolHandler, Tool } from "@/types";

export const CURRENT_DATETIME_DEFINITION: Omit<Tool, "id"> = {
  serverId: "built-in",
  name: "current_datetime",
  description:
    "Get the current local date and time. Returns an ISO 8601 timestamp plus the system timezone. Use this when you need to know what time it is right now or compute relative times like 'tomorrow' or 'in 3 hours'.",
  inputSchema: {
    type: "object",
    properties: {},
  },
  tags: ["built-in", "system"],
};

export const currentDatetimeHandler: BuiltInToolHandler = async (_args, _ctx) => {
  const now = new Date();
  return JSON.stringify({
    iso: now.toISOString(),
    local: now.toString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    epochMs: now.getTime(),
  });
};
