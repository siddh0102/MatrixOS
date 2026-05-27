import type {
  ILLMProvider,
  LLMRequest,
  LLMResponse,
  LLMStreamChunk,
  ModelConfig,
  ProviderConfig,
} from "@/types";
import { ProviderError } from "@/lib/errors";
import { OLLAMA_DEFAULT_BASE_URL } from "@/lib/constants";

interface OllamaTagsResponse {
  models?: Array<{ name: string; size?: number }>;
}

export class OllamaStub implements ILLMProvider {
  readonly type = "ollama" as const;
  readonly config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  async validateConnection(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`);
      return res.ok;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<ModelConfig[]> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`);
      if (!res.ok) return [];
      const json = (await res.json()) as OllamaTagsResponse;
      return (json.models ?? []).map((m) => ({
        id: m.name,
        name: m.name,
        contextWindow: 4096,
        maxOutputTokens: 2048,
        supportsTools: false,
        supportsStreaming: true,
        supportsVision: false,
        costPerInputToken: 0,
        costPerOutputToken: 0,
      }));
    } catch {
      return [];
    }
  }

  async sendMessage(_request: LLMRequest): Promise<LLMResponse> {
    throw new ProviderError(
      "Ollama chat is not yet available. Full Ollama support is coming in Phase 2.",
      "OLLAMA_NOT_IMPLEMENTED",
      false,
    );
  }

  async *streamMessage(
    _request: LLMRequest,
  ): AsyncGenerator<LLMStreamChunk, void, undefined> {
    throw new ProviderError(
      "Ollama streaming is not yet available. Full Ollama support is coming in Phase 2.",
      "OLLAMA_NOT_IMPLEMENTED",
      false,
    );
  }

  private get baseUrl(): string {
    return this.config.baseUrl ?? OLLAMA_DEFAULT_BASE_URL;
  }
}
