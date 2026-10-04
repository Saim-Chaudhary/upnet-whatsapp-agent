import Fastify from "fastify";
import whatsappRoutes  from "./routes/whatsapp.js";

const app = Fastify({
  logger: true,
});

app.get("/health", async () => {
  return {
    status: "ok",
    service: "upnet-whatsapp-agent",
  };
});

app.register(whatsappRoutes);

const start = async () => {
  try {
    await app.listen({
      port: 3000,
      host: "0.0.0.0",
    });

    console.log("UpNet WhatsApp Agent running on port 3000");
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
};

start();