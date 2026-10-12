import { Pool } from "pg";

let pool: Pool | undefined;

export function getDatabasePool(): Pool {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required for PostgreSQL persistence");
  }
  pool = new Pool({ connectionString });
  return pool;
}

export async function closeDatabasePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
