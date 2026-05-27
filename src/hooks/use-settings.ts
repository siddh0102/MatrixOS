import { useCallback } from "react";
import {
  getPreference,
  setPreference,
} from "@/memory/preferences-store";

export function useSettings() {
  const load = useCallback(
    async <T>(key: string, fallback: T): Promise<T> => {
      const val = await getPreference<T>(key);
      return val ?? fallback;
    },
    [],
  );

  const save = useCallback(
    async (key: string, value: unknown): Promise<void> => {
      await setPreference(key, value);
    },
    [],
  );

  return { load, save };
}
