import { useState, useEffect, useCallback } from "react";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { getPreference, setPreference } from "@/memory/preferences-store";
import { setProviderApiKey, hasProviderApiKey } from "@/kernel/secure-store";
import { OTEL_ENDPOINT_PREF } from "@/orchestration/otel-bridge";
import { reloadAlertRules } from "@/orchestration/alert-engine";
import {
  listAlertRules,
  createAlertRule,
  deleteAlertRule,
  setAlertRuleEnabled,
} from "@/memory/alert-store-sql";
import type { AlertRule } from "@/types";

export function ObservabilitySettings() {
  const [endpoint, setEndpoint] = useState("");
  const [savedEndpoint, setSavedEndpoint] = useState("");
  const [tavilyKey, setTavilyKey] = useState("");
  const [tavilyConfigured, setTavilyConfigured] = useState(false);
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [name, setName] = useState("");
  const [eventType, setEventType] = useState("");
  const [action, setAction] = useState<"toast" | "notify">("toast");

  const loadRules = useCallback(() => {
    listAlertRules().then(setRules).catch(() => {});
  }, []);

  useEffect(() => {
    getPreference<string>(OTEL_ENDPOINT_PREF).then((v) => {
      setEndpoint(v ?? "");
      setSavedEndpoint(v ?? "");
    });
    hasProviderApiKey("tavily").then(setTavilyConfigured).catch(() => {});
    loadRules();
  }, [loadRules]);

  async function saveTavilyKey() {
    const k = tavilyKey.trim();
    if (!k) return;
    await setProviderApiKey("tavily", k);
    setTavilyKey("");
    setTavilyConfigured(true);
  }

  async function saveEndpoint() {
    await setPreference(OTEL_ENDPOINT_PREF, endpoint.trim() || null);
    setSavedEndpoint(endpoint.trim());
  }

  async function addRule() {
    if (!eventType.trim()) return;
    await createAlertRule({
      name: name.trim() || null,
      source: "event",
      eventType: eventType.trim(),
      predicateJson: "{}",
      action,
      enabled: true,
    });
    setName("");
    setEventType("");
    loadRules();
    await reloadAlertRules();
  }

  async function toggle(rule: AlertRule) {
    await setAlertRuleEnabled(rule.id, !rule.enabled);
    loadRules();
    await reloadAlertRules();
  }

  async function remove(id: string) {
    await deleteAlertRule(id);
    loadRules();
    await reloadAlertRules();
  }

  return (
    <div className="max-w-lg flex flex-col gap-8">
      {/* Web search (Tavily) */}
      <div>
        <h2 className="mb-1 text-sm font-medium text-center">Web Search (Tavily)</h2>
        <p className="mb-2 text-xs text-muted-foreground text-center">
          API key for the web_search tool. Stored in the OS keychain — never shown again.{" "}
          {tavilyConfigured && <span className="text-green-600">✓ configured</span>}
        </p>
        <div className="flex items-center justify-center gap-2">
          <input
            type="password"
            value={tavilyKey}
            onChange={(e) => setTavilyKey(e.target.value)}
            placeholder={tavilyConfigured ? "Replace key…" : "tvly-..."}
            className="flex-1 rounded-lg border border-border bg-background px-3 py-1.5 text-xs text-center"
          />
          <Button variant="ghost" onClick={saveTavilyKey} disabled={!tavilyKey.trim()}>
            Save
          </Button>
        </div>
      </div>

      {/* OpenTelemetry export */}
      <div>
        <h2 className="mb-1 text-sm font-medium text-center">OpenTelemetry Export</h2>
        <p className="mb-2 text-xs text-muted-foreground text-center">
          POST app events to an OTLP/HTTP collector. Empty = disabled. Takes effect on next launch.
        </p>
        <div className="flex items-center justify-center gap-2">
          <input
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder="http://localhost:4318/v1/logs"
            className="flex-1 rounded-lg border border-border bg-background px-3 py-1.5 text-xs text-center"
          />
          <Button variant="ghost" onClick={saveEndpoint} disabled={endpoint.trim() === savedEndpoint}>
            Save
          </Button>
        </div>
      </div>

      {/* Alert rules */}
      <div>
        <h2 className="mb-1 text-sm font-medium text-center">Alert Rules</h2>
        <p className="mb-2 text-xs text-muted-foreground text-center">
          Fire a toast when an event occurs. Enter an event type (e.g. workflow:run_failed).
        </p>
        <div className="flex items-center justify-center gap-2 flex-wrap mb-3">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Label (optional)"
            className="w-36 rounded-lg border border-border bg-background px-3 py-1.5 text-xs text-center"
          />
          <input
            value={eventType}
            onChange={(e) => setEventType(e.target.value)}
            placeholder="event:type"
            className="w-44 rounded-lg border border-border bg-background px-3 py-1.5 text-xs text-center"
          />
          <Select value={action} onChange={(e) => setAction(e.target.value as "toast" | "notify")} className="w-28 text-center [text-align-last:center]">
            <option value="toast">Toast</option>
            <option value="notify">Notify</option>
          </Select>
          <Button variant="ghost" onClick={addRule} disabled={!eventType.trim()}>
            Add
          </Button>
        </div>

        {rules.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center">No alert rules.</p>
        ) : (
          <div className="rounded-lg border border-border divide-y divide-border">
            {rules.map((r) => (
              <div key={r.id} className="flex items-center gap-2 px-3 py-2 text-xs">
                <input type="checkbox" checked={r.enabled} onChange={() => toggle(r)} className="h-3.5 w-3.5 shrink-0" />
                <span className="font-mono">{r.eventType}</span>
                {r.name && <span className="text-muted-foreground">— {r.name}</span>}
                <span className="ml-auto text-muted-foreground">{r.action}</span>
                <button onClick={() => remove(r.id)} className="text-destructive hover:underline">Delete</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
