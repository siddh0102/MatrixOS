import { vi } from "vitest";
import type { ILLMProvider, LLMResponse, ModelConfig, ProviderConfig } from "@/types";
import { isoNow } from "@/lib/utils";

export function makeProviderConfig(
  overrides: Partial<ProviderConfig> = {},
): ProviderConfig {
  return {
    id: "test-provider",
    type: "claude",
    name: "Test Provider",
    baseUrl: null,
    enabled: true,
    models: [],
    defaultModelId: "test-model",
    rateLimit: { requestsPerMinute: 60, tokensPerMinute: 100_000 },
    createdAt: isoNow(),
    updatedAt: isoNow(),
    ...overrides,
  };
}

export function createMockProvider(
  overrides: Partial<ILLMProvider> = {},
): ILLMProvider {
  const defaultResponse: LLMResponse = {
    id: "resp-1",
    model: "test-model",
    content: [{ type: "text", text: "Hello from mock" }],
    stopReason: "end_turn",
    usage: { inputTokens: 10, outputTokens: 5 },
  };

  return {
    type: "claude",
    config: makeProviderConfig(),
    sendMessage: vi.fn(async () => defaultResponse),
    streamMessage: vi.fn(async function* () {
      yield { type: "message_start" as const };
      yield { type: "text_delta" as const, text: "Hello from mock" };
      yield {
        type: "message_end" as const,
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    }),
    listModels: vi.fn(async (): Promise<ModelConfig[]> => []),
    validateConnection: vi.fn(async () => true),
    ...overrides,
  };
}
