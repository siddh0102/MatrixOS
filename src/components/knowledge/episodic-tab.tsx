import { useState } from "react";
import { useAgentStore } from "@/stores/agent-store";
import { useKnowledge } from "@/hooks/use-knowledge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import type { EpisodicEntry } from "@/types";

export function EpisodicTab() {
  const { searchEpisodic, pinEpisodic, forgetEpisodic, embeddingConfig } = useKnowledge();
  const configs = useAgentStore((s) => s.configs);

  const [query, setQuery] = useState("");
  const [agentFilter, setAgentFilter] = useState<string | null>(null);
  const [results, setResults] = useState<Array<{ entry: EpisodicEntry; score: number }>>([]);
  const [searching, setSearching] = useState(false);

  async function handleSearch() {
    if (!query.trim()) return;
    setSearching(true);
    try {
      const r = await searchEpisodic(query, agentFilter);
      setResults(r);
    } finally {
      setSearching(false);
    }
  }

  if (!embeddingConfig) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">
        Configure an embedding provider in Settings to enable memory search.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground">
        Search past conversations by meaning. Results show the most relevant exchanges.
      </p>

      <div className="flex gap-2 max-w-2xl">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="What did we discuss about..."
          onKeyDown={(e) => e.key === "Enter" && handleSearch()}
          className="flex-1"
        />
        <Select
          value={agentFilter ?? ""}
          onChange={(e) => setAgentFilter(e.target.value || null)}
        >
          <option value="">All Agents</option>
          {configs.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </Select>
        <Button onClick={handleSearch} disabled={searching || !query.trim()}>
          Search
        </Button>
      </div>

      {results.length > 0 && (
        <div className="space-y-3 max-w-3xl">
          {results.map(({ entry, score }) => (
            <div
              key={entry.id}
              className="rounded-lg border border-border bg-card p-4"
            >
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs text-muted-foreground">
                  Score: {(score * 100).toFixed(0)}% &middot; {new Date(entry.createdAt).toLocaleDateString()}
                </span>
                <div className="flex gap-1">
                  <button
                    onClick={() => pinEpisodic(entry.id, !entry.pinned)}
                    className="text-xs text-muted-foreground hover:text-foreground"
                    title={entry.pinned ? "Unpin" : "Pin"}
                  >
                    {entry.pinned ? "Unpin" : "Pin"}
                  </button>
                  <button
                    onClick={() => {
                      forgetEpisodic(entry.id);
                      setResults((r) => r.filter((x) => x.entry.id !== entry.id));
                    }}
                    className="text-xs text-muted-foreground hover:text-destructive"
                    title="Forget"
                  >
                    Forget
                  </button>
                </div>
              </div>
              <pre className="whitespace-pre-wrap text-sm leading-relaxed">
                {entry.summary}
              </pre>
            </div>
          ))}
        </div>
      )}

      {results.length === 0 && query && !searching && (
        <p className="text-sm text-muted-foreground">No matching memories found.</p>
      )}
    </div>
  );
}
