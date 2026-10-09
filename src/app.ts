import Fastify from "fastify";
import localRoutes from "./routes/local.js";
import whatsappRoutes from "./routes/whatsapp.js";

export function buildApp() {
  const app = Fastify({ logger: true });

  app.get("/health", async () => ({
    status: "ok",
    service: "upnet-whatsapp-agent",
  }));

  app.register(localRoutes);
  app.register(whatsappRoutes);

  return app;
}
