import "dotenv/config";
import { getDatabasePool, closeDatabasePool } from "../db/pool.js";
import { StaffAuthService } from "./auth.js";

const email = process.env.STAFF_ADMIN_EMAIL;
const password = process.env.STAFF_ADMIN_PASSWORD;
const displayName = process.env.STAFF_ADMIN_NAME ?? "Administrator";
if (!email || !password) {
  console.error("Set STAFF_ADMIN_EMAIL and STAFF_ADMIN_PASSWORD (and optionally STAFF_ADMIN_NAME).");
  process.exitCode = 1;
} else {
  try {
    const actor = await new StaffAuthService(getDatabasePool()).createUser(email, displayName, password, "admin");
    console.log(`Created admin ${actor.email} (${actor.id})`);
  } catch {
    console.error("Could not create first admin (the email may already exist).");
    process.exitCode = 1;
  } finally {
    await closeDatabasePool();
  }
}
