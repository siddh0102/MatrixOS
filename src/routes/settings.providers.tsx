import { createFileRoute } from "@tanstack/react-router";
import { ProviderSettings } from "@/components/settings/provider-settings";

export const Route = createFileRoute("/settings/providers")({
  component: ProviderSettings,
});
