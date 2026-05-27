import Database from "@tauri-apps/plugin-sql";
import { DB_NAME } from "@/lib/constants";
import { DatabaseError } from "@/lib/errors";
import { logger } from "@/lib/logger";

let db: Database | null = null;

async function getDb(): Promise<Database> {
  if (!db) {
    db = await Database.load(DB_NAME);
  }
  return db;
}

export async function dbExecute(
  sql: string,
  params: unknown[] = [],
): Promise<{ rowsAffected: number }> {
  try {
    const conn = await getDb();
    const result = await conn.execute(sql, params);
    return { rowsAffected: result.rowsAffected };
  } catch (err) {
    logger.error("DB execute failed", err);
    throw new DatabaseError(
      `Query failed: ${String(err)}`,
      "DB_EXECUTE_FAILED",
    );
  }
}

export async function dbSelect<T>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  try {
    const conn = await getDb();
    return conn.select<T[]>(sql, params);
  } catch (err) {
    logger.error("DB select failed", err);
    throw new DatabaseError(`Query failed: ${String(err)}`, "DB_SELECT_FAILED");
  }
}
