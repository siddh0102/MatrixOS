import {
  Outlet,
  createFileRoute,
  useLocation,
  useNavigate,
} from "@tanstack/react-router";
import { Tabs } from "@/components/ui/tabs";

const SETTINGS_TABS = [
  { id: "providers", label: "Connections" },
  { id: "mcp", label: "MCP" },
  { id: "general", label: "General" },
] as const;

type SettingsTabId = (typeof SETTINGS_TABS)[number]["id"];

function SettingsLayout() {
  const location = useLocation();
  const navigate = useNavigate();

  const activeTab: SettingsTabId =
    SETTINGS_TABS.find((t) => location.pathname.startsWith(`/settings/${t.id}`))
      ?.id ?? "providers";

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="border-b border-border px-6 pt-6">
        <h1 className="mb-4 text-center text-xl font-semibold">Settings</h1>
        <Tabs
          tabs={[...SETTINGS_TABS]}
          activeTab={activeTab}
          onTabChange={(id) =>
            navigate({ to: `/settings/${id}` as "/settings/providers" })
          }
        >
          {null}
        </Tabs>
      </div>
      <div className="flex flex-1 flex-col overflow-auto">
        <Outlet />
      </div>
    </div>
  );
}

export const Route = createFileRoute("/settings")({
  component: SettingsLayout,
});
