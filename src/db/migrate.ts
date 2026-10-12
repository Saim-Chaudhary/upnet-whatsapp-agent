import "dotenv/config";

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const schemaPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "schema.sql",
);
const migrationsPath = resolve(dirname(fileURLToPath(import.meta.url)), "migrations", "002_staff_auth.sql");
const notificationMigrationPath = resolve(dirname(fileURLToPath(import.meta.url)), "migrations", "003_notification_jobs.sql");
const maintenanceMigrationPath = resolve(dirname(fileURLToPath(import.meta.url)), "migrations", "004_maintenance_incidents.sql");

export async function migrateDatabase(connectionString: string): Promise<void> {
  const schema = await readFile(schemaPath, "utf8");
  const staffMigration = await readFile(migrationsPath, "utf8");
  const notificationMigration = await readFile(notificationMigrationPath, "utf8");
  const maintenanceMigration = await readFile(maintenanceMigrationPath, "utf8");
  const pool = new Pool({ connectionString });
  try {
    await pool.query("BEGIN");
    await pool.query(schema);
    await pool.query(staffMigration);
    await pool.query(notificationMigration);
    await pool.query(maintenanceMigration);
    await pool.query("COMMIT");
  } catch (error) {
    await pool.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await pool.end();
  }
}

const isDirectExecution =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required to run the database migration");
  }

  await migrateDatabase(connectionString);
  console.log("UpNet ticket schema applied.");
}
