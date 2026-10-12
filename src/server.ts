import { buildApp } from "./app.js";
import { migrateDatabase } from "./db/migrate.js";
import { createOpenWaSender, NotificationDispatcher, PostgresNotificationJobStore } from "./notifications/jobs.js";
import { getDatabasePool } from "./db/pool.js";

const app = buildApp();
let dispatcher: NotificationDispatcher | undefined;

const start = async () => {
  try {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is required before starting production");
    }
    await migrateDatabase(connectionString);
    dispatcher = new NotificationDispatcher(
      new PostgresNotificationJobStore(getDatabasePool()),
      createOpenWaSender(),
    );
    dispatcher.start();
    await app.listen({
      port: 3000,
      host: "0.0.0.0",
    });

    console.log("UpNet WhatsApp Agent running on port 3000");
  } catch (error) {
    await dispatcher?.stop();
    app.log.error(error);
    process.exit(1);
  }
};

start();