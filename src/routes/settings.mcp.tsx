import { createFileRoute } from "@tanstack/react-router";
import { MCPSettings } from "@/components/settings/mcp-settings";

export const Route = createFileRoute("/settings/mcp")({
  component: MCPSettings,
});
