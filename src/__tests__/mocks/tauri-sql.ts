import { vi } from "vitest";

export interface MockDatabase {
  execute: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
}

export function createMockDatabase(
  rows: Record<string, unknown[]> = {},
): MockDatabase {
  return {
    execute: vi.fn(async () => ({ rowsAffected: 1 })),
    select: vi.fn(async (sql: string) => {
      // Return rows keyed by table name extracted from SQL
      for (const [table, data] of Object.entries(rows)) {
        if (sql.toLowerCase().includes(table.toLowerCase())) return data;
      }
      return [];
    }),
  };
}

export function mockTauriSql(db?: MockDatabase) {
  const mockDb = db ?? createMockDatabase();
  vi.mock("@tauri-apps/plugin-sql", () => ({
    default: {
      load: vi.fn(async () => mockDb),
    },
  }));
  return mockDb;
}
