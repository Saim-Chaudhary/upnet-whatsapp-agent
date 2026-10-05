import "dotenv/config";

import { FastifyInstance } from "fastify";
import axios from "axios";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { upnetAgent } from "../agent/upnetAgent.js";
import {
  getConversation,
  resetConversation,
} from "../agent/conversation.js";
import { decideNextStep } from "../agent/workflow.js";

async function whatsappRoutes(app: FastifyInstance) {
  app.post("/webhook/whatsapp", async (request) => {
    const payload = request.body as any;
    const message = payload.data;

    console.log("From:", message.from);
    console.log("ChatId:", message.chatId);
    console.log("Body:", message.body);

    processMessage(message).catch((error) => {
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

async function processMessage(message: any) {
  const chatId = message.chatId || message.from;
  const userMessage = new HumanMessage(message.body);

  const conversation = getConversation(chatId);
  const currentStage = conversation.stage;
  conversation.messages.push(userMessage);

  const decision = decideNextStep(currentStage, message.body);
  conversation.stage = decision.nextStage;

  console.log("Stage:", currentStage);
  console.log("Customer:", message.body);
  console.log("Next stage:", decision.nextStage);

  const result = await upnetAgent.invoke({
    messages: [
      new SystemMessage(`
Follow the application-controlled workflow instruction below.
Use English or Roman Urdu naturally, keep the response short for WhatsApp,
ask only the requested question, and do not skip ahead in the workflow.

Workflow instruction:
${decision.instruction}
      `),
      ...conversation.messages,
    ],
  });

  const response = result.messages.at(-1);

  if (!response) {
    throw new Error("Agent returned no response");
  }

  const reply =
    typeof response.content === "string"
      ? response.content
      : JSON.stringify(response.content);

  console.log("AI Reply:", reply);

  conversation.messages.push(response);

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
