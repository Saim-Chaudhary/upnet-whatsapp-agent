import "dotenv/config";
import { FastifyInstance } from "fastify";
import axios from "axios";

async function whatsappRoutes(app: FastifyInstance) {
  app.post("/webhook/whatsapp", async (request) => {
    const payload = request.body as any;

    const message = payload.data;

    console.log("From:", message.from);
    console.log("ChatId:", message.chatId);
    console.log("Body:", message.body);

    await axios.post(
      `${process.env.OPENWA_URL}/api/sessions/${process.env.OPENWA_SESSION_ID}/messages/send-text`,
      {
        chatId: message.from,
        text: "Hello! 👋 Welcome to UpNet. How can I help you today?",
      },
      {
        headers: {
          "X-API-Key": process.env.OPENWA_API_KEY,
          "Content-Type": "application/json",
        },
      },
    );

    return {
      received: true,
    };
  });
}

export default whatsappRoutes;

