import Fastify from "fastify";
import localRoutes from "./routes/local.js";
import whatsappRoutes from "./routes/whatsapp.js";
import { closeDatabasePool } from "./db/pool.js";
import {
  AgentStores,
  getPersistentAgentStores,
} from "./agent/persistence.js";
import staffRoutes from "./routes/staff.js";
import fastifyStatic from "@fastify/static";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function buildApp(stores: AgentStores = getPersistentAgentStores()) {
  const app = Fastify({ logger: true });

  app.get("/health", async () => ({
    status: "ok",
    service: "upnet-whatsapp-agent",
  }));

  app.register(localRoutes, { stores });
  app.register(whatsappRoutes, { stores });
  if (process.env.DATABASE_URL) app.register(staffRoutes);
  app.register(fastifyStatic, {
    root: resolve(fileURLToPath(new URL("../dist/dashboard", import.meta.url))),
    prefix: "/dashboard/",
    decorateReply: false,
  });
  app.get("/dashboard", async (_request, reply) => reply.redirect("/dashboard/"));
  app.addHook("onClose", async () => {
    await closeDatabasePool();
  });

  return app;
}
