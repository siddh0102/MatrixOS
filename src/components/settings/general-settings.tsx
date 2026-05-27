import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSettings } from "@/hooks/use-settings";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Tabs } from "@/components/ui/tabs";
import { AuditLogViewer } from "./audit-log-viewer";
import { EmbeddingSettingsSection } from "./embedding-settings-section";
import { ObservabilitySettings } from "./observability-settings";
import { dbSelect } from "@/kernel/ipc-bridge";

const SHORTCUT_TABS = [
  { id: "preferences", label: "Preferences" },
  { id: "embeddings", label: "Embeddings" },
  { id: "observability", label: "Observability" },
  { id: "audit", label: "Audit Log" },
];

export function GeneralSettings() {
  const { load, save } = useSettings();
  const [theme, setTheme] = useState("system");
  const [loaded, setLoaded] = useState(false);
  const [activeTab, setActiveTab] = useState("preferences");
  const [runInBackground, setRunInBackground] = useState<boolean>(false);
  const [bgLoading, setBgLoading] = useState(true);

  useEffect(() => {
    load("theme", "system").then((t) => {
      setTheme(t as string);
      setLoaded(true);
    });
  }, [load]);

  useEffect(() => {
    (async () => {
      try {
        const rows = await dbSelect<{ value_json: string }>(
          "SELECT value_json FROM preferences WHERE agent_id = '__global__' AND key = ?",
          ["general.runInBackground"],
        );
        if (rows.length > 0) {
          try {
            const v = JSON.parse(rows[0].value_json);
            setRunInBackground(v === true);
          } catch {}
        }
      } finally {
        setBgLoading(false);
      }
    })();
  }, []);

  async function handleThemeChange(value: string) {
    setTheme(value);
    await save("theme", value);
  }

  async function handleRunInBackgroundToggle(next: boolean) {
    setRunInBackground(next);
    try {
      await invoke("pref_set", {
        ctx: { type: "User" },
        key: "general.runInBackground",
        valueJson: JSON.stringify(next),
      });
    } catch (e) {
      console.error("pref_set failed:", e);
      setRunInBackground(!next);
    }
  }

  if (!loaded) return null;

  return (
    <div className="flex flex-1 flex-col overflow-auto p-6">
      <Tabs
        tabs={SHORTCUT_TABS}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        className="flex-1"
      >
        {activeTab === "preferences" && (
          <div className="max-w-lg flex flex-col gap-6">
            <div>
              <label className="mb-1 block text-sm font-medium">
                Theme
              </label>
              <Select
                value={theme}
                onChange={(e) => handleThemeChange(e.target.value)}
              >
                <option value="system">System</option>
                <option value="dark">Dark</option>
                <option value="light">Light</option>
              </Select>
            </div>

            <div className="flex items-center justify-between gap-4 py-2">
              <div className="min-w-0">
                <div className="text-sm font-medium">Keep MatrixOS running when window is closed</div>
                <div className="text-xs text-muted-foreground">
                  When ON, closing the window hides MatrixOS to the system tray and creates a hidden
                  background window at startup. When OFF, scheduled jobs still work via lazy window
                  creation on first save. Takes full effect on next launch.
                </div>
              </div>
              <input
                type="checkbox"
                checked={runInBackground}
                disabled={bgLoading}
                onChange={(e) => handleRunInBackgroundToggle(e.target.checked)}
                className="h-4 w-4 shrink-0"
              />
            </div>

            <div>
              <h2 className="mb-2 text-sm font-medium">
                Keyboard Shortcuts
              </h2>
              <div className="rounded-lg border border-border bg-card p-3 text-sm">
                <table className="w-full">
                  <tbody className="divide-y divide-border">
                    <tr>
                      <td className="py-1.5 text-muted-foreground">New Agent</td>
                      <td className="py-1.5 text-right font-mono text-xs">Ctrl+Shift+N</td>
                    </tr>
                    <tr>
                      <td className="py-1.5 text-muted-foreground">New Tab</td>
                      <td className="py-1.5 text-right font-mono text-xs">Alt+N / Alt+T</td>
                    </tr>
                    <tr>
                      <td className="py-1.5 text-muted-foreground">Close Tab</td>
                      <td className="py-1.5 text-right font-mono text-xs">Alt+W</td>
                    </tr>
                    <tr>
                      <td className="py-1.5 text-muted-foreground">Next Tab</td>
                      <td className="py-1.5 text-right font-mono text-xs">Alt+.</td>
                    </tr>
                    <tr>
                      <td className="py-1.5 text-muted-foreground">Previous Tab</td>
                      <td className="py-1.5 text-right font-mono text-xs">Alt+,</td>
                    </tr>
                    <tr>
                      <td className="py-1.5 text-muted-foreground">Jump to Tab 1–9</td>
                      <td className="py-1.5 text-right font-mono text-xs">Ctrl+1–9</td>
                    </tr>
                    <tr>
                      <td className="py-1.5 text-muted-foreground">Focus Chat Input</td>
                      <td className="py-1.5 text-right font-mono text-xs">Ctrl+/</td>
                    </tr>
                    <tr>
                      <td className="py-1.5 text-muted-foreground">Toggle Sidebar</td>
                      <td className="py-1.5 text-right font-mono text-xs">Ctrl+B</td>
                    </tr>
                    <tr>
                      <td className="py-1.5 text-muted-foreground">Settings</td>
                      <td className="py-1.5 text-right font-mono text-xs">Ctrl+,</td>
                    </tr>
                    <tr>
                      <td className="py-1.5 text-muted-foreground">Send Message</td>
                      <td className="py-1.5 text-right font-mono text-xs">Enter</td>
                    </tr>
                    <tr>
                      <td className="py-1.5 text-muted-foreground">Close Dialog</td>
                      <td className="py-1.5 text-right font-mono text-xs">Escape</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <div>
              <h2 className="mb-2 text-sm font-medium">Data</h2>
              <Button variant="ghost">Export Conversations</Button>
            </div>
          </div>
        )}

        {activeTab === "embeddings" && <EmbeddingSettingsSection />}

        {activeTab === "observability" && <ObservabilitySettings />}

        {activeTab === "audit" && <AuditLogViewer />}
      </Tabs>
    </div>
  );
}
