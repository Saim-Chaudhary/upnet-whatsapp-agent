import { FastifyInstance } from "fastify";
import { handleAgentMessage } from "../agent/service.js";
import { resetConversation } from "../agent/conversation.js";

type LocalChatRequest = {
  Params: { conversationId: string };
  Body: { message?: unknown };
};

export default async function localRoutes(app: FastifyInstance) {
  app.post<LocalChatRequest>(
    "/local/chat/:conversationId",
    async (request, reply) => {
      const message = request.body?.message;

      if (typeof message !== "string" || message.trim().length === 0) {
        return reply.code(400).send({
          error: "message must be a non-empty string",
        });
      }

      return handleAgentMessage(
        request.params.conversationId,
        message.trim(),
      );
    },
  );

  app.delete<{ Params: { conversationId: string } }>(
    "/local/chat/:conversationId",
    async (request) => ({
      reset: resetConversation(request.params.conversationId),
      conversationId: request.params.conversationId,
    }),
  );
}
