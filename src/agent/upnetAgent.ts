import { BaseMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { StateGraph, MessagesAnnotation } from "@langchain/langgraph";
import { initChatModel } from "langchain";
import { z } from "zod";
import dotenv from "dotenv";
import {
  ClassifiedIntent,
  CustomerIntent,
  IntentConfidence,
  isClassifiedIntent,
} from "./workflow.js";
import { ConversationStage } from "./conversation.js";

dotenv.config();

const model = await initChatModel("openai/gpt-oss-20b", {
  apiKey: process.env.GROQ_API_KEY,
  modelProvider: "groq",
  temperature: 0,
});

const intentSchema = z.object({
  intent: z.enum([
    "greeting",
    "internet_complaint",
    "service_status",
    "router_red_light",
    "router_no_red_light",
    "restart_completed",
    "internet_working",
    "internet_not_working",
    "bill_paid",
    "bill_unpaid",
    "payment_proof_sent",
    "payment_proof_pending",
    "unclear",
    "other",
  ]),
  confidence: z.enum(["high", "medium", "low"]),
});

export type IntentClassificationInput = {
  stage: ConversationStage;
  latestMessage: string;
  recentMessages: BaseMessage[];
};

export type IntentClassifier = (
  input: IntentClassificationInput,
) => Promise<ClassifiedIntent>;

const structuredIntentModel = model.withStructuredOutput(intentSchema);

function formatRecentMessages(messages: BaseMessage[]): string {
  return messages
    .slice(-6)
    .map((message) => {
      const role =
        message.getType() === "human"
          ? "Customer"
          : message.getType() === "ai"
            ? "Assistant"
            : "System";
      return `${role}: ${String(message.content)}`;
    })
    .join("\n");
}

export const classifyIntent: IntentClassifier = async ({
  stage,
  latestMessage,
  recentMessages,
}) => {
  const result = await structuredIntentModel.invoke([
    new SystemMessage(`
Classify the latest Upnet Internet customer message into exactly one intent.
Understand English and Roman Urdu. Use the current stage and recent context to
interpret short answers such as "yes", "no", "haan", "nahi", "paid", and
"done". Return "unclear" with low confidence when the meaning is ambiguous.
Return "other" for requests unrelated to Upnet Internet.
Do not choose a workflow stage and do not infer actions that were not stated.

Allowed intents:
- greeting, internet_complaint, service_status, other
- router_red_light, router_no_red_light
- restart_completed, internet_working, internet_not_working
- bill_paid, bill_unpaid
- payment_proof_sent, payment_proof_pending
- unclear
    `),
    new HumanMessage(`
Current stage: ${stage}
Recent conversation:
${formatRecentMessages(recentMessages) || "(none)"}

Latest customer message:
${latestMessage}
    `),
  ]);

  if (!isClassifiedIntent(result)) {
    throw new Error("Intent classifier returned invalid structured output");
  }

  return {
    intent: result.intent as CustomerIntent,
    confidence: result.confidence as IntentConfidence,
  };
};

const graph = new StateGraph(MessagesAnnotation)
  .addNode("agent", async (state) => {
    const response = await model.invoke([
      new SystemMessage(`
You are the customer support AI agent for Upnet Internet.

Your job is to help customers with Upnet internet-related problems.

Rules:
- Only discuss Upnet Internet customer support.
- Understand English and Roman Urdu.
- Use the conversation history to understand short replies such as:
  "yes", "no", "haan", "nahi", "paid", "not paid", etc.
- Do not ask unnecessary questions.
- Ask one useful question at a time.
- Keep responses short and suitable for WhatsApp.
- Follow the application workflow instruction exactly. It is authoritative
  about the current stage and next step; never repeat an answered question or
  skip a required step.
- Never claim payment verification, ticket creation, complaint forwarding, or
  any other external action that the application has not performed.
- Never invent payment methods, account details, or payment links.
- Do not act as a general-purpose personal assistant.
- If the customer asks something unrelated to Upnet Internet, politely say that you can only help with Upnet Internet services.

For an internet-down complaint, start troubleshooting by checking whether there is a red light on the router.

Example:

Customer:
"Mera internet nahi chal raha"

Agent:
"I understand. Your internet is not working. Is there any red light showing on your router?"

If the customer then says:
"No"

Understand that "No" means there is no red light on the router and continue the troubleshooting conversation instead of asking what "No" means.
      `),
      ...state.messages,
    ]);

    return {
      messages: [response],
    };
  })
  .addEdge("__start__", "agent")
  .addEdge("agent", "__end__");

export const upnetAgent = graph.compile();
