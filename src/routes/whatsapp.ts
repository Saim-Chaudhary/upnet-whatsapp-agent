
import "dotenv/config";

import { FastifyInstance } from "fastify";
import axios from "axios";
import { handleAgentMessage } from "../agent/service.js";
import { AgentStores } from "../agent/persistence.js";
import {
  createPostgresTicketRepository,
  TicketRepository,
  TicketStatus,
} from "../tickets/repository.js";
import type { AgentReply } from "../agent/service.js";

async function whatsappRoutes(
  app: FastifyInstance,
  options: { stores: AgentStores; tickets?: TicketRepository },
) {
  app.post("/webhook/whatsapp", async (request) => {
    const payload = request.body as any;
    const message = payload?.data;

    if (!message || typeof message !== "object") {
      return { received: false, reason: "Invalid message payload" };
    }

    console.log("From:", message.from);
    console.log("ChatId:", message.chatId);
    console.log("Body:", message.body);

    processWhatsAppMessage(
      message,
      options.stores,
      options.tickets,
    ).catch((error) => {
      console.error("Message processing failed:", error);
    });

    return { received: true };
  });

  app.delete<{ Params: { chatId: string } }>(
    "/webhook/whatsapp/conversations/:chatId",
    async (request) => {
      const wasReset = await options.stores.conversation.reset(
        request.params.chatId,
      );

      return {
        reset: wasReset,
        chatId: request.params.chatId,
      };
    },
  );
}

async function processWhatsAppMessage(
  message: any,
  stores: AgentStores,
  ticketRepository?: TicketRepository,
) {
  const chatId = message.chatId || message.from;

  if (typeof chatId !== "string" || !chatId.trim()) {
    console.warn("Ignoring WhatsApp message without a chat ID.");
    return;
  }

  const customerPhone = normalizeWhatsAppPhone(
    message.author ?? message.from,
  );
  const requestId = getWhatsAppMessageId(message);
  const body =
    typeof message.body === "string" ? message.body.trim() : "";

  const command = parseAdminTicketCommand(body);
  const adminNumber = normalizeWhatsAppPhone(
    process.env.ADMIN_WHATSAPP_NUMBER,
  );

  if (
    command &&
    adminNumber &&
    isAuthorizedAdminSender(message.author ?? message.from)
  ) {
    const result = await processAdminTicketCommand(
      message,
      command,
      stores,
      ticketRepository ?? createPostgresTicketRepository(),
    );

    if (!result || result.replayed) return;

    await sendWhatsAppText(message.from, result.reply);
    return;
  }

  if (command && adminNumber && customerPhone !== adminNumber) {
    await sendWhatsAppText(
      message.from,
      "This ticket command is only available to the authorized UpNet administrator.",
    );
    return;
  }

  // Ignore empty messages unless they appear to contain an image.
  const imageReceived = isIncomingImage(message);

  if (!body && !imageReceived) {
    console.log("Ignoring empty WhatsApp message.");
    return;
  }

  // The existing agent processes text, not image bytes.
  // For an image-only message, pass a description of the submission
  // through the normal workflow. This does not verify the payment.
  const agentMessage =
    body ||
    "I have sent an image as payment proof. Please process it as submitted proof, not as verified payment.";

  const result = await handleAgentMessage(
    chatId,
    agentMessage,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      ...(requestId ? { requestId } : {}),
      ...(customerPhone ? { customerPhone } : {}),
      source: "whatsapp",
    },
    stores.conversation,
    stores.inbound,
  );

  if (result.replayed) return;

  console.log("AI Reply:", result.reply);

  await sendWhatsAppText(message.from, result.reply);
}

function isIncomingImage(message: any): boolean {
  const type = String(
    message.type ?? message.messageType ?? "",
  ).toLowerCase();

  const mimetype = String(
    message.mimetype ??
      message.mimeType ??
      message.media?.mimetype ??
      message.media?.mimeType ??
      "",
  ).toLowerCase();

  // Explicit image type or MIME type.
  if (type === "image" || mimetype.startsWith("image/")) {
    return true;
  }

  // Some WhatsApp integrations identify media with a boolean flag.
  if (message.isMedia === true && type.includes("image")) {
    return true;
  }

  // Other payloads may expose a nested image object.
  if (
    message.image &&
    typeof message.image === "object"
  ) {
    return true;
  }

  return false;
}

