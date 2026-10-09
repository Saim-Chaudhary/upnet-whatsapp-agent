import { HumanMessage, SystemMessage, BaseMessage } from "@langchain/core/messages";
import { upnetAgent } from "./upnetAgent.js";
import { getConversation } from "./conversation.js";
import { decideNextStep, detectIntent } from "./workflow.js";

export type AgentInvocation = (
  messages: BaseMessage[],
) => Promise<{ messages: BaseMessage[] }>;

async function invokeUpnetAgent(messages: BaseMessage[]) {
  return upnetAgent.invoke({ messages });
}

export type AgentReply = {
  conversationId: string;
  reply: string;
  stage: ReturnType<typeof getConversation>["stage"];
};

export async function handleAgentMessage(
  conversationId: string,
  message: string,
  invoke: AgentInvocation = invokeUpnetAgent,
): Promise<AgentReply> {
  const conversation = getConversation(conversationId);
  const currentStage = conversation.stage;
  const intent = currentStage === "initial" ? detectIntent(message) : undefined;
  const decision = decideNextStep(currentStage, message);

  conversation.messages.push(new HumanMessage(message));
  conversation.stage = decision.nextStage;

  if (intent) {
    console.log("Intent:", intent);
  }
  console.log("Stage:", currentStage);
  console.log("Customer:", message);
  console.log("Next stage:", decision.nextStage);

  const result = await invoke([
    new SystemMessage(`
Follow the application-controlled workflow instruction below.
Use English or Roman Urdu naturally, keep the response short for WhatsApp,
ask only the requested question, and do not skip ahead in the workflow.
The workflow decision is authoritative: do not repeat a question the customer
has already answered, do not claim an action or verification that the system
has not performed, and do not add payment methods or account details.

Workflow instruction:
${decision.instruction}
    `),
    ...conversation.messages,
  ]);

  const response = result.messages.at(-1);
  if (!response) {
    throw new Error("Agent returned no response");
  }

  const reply =
    typeof response.content === "string"
      ? response.content
      : JSON.stringify(response.content);

  conversation.messages.push(response);

  return {
    conversationId,
    reply,
    stage: conversation.stage,
  };
}
