import { useState, useEffect } from "react";
import { useKnowledgeStore } from "@/stores/knowledge-store";
import { dbExecute } from "@/kernel/ipc-bridge";
import { vecGetDimensions, vecRecreate } from "@/kernel/vector-bridge";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import type { EmbeddingConfig, EmbeddingProvider } from "@/types";

const PRESET_MODELS: Record<string, { model: string; dimensions: number; recommended?: boolean }[]> = {
  local: [
    // Bundled in-app under public/models/nomic-embed-text-v1.5/. Loaded via
    // transformers.js's localModelPath; no HuggingFace download. 768-dim,
    // 8192-token context, Apache 2.0.
    { model: "nomic-embed-text-v1.5", dimensions: 768, recommended: true },
    // Legacy options — require allowRemoteModels=true in the worker, which
    // is currently disabled. Selecting these will fail unless you flip the
    // env.allowRemoteModels flag in src/workers/embedding-worker.ts.
    { model: "Xenova/all-MiniLM-L6-v2", dimensions: 384 },
    { model: "Xenova/bge-small-en-v1.5", dimensions: 384 },
  ],
  ollama: [
    { model: "nomic-embed-text", dimensions: 768, recommended: true },
    { model: "all-minilm", dimensions: 384 },
  ],
  "openai-compatible": [
    { model: "nomic-embed-text-v1-5-f32", dimensions: 768, recommended: true },
    { model: "text-embedding-3-small", dimensions: 1536 },
    { model: "text-embedding-3-large", dimensions: 3072 },
  ],
};

export function EmbeddingSettingsSection() {
  const embeddingConfig = useKnowledgeStore((s) => s.embeddingConfig);
  const setEmbeddingConfig = useKnowledgeStore((s) => s.setEmbeddingConfig);

  const [provider, setProvider] = useState<EmbeddingProvider>(
    embeddingConfig?.provider ?? "local",
  );
  const [model, setModel] = useState(embeddingConfig?.model ?? "nomic-embed-text-v1.5");
  const [dimensions, setDimensions] = useState(embeddingConfig?.dimensions ?? 768);
  const [baseUrl, setBaseUrl] = useState(embeddingConfig?.baseUrl ?? "");
  const [saving, setSaving] = useState(false);
  const [dimensionMismatch, setDimensionMismatch] = useState(false);

  useEffect(() => {
    checkDimensionMismatch();
  }, [dimensions]);

  async function checkDimensionMismatch() {
    try {
      const currentDims = await vecGetDimensions();
      setDimensionMismatch(currentDims !== dimensions);
    } catch {
      setDimensionMismatch(false);
    }
  }

  function handlePresetSelect(modelName: string) {
    const presets = PRESET_MODELS[provider] ?? [];
    const preset = presets.find((p) => p.model === modelName);
    if (preset) {
      setModel(preset.model);
      setDimensions(preset.dimensions);
    }
  }

  async function handleSave() {
    setSaving(true);
    try {
      const config: EmbeddingConfig = {
        provider,
        model,
        dimensions,
        baseUrl: baseUrl || null,
      };

      if (dimensionMismatch) {
        await vecRecreate(dimensions);
      }

      await dbExecute(
        `UPDATE embedding_config
         SET provider = ?, model = ?, dimensions = ?, base_url = ?, updated_at = datetime('now')
         WHERE id = 'default'`,
        [provider, model, dimensions, baseUrl || null],
      );

      setEmbeddingConfig(config);
      setDimensionMismatch(false);
    } finally {
      setSaving(false);
    }
  }

  const presets = PRESET_MODELS[provider] ?? [];

  return (
    <div>
      <h3 className="mb-3 text-sm font-medium">Embedding Provider</h3>
      <div className="flex flex-col gap-3 rounded-lg border border-border p-4 max-w-lg">
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">Provider</label>
          <Select
            value={provider}
            onChange={(e) => {
              const p = e.target.value as EmbeddingProvider;
              setProvider(p);
              const first = PRESET_MODELS[p]?.[0];
              if (first) { setModel(first.model); setDimensions(first.dimensions); }
            }}
          >
            <option value="local">Built-in (No Setup Required)</option>
            <option value="ollama">Ollama (Local Server)</option>
            <option value="openai-compatible">OpenAI-Compatible (Local or Cloud)</option>
          </Select>
        </div>

        {provider === "ollama" && (
          <p className="text-xs text-muted-foreground text-center">
            Recommended: <code>nomic-embed-text</code> — open source, 768-dim, runs locally via Ollama.
            Install with <code>ollama pull nomic-embed-text</code>.
          </p>
        )}

        {provider === "openai-compatible" && (
          <p className="text-xs text-muted-foreground text-center">
            Recommended for local use: <code>nomic-embed-text-v1-5-f32</code> at base URL{" "}
            <code>http://127.0.0.1:8081/v1</code> — 768-dim, no API key required.
            Task prefixes (<code>search_query: </code>/<code>search_document: </code>) are applied automatically.
          </p>
        )}

        <div>
          <label className="mb-1 block text-xs text-muted-foreground">Model</label>
          <Select value={model} onChange={(e) => handlePresetSelect(e.target.value)}>
            {presets.map((p) => (
              <option key={p.model} value={p.model}>
                {p.model} ({p.dimensions}d){p.recommended ? " — recommended" : ""}
              </option>
            ))}
          </Select>
        </div>

        <div>
          <label className="mb-1 block text-xs text-muted-foreground">Dimensions</label>
          <Input
            type="number"
            value={dimensions}
            onChange={(e) => setDimensions(parseInt(e.target.value) || 384)}
            min={64}
            max={4096}
          />
        </div>

        {provider === "openai-compatible" && (
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Base URL (optional)</label>
            <Input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="http://127.0.0.1:8081/v1"
            />
          </div>
        )}

        {dimensionMismatch && (
          <p className="text-xs text-amber-500">
            Dimension change detected. Saving will rebuild vector tables and delete all existing
            embeddings. Documents and episodic memories will need to be re-embedded.
          </p>
        )}

        <Button onClick={handleSave} disabled={saving}>
          {saving ? "Saving..." : "Save Embedding Config"}
        </Button>
      </div>
    </div>
  );
}
