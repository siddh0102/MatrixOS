import { vi } from "vitest";

const store = new Map<string, string>();

export function mockSecureStore() {
  vi.mock("@tauri-apps/plugin-secure-store", () => ({
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    remove: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  }));
  return store;
}

export function clearSecureStore() {
  store.clear();
}
