import { invoke } from "@tauri-apps/api/core";

export async function setProviderApiKey(
  providerId: string,
  apiKey: string,
): Promise<void> {
  await invoke("provider_set_key", { providerId, key: apiKey });
}

export async function deleteProviderApiKey(
  providerId: string,
): Promise<void> {
  await invoke("provider_delete_key", { providerId });
}

export async function hasProviderApiKey(
  providerId: string,
): Promise<boolean> {
  return invoke<boolean>("provider_has_key", { providerId });
}

// Backwards-compat shim during Phase A migration:
// any caller still importing getProviderApiKey will get a runtime error
// instead of silently receiving null. Remove this stub once all callers
// are migrated (verified during Task 19's grep + cleanup).
export function getProviderApiKey(_providerId: string): Promise<string | null> {
  throw new Error(
    "getProviderApiKey was removed in Phase A. " +
    "Keys never leave Rust — use hasProviderApiKey for UI 'configured?' state."
  );
}
