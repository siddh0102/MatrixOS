import { useSettingsStore } from "@/stores/settings-store";
import { hasProviderApiKey } from "@/kernel/secure-store";
import { createProvider } from "@/providers";
import type { ILLMProvider } from "@/types";

export function useProvider() {
  const providers = useSettingsStore((s) => s.providers);
  const activeProviderId = useSettingsStore((s) => s.activeProviderId);
  const activeProvider =
    providers.find((p) => p.id === activeProviderId) ?? null;

  async function resolveProvider(
    providerId: string,
  ): Promise<ILLMProvider | null> {
    const config = providers.find((p) => p.id === providerId);
    if (!config || !config.enabled) return null;
    if (
      config.type === "claude" ||
      config.type === "openai-compatible"
    ) {
      const hasKey = await hasProviderApiKey(config.id);
      if (!hasKey) return null;
    }
    return createProvider(config);
  }

  return { providers, activeProviderId, activeProvider, resolveProvider };
}
