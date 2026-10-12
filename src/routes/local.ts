import { FastifyInstance } from "fastify";
import { handleAgentMessage } from "../agent/service.js";
import { AgentStores } from "../agent/persistence.js";

type LocalChatRequest = {
  Params: { conversationId: string };
  Body: { message?: unknown; requestId?: unknown; customerPhone?: unknown };
};

export default async function localRoutes(
  app: FastifyInstance,
  options: { stores: AgentStores },
) {
  app.post<LocalChatRequest>(
    "/local/chat/:conversationId",
    async (request, reply) => {
      const message = request.body?.message;

      if (typeof message !== "string" || message.trim().length === 0) {
        return reply.code(400).send({
          error: "message must be a non-empty string",
        });
      }

      const stores = options.stores;
      return handleAgentMessage(
        request.params.conversationId,
        message.trim(),
        undefined,
        undefined,
        undefined,
        undefined,
        {
          ...(typeof request.body?.requestId === "string" &&
          request.body.requestId.trim()
            ? { requestId: request.body.requestId.trim() }
            : {}),
          ...(typeof request.body?.customerPhone === "string" &&
          request.body.customerPhone.trim()
            ? { customerPhone: request.body.customerPhone.trim() }
            : {}),
        },
        stores.conversation,
      );
    },
  );

  app.delete<{ Params: { conversationId: string } }>(
    "/local/chat/:conversationId",
    async (request) => ({
      reset: await options.stores.conversation.reset(
        request.params.conversationId,
      ),
      conversationId: request.params.conversationId,
    }),
  );
}
