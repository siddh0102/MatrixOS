import type { EmbeddingConfig } from "@/types";

const OLLAMA_DEFAULT_URL = "http://localhost:11434";

/**
 * Whether the text being embedded is a search query (what the user typed)
 * or a document being indexed for later retrieval. Nomic-family models
 * require this as a task prefix; omitting it measurably degrades quality.
 * Other models ignore it.
 */
export type EmbedIntent = "query" | "document";

const NOMIC_PREFIX: Record<EmbedIntent, string> = {
  query: "search_query: ",
  document: "search_document: ",
};

function applyTaskPrefix(text: string, intent: EmbedIntent, model: string): string {
  // The trailing space is part of the prefix and must be preserved.
  if (model.toLowerCase().includes("nomic")) return NOMIC_PREFIX[intent] + text;
  return text;
}

// ── Web Worker for local embedding ──

let worker: Worker | null = null;
let pendingRequests = new Map<string, {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}>();
let requestCounter = 0;

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(
      new URL("@/workers/embedding-worker.ts", import.meta.url),
      { type: "module" },
    );
    worker.onmessage = (e: MessageEvent) => {
      const { id, result, error } = e.data;
      const pending = pendingRequests.get(id);
      if (!pending) return;
      pendingRequests.delete(id);
      if (error) {
        pending.reject(new Error(error));
      } else {
        pending.resolve(result);
      }
    };
  }
  return worker;
}

function workerRequest(model: string, type: "embed" | "embedBatch", texts: string[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = String(++requestCounter);
    pendingRequests.set(id, { resolve, reject });
    getWorker().postMessage({ id, type, model, texts });
  });
}

// ── Public API ──

export async function embedText(
  text: string,
  config: EmbeddingConfig,
  intent: EmbedIntent,
): Promise<number[]> {
  const prefixed = applyTaskPrefix(text, intent, config.model);
  if (config.provider === "local") {
    return workerRequest(config.model, "embed", [prefixed]) as Promise<number[]>;
  }
  if (config.provider === "ollama") {
    return embedOllama(prefixed, config);
  }
  return embedOpenAICompatible(prefixed, config);
}

export async function embedBatch(
  texts: string[],
  config: EmbeddingConfig,
  intent: EmbedIntent,
): Promise<number[][]> {
  const prefixed = texts.map((t) => applyTaskPrefix(t, intent, config.model));
  if (config.provider === "local") {
    return workerRequest(config.model, "embedBatch", prefixed) as Promise<number[][]>;
  }
  if (config.provider === "ollama") {
    const results: number[][] = [];
    for (const text of prefixed) {
      results.push(await embedOllama(text, config));
    }
    return results;
  }
  return embedOpenAIBatch(prefixed, config);
}

// ── Provider implementations ──

async function embedOllama(
  text: string,
  config: EmbeddingConfig,
): Promise<number[]> {
  const baseUrl = config.baseUrl ?? OLLAMA_DEFAULT_URL;
  const res = await fetch(`${baseUrl}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: config.model, prompt: text }),
  });
  if (!res.ok) {
    throw new Error(`Ollama embedding failed: ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as { embedding: number[] };
  return json.embedding;
}

async function embedOpenAICompatible(
  text: string,
  config: EmbeddingConfig,
): Promise<number[]> {
  const results = await embedOpenAIBatch([text], config);
  return results[0];
}

async function embedOpenAIBatch(
  texts: string[],
  config: EmbeddingConfig,
): Promise<number[][]> {
  const baseUrl = config.baseUrl ?? "https://api.openai.com/v1";

  // No Authorization header: local OpenAI-compatible servers (the recommended
  // path) need no auth. Cloud endpoints that require a key will return 401 —
  // a clear actionable error. Cloud embedding via API key is intentionally
  // not supported from the renderer; routing through Rust transport is a
  // Phase A.1 follow-up so the key never crosses the IPC boundary.
  const res = await fetch(`${baseUrl}/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: config.model, input: texts }),
  });
  if (!res.ok) {
    const hint = res.status === 401 || res.status === 403
      ? " — server requires an API key; cloud embedding via API key is not yet supported, use the local OpenAI-compatible server (http://127.0.0.1:8081/v1) or Ollama"
      : "";
    throw new Error(`Embedding API failed: ${res.status} ${res.statusText}${hint}`);
  }
  const json = (await res.json()) as {
    data: Array<{ embedding: number[] }>;
  };
  return json.data.map((d) => d.embedding);
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
