import "dotenv/config";

import { FastifyInstance } from "fastify";
import axios from "axios";
import { resetConversation } from "../agent/conversation.js";
import { handleAgentMessage } from "../agent/service.js";

async function whatsappRoutes(app: FastifyInstance) {
  app.post("/webhook/whatsapp", async (request) => {
    const payload = request.body as any;
    const message = payload.data;

    console.log("From:", message.from);
    console.log("ChatId:", message.chatId);
    console.log("Body:", message.body);

    processWhatsAppMessage(message).catch((error) => {
      console.error("Message processing failed:", error);
    });

    return {
      received: true,
    };
  });

  app.delete<{ Params: { chatId: string } }>(
    "/webhook/whatsapp/conversations/:chatId",
    async (request) => {
      const wasReset = resetConversation(request.params.chatId);

      return {
        reset: wasReset,
        chatId: request.params.chatId,
      };
    },
  );
}

async function processWhatsAppMessage(message: any) {
  const chatId = message.chatId || message.from;
  const result = await handleAgentMessage(chatId, message.body);
  const reply = result.reply;

  console.log("AI Reply:", reply);

  const sendResponse = await axios.post(
    `${process.env.OPENWA_URL}/api/sessions/${process.env.OPENWA_SESSION_ID}/messages/send-text`,
    {
      chatId: message.from,
      text: reply,
    },
    {
      headers: {
        "X-API-Key": process.env.OPENWA_API_KEY,
        "Content-Type": "application/json",
      },
    },
  );

  console.log("OpenWA Send Status:", sendResponse.status);
  console.log("OpenWA Send Response:", sendResponse.data);
}

export default whatsappRoutes;
