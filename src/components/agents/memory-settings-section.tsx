import { useEffect, useState } from "react";
import { Slider } from "@/components/ui/slider";
import { Chip } from "@/components/ui/chip";
import { useKnowledgeStore } from "@/stores/knowledge-store";
import { listKnowledgeBases } from "@/memory/knowledge-base-store";
import type { KnowledgeBase, MemoryConfig } from "@/types";

interface MemorySettingsSectionProps {
  memoryConfig: MemoryConfig;
  onChange: (config: MemoryConfig) => void;
}

export function MemorySettingsSection({
  memoryConfig,
  onChange,
}: MemorySettingsSectionProps) {
  const documents = useKnowledgeStore((s) => s.documents);
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);

  // Knowledge bases aren't held in the global store — load lazily here, same
  // pattern as knowledge-bases-tab.tsx. Re-fetch when memory is turned on
  // so a freshly-created KB shows up without reopening the editor.
  useEffect(() => {
    if (!memoryConfig.enabled || !memoryConfig.semanticEnabled) return;
    listKnowledgeBases().then(setKnowledgeBases).catch(() => { /* non-fatal */ });
  }, [memoryConfig.enabled, memoryConfig.semanticEnabled]);

  function update(partial: Partial<MemoryConfig>) {
    onChange({ ...memoryConfig, ...partial });
  }

  function toggleDocumentScope(docId: string) {
    const current = memoryConfig.knowledgeDocumentIds;
    const next = current.includes(docId)
      ? current.filter((id) => id !== docId)
      : [...current, docId];
    update({ knowledgeDocumentIds: next });
  }

  function toggleKnowledgeBaseScope(kbId: string) {
    const current = memoryConfig.knowledgeBaseIds ?? [];
    const next = current.includes(kbId)
      ? current.filter((id) => id !== kbId)
      : [...current, kbId];
    update({ knowledgeBaseIds: next });
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <label className="text-sm text-muted-foreground">Memory & Knowledge</label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={memoryConfig.enabled}
            onChange={(e) => update({ enabled: e.target.checked })}
            className="rounded"
          />
          Enable
        </label>
      </div>

      {memoryConfig.enabled && (
        <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              checked={memoryConfig.episodicEnabled}
              onChange={(e) => update({ episodicEnabled: e.target.checked })}
            />
            Past conversations
          </label>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              checked={memoryConfig.semanticEnabled}
              onChange={(e) => update({ semanticEnabled: e.target.checked })}
            />
            Document knowledge
          </label>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              checked={memoryConfig.proceduralEnabled}
              onChange={(e) => update({ proceduralEnabled: e.target.checked })}
            />
            Templates / patterns
          </label>

          {memoryConfig.semanticEnabled && (knowledgeBases.length > 0 || documents.length > 0) && (
            <div className="flex flex-col gap-3">
              {knowledgeBases.length > 0 && (
                <div>
                  <label className="mb-1.5 block text-xs text-muted-foreground">
                    Knowledge bases
                    <span className="ml-1 text-muted-foreground/50">
                      (a base includes all its documents)
                    </span>
                  </label>
                  <div className="flex flex-wrap gap-1.5">
                    {knowledgeBases.map((kb) => (
                      <Chip
                        key={kb.id}
                        label={`${kb.name} (${kb.documentIds.length})`}
                        size="sm"
                        selected={(memoryConfig.knowledgeBaseIds ?? []).includes(kb.id)}
                        onToggle={() => toggleKnowledgeBaseScope(kb.id)}
                      />
                    ))}
                  </div>
                </div>
              )}

              {documents.length > 0 && (
                <div>
                  <label className="mb-1.5 block text-xs text-muted-foreground">
                    Individual documents
                    <span className="ml-1 text-muted-foreground/50">
                      {knowledgeBases.length > 0
                        ? "(narrows further; nothing selected anywhere = search all)"
                        : "(none selected = search all)"}
                    </span>
                  </label>
                  <div className="flex flex-wrap gap-1.5">
                    {documents.map((doc) => (
                      <Chip
                        key={doc.id}
                        label={doc.name}
                        size="sm"
                        selected={memoryConfig.knowledgeDocumentIds.includes(doc.id)}
                        onToggle={() => toggleDocumentScope(doc.id)}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          <Slider
            label="Max retrieval tokens"
            displayValue={memoryConfig.maxRetrievalTokens.toString()}
            min={256}
            max={8192}
            step={256}
            value={memoryConfig.maxRetrievalTokens}
            onChange={(e) => update({ maxRetrievalTokens: parseInt(e.target.value) })}
          />

          <Slider
            label="Max pinned tokens"
            displayValue={memoryConfig.maxPinnedTokens.toString()}
            min={512}
            max={16384}
            step={512}
            value={memoryConfig.maxPinnedTokens}
            onChange={(e) => update({ maxPinnedTokens: parseInt(e.target.value) })}
          />

          <Slider
            label="Relevance threshold"
            displayValue={(memoryConfig.relevanceThreshold * 100).toFixed(0) + "%"}
            min={0}
            max={1}
            step={0.05}
            value={memoryConfig.relevanceThreshold}
            onChange={(e) => update({ relevanceThreshold: parseFloat(e.target.value) })}
          />

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Episodic max</label>
              <input
                type="number"
                value={memoryConfig.episodicMaxResults}
                onChange={(e) => update({ episodicMaxResults: parseInt(e.target.value) || 1 })}
                min={1}
                max={20}
                className="w-full rounded-lg border border-border bg-background px-2 py-1 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Semantic max</label>
              <input
                type="number"
                value={memoryConfig.semanticMaxResults}
                onChange={(e) => update({ semanticMaxResults: parseInt(e.target.value) || 1 })}
                min={1}
                max={20}
                className="w-full rounded-lg border border-border bg-background px-2 py-1 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Procedural max</label>
              <input
                type="number"
                value={memoryConfig.proceduralMaxResults}
                onChange={(e) => update({ proceduralMaxResults: parseInt(e.target.value) || 1 })}
                min={1}
                max={10}
                className="w-full rounded-lg border border-border bg-background px-2 py-1 text-sm"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