export function parseAdminTicketCommand(
  value: unknown,
): { ticketNumber: string; status: TicketStatus } | undefined {
  if (typeof value !== "string") return undefined;

  const match = /^\s*(UP-\d+)\s+(OPEN|IN_PROGRESS|RESOLVED)\s*$/i.exec(
    value,
  );

  if (!match) return undefined;

  const status =
    match[2]?.toUpperCase() === "IN_PROGRESS"
      ? "In Progress"
      : match[2]?.toUpperCase() === "RESOLVED"
        ? "Resolved"
        : "Open";

  return {
    ticketNumber: match[1]!.toUpperCase(),
    status,
  };
}

export function isAuthorizedAdminSender(
  value: unknown,
): boolean {
  const configured = normalizeWhatsAppPhone(
    process.env.ADMIN_WHATSAPP_NUMBER,
  );

  return Boolean(
    configured && normalizeWhatsAppPhone(value) === configured,
  );
}

export async function processAdminTicketCommand(
  message: any,
  command: { ticketNumber: string; status: TicketStatus },
  stores: AgentStores,
  tickets: Pick<
    TicketRepository,
    "getTicketDetail" | "updateTicket"
  >,
): Promise<AgentReply | undefined> {
  const phone =
    normalizeWhatsAppPhone(message.author ?? message.from) ??
    "unknown";

  const conversationId = `admin:${phone}`;
  const requestId = getWhatsAppMessageId(message);

  if (requestId && stores.inbound) {
    const claim = await stores.inbound.claim(
      requestId,
      conversationId,
    );

    if (claim.kind === "completed") {
      return { ...claim.reply, replayed: true };
    }

    if (claim.kind === "processing") return undefined;
  }

  try {
    if (!tickets.getTicketDetail || !tickets.updateTicket) {
      throw new Error("Ticket updates are unavailable");
    }

    const detail = await tickets.getTicketDetail(
      command.ticketNumber,
    );

    if (!detail) throw new Error("Ticket not found");

    const updated = await tickets.updateTicket(
      command.ticketNumber,
      {
        status: command.status,
        expectedUpdatedAt: detail.ticket.updatedAt,
        actorId: `whatsapp-admin:${phone}`,
      },
    );

    const result: AgentReply = {
      conversationId,
      reply: `${command.ticketNumber} is now ${updated.ticket.status}.`,
      stage: "initial",
    };

    if (requestId && stores.inbound) {
      await stores.inbound.complete(requestId, result);
    }

    return result;
  } catch (error) {
    if (requestId && stores.inbound) {
      await stores.inbound.fail(requestId);
    }

    const messageText =
      error instanceof Error ? error.message : "Command failed";

    return {
      conversationId,
      reply: `Could not update ${command.ticketNumber}: ${messageText}.`,
      stage: "initial",
    };
  }
}

export async function sendWhatsAppText(
  chatId: string,
  text: string,
): Promise<void> {
  const sendResponse = await axios.post(
    `${process.env.OPENWA_URL}/api/sessions/${process.env.OPENWA_SESSION_ID}/messages/send-text`,
    { chatId, text },
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

function getWhatsAppMessageId(
  message: any,
): string | undefined {
  const candidate =
    message.id ?? message.messageId ?? message.msgId;

  const id =
    typeof candidate === "string"
      ? candidate
      : candidate &&
          typeof candidate === "object" &&
          typeof candidate._serialized === "string"
        ? candidate._serialized
        : undefined;

  return id?.trim() ? id.trim() : undefined;
}

export function normalizeWhatsAppPhone(
  value: unknown,
): string | undefined {
  if (
    typeof value !== "string" ||
    value.trim().length === 0
  ) {
    return undefined;
  }

  const [identifier, addressType] = value.trim().split("@", 2);

  if (addressType === "g.us" || !identifier) {
    return undefined;
  }

  const digits = identifier.replace(/[^\d+]/g, "");

  return digits.length > 0 ? digits : undefined;
}

export default whatsappRoutes;
