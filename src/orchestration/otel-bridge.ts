import { eventBus } from "@/orchestration/event-bus";
import { getPreference } from "@/memory/preferences-store";
import type { AppEvent, EventSubscription } from "@/types";

/** Preference key holding the OTLP/HTTP collector URL. Bridge is inactive
 *  (zero overhead) unless this is set. */
export const OTEL_ENDPOINT_PREF = "observability.otelEndpoint";
const FLUSH_INTERVAL_MS = 5000;
const MAX_BATCH = 100;

interface OtelEvent {
  name: string;
  timeUnixNano: string;
  attributes: Record<string, unknown>;
}

let buffer: OtelEvent[] = [];
let sub: EventSubscription | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let endpoint: string | null = null;

async function flush(): Promise<void> {
  if (!endpoint || buffer.length === 0) return;
  const batch = buffer;
  buffer = [];
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("otel_export", { endpoint, events: batch });
  } catch {
    // Best-effort export — drop the batch rather than retry/grow unbounded.
  }
}

/** Subscribe the event bus and forward batched events to the collector. No-op
 *  when no endpoint is configured. */
export async function initOtelBridge(): Promise<void> {
  endpoint = await getPreference<string>(OTEL_ENDPOINT_PREF);
  if (!endpoint) return;
  sub = eventBus.onAny((e: AppEvent<unknown>) => {
    const attrs: Record<string, unknown> =
      e.payload && typeof e.payload === "object"
        ? { source: e.source, ...(e.payload as object) }
        : { source: e.source, value: e.payload };
    buffer.push({
      name: e.type,
      timeUnixNano: `${new Date(e.timestamp).getTime()}000000`,
      attributes: attrs,
    });
    if (buffer.length >= MAX_BATCH) void flush();
  });
  timer = setInterval(() => void flush(), FLUSH_INTERVAL_MS);
}

export function stopOtelBridge(): void {
  sub?.unsubscribe();
  sub = null;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
