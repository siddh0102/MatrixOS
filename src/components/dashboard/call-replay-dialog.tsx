import { useState, useEffect } from "react";
import { Dialog } from "@/components/ui/dialog";
import { Tabs } from "@/components/ui/tabs";
import { Select } from "@/components/ui/select";
import { getLLMRequest } from "@/memory/telemetry-store";
import { getCallsForRequest } from "@/memory/telemetry-queries";
import { createProvider } from "@/providers";
import { DEFAULT_MAX_TOKENS, DEFAULT_TEMPERATURE } from "@/lib/constants";
import type { LLMRequestLog, LLMCallLog, LLMMessage } from "@/types";
import { useSettingsStore } from "@/stores/settings-store";

const DIALOG_TABS = [
  { id: "prompt", label: "Prompt" },
  { id: "response", label: "Response" },
  { id: "rounds", label: "Rounds" },
  { id: "rerun", label: "Rerun" },
];

function formatMs(ms: number) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

function prettyJson(json: string | null): string {
  if (!json) return "";
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}

interface CallReplayDialogProps {
  requestId: string;
  onClose: () => void;
}

export function CallReplayDialog({ requestId, onClose }: CallReplayDialogProps) {
  const [request, setRequest] = useState<LLMRequestLog | null | "loading">("loading");
  const [calls, setCalls] = useState<LLMCallLog[]>([]);
  const [activeTab, setActiveTab] = useState("prompt");
  const providers = useSettingsStore((s) => s.providers);

  // Flattened model picker for rerun.
  const modelOptions = providers.flatMap((p) =>
    p.models.map((m) => ({ key: `${p.id}::${m.id}`, providerId: p.id, modelId: m.id, label: `${p.name} / ${m.name}` })),
  );
  const [rerunKey, setRerunKey] = useState("");
  const [rerunResult, setRerunResult] = useState<string | null>(null);
  const [rerunning, setRerunning] = useState(false);

  useEffect(() => {
    setRequest("loading");
    setCalls([]);
    setRerunResult(null);
    getLLMRequest(requestId).then((r) => setRequest(r));
    getCallsForRequest(requestId).then(setCalls).catch(() => {});
  }, [requestId]);

  const providerName = request && request !== "loading"
    ? providers.find((p) => p.id === request.providerId)?.name ?? request.providerId
    : "";

  async function rerun() {
    if (!request || request === "loading") return;
    const opt = modelOptions.find((o) => o.key === rerunKey);
    const cfg = opt && providers.find((p) => p.id === opt.providerId);
    if (!opt || !cfg) return;
    setRerunning(true);
    setRerunResult(null);
    try {
      const messages = JSON.parse(request.promptJson || "[]") as LLMMessage[];
      const model = cfg.models.find((m) => m.id === opt.modelId);
      const resp = await createProvider(cfg).sendMessage({
        model: opt.modelId,
        // The original system prompt is not stored on the turn row, so the
        // rerun runs without it — output diffs are indicative, not exact.
        systemPrompt: "",
        messages,
        maxTokens: model?.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
        temperature: DEFAULT_TEMPERATURE,
        callContext: { type: "User" },
      });
      const text = resp.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      setRerunResult(text || "(empty)");
    } catch (e) {
      setRerunResult(`Error: ${(e as Error).message}`);
    } finally {
      setRerunning(false);
    }
  }

  return (
    <Dialog open onClose={onClose} title="LLM Call Replay" className="max-w-2xl w-full">
      {request === "loading" ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : request === null ? (
        <p className="text-sm text-muted-foreground">
          Telemetry data unavailable for this message.
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
            <div className="flex gap-2">
              <span className="text-muted-foreground">Provider:</span>
              <span>{providerName}</span>
            </div>
            <div className="flex gap-2">
              <span className="text-muted-foreground">Model:</span>
              <span className="font-mono text-xs">{request.modelId}</span>
            </div>
            <div className="flex gap-2">
              <span className="text-muted-foreground">Status:</span>
              <span className={request.status === "success" ? "text-green-600 dark:text-green-400" : "text-destructive"}>
                {request.status === "success" ? "✓ Success" : `✗ Error${request.errorCode ? ` (${request.errorCode})` : ""}`}
              </span>
            </div>
            <div className="flex gap-2">
              <span className="text-muted-foreground">Latency:</span>
              <span>{formatMs(request.latencyMs)}</span>
            </div>
            <div className="flex gap-2">
              <span className="text-muted-foreground">Tokens:</span>
              <span>{request.inputTokens.toLocaleString()} in / {request.outputTokens.toLocaleString()} out</span>
            </div>
            <div className="flex gap-2">
              <span className="text-muted-foreground">Tool Rounds:</span>
              <span>{request.toolRounds}</span>
            </div>
            <div className="flex gap-2 col-span-2">
              <span className="text-muted-foreground">Time:</span>
              <span className="text-xs">{new Date(request.createdAt).toLocaleString()}</span>
            </div>
          </div>

          <Tabs tabs={DIALOG_TABS} activeTab={activeTab} onTabChange={setActiveTab}>
            <div className="max-h-80 overflow-auto rounded-lg border border-border bg-muted/30 p-3">
              {activeTab === "prompt" ? (
                <pre className="text-xs whitespace-pre-wrap break-words text-foreground">
                  {prettyJson(request.promptJson) || "(empty)"}
                </pre>
              ) : activeTab === "response" ? (
                <pre className="text-xs whitespace-pre-wrap break-words text-foreground">
                  {request.responseText || "(empty)"}
                </pre>
              ) : activeTab === "rounds" ? (
                calls.length === 0 ? (
                  <p className="text-xs text-muted-foreground text-center">No per-round detail recorded.</p>
                ) : (
                  <div className="flex flex-col gap-2">
                    {calls.map((c) => (
                      <div key={c.id} className="rounded border border-border p-2">
                        <p className="text-xs font-mono text-center">
                          #{c.turnIndex} · ttft {c.ttftMs == null ? "—" : formatMs(c.ttftMs)} · {c.latencyMs == null ? "—" : formatMs(c.latencyMs)} · {(c.inputTokens ?? 0)}↑ {(c.outputTokens ?? 0)}↓
                          {c.finishReason ? ` · ${c.finishReason}` : ""}
                        </p>
                        {c.promptJson && (
                          <pre className="mt-1 text-[11px] whitespace-pre-wrap break-words max-h-40 overflow-auto">
                            {prettyJson(c.promptJson)}
                          </pre>
                        )}
                      </div>
                    ))}
                  </div>
                )
              ) : (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-center gap-2">
                    <Select value={rerunKey} onChange={(e) => setRerunKey(e.target.value)} className="w-56 text-center [text-align-last:center]">
                      <option value="">Select model…</option>
                      {modelOptions.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
                    </Select>
                    <button
                      onClick={rerun}
                      disabled={!rerunKey || rerunning}
                      className="rounded-lg border border-border px-4 py-1.5 text-xs hover:bg-accent disabled:opacity-40"
                    >
                      {rerunning ? "Running…" : "Rerun"}
                    </button>
                  </div>
                  <p className="text-[10px] text-muted-foreground text-center">
                    Reruns without the original system prompt — output is indicative, not exact.
                  </p>
                  {rerunResult != null && (
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1 text-center">Original</p>
                        <pre className="text-[11px] whitespace-pre-wrap break-words bg-muted rounded p-2 max-h-48 overflow-auto">{request.responseText || "(empty)"}</pre>
                      </div>
                      <div>
                        <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1 text-center">Rerun</p>
                        <pre className="text-[11px] whitespace-pre-wrap break-words bg-muted rounded p-2 max-h-48 overflow-auto">{rerunResult}</pre>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </Tabs>
        </div>
      )}
    </Dialog>
  );
}
