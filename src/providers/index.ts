import type { ILLMProvider, ProviderConfig } from "@/types/provider";
import { RustProviderProxy } from "./rust-proxy";

/**
 * All LLM providers run in the Rust backend after Phase A. JS receives a
 * proxy that implements ILLMProvider and forwards calls via Tauri invoke.
 * API keys never cross the IPC boundary outbound.
 */
export function createProvider(config: ProviderConfig): ILLMProvider {
  return new RustProviderProxy(config);
}
