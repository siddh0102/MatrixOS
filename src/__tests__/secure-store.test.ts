import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock @tauri-apps/api/core before the module under test is imported.
// After Phase A, secure-store routes through Rust `provider_*` commands
// — keys never leave the Rust process.
const mockStore = new Map<string, string>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(
    async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "provider_set_key") {
        mockStore.set(args!["providerId"] as string, args!["key"] as string);
        return;
      }
      if (cmd === "provider_delete_key") {
        mockStore.delete(args!["providerId"] as string);
        return;
      }
      if (cmd === "provider_has_key") {
        return mockStore.has(args!["providerId"] as string);
      }
    },
  ),
}));

// Mock audit-store to suppress side-effect DB calls during these tests.
vi.mock("@/memory/audit-store", () => ({
  appendAudit: vi.fn(async () => {}),
}));

import {
  getProviderApiKey,
  setProviderApiKey,
  deleteProviderApiKey,
  hasProviderApiKey,
} from "@/kernel/secure-store";

beforeEach(() => {
  mockStore.clear();
});

describe("secure-store", () => {
  it("forwards set to the provider_set_key Rust command", async () => {
    await setProviderApiKey("prov-1", "sk-test-key");
    expect(mockStore.get("prov-1")).toBe("sk-test-key");
  });

  it("reports key existence via hasProviderApiKey", async () => {
    expect(await hasProviderApiKey("prov-1")).toBe(false);
    await setProviderApiKey("prov-1", "sk-test-key");
    expect(await hasProviderApiKey("prov-1")).toBe(true);
  });

  it("deletes a key", async () => {
    await setProviderApiKey("prov-1", "sk-test-key");
    await deleteProviderApiKey("prov-1");
    expect(await hasProviderApiKey("prov-1")).toBe(false);
  });

  it("namespaces keys correctly for different providers", async () => {
    await setProviderApiKey("prov-1", "key-one");
    await setProviderApiKey("prov-2", "key-two");
    expect(await hasProviderApiKey("prov-1")).toBe(true);
    expect(await hasProviderApiKey("prov-2")).toBe(true);
    await deleteProviderApiKey("prov-1");
    expect(await hasProviderApiKey("prov-1")).toBe(false);
    expect(await hasProviderApiKey("prov-2")).toBe(true);
  });

  it("getProviderApiKey throws — keys never leave Rust", () => {
    expect(() => getProviderApiKey("prov-1")).toThrow(
      /getProviderApiKey was removed in Phase A/,
    );
  });
});
