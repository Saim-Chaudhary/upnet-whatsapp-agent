import { BaseMessage } from "@langchain/core/messages";

export type ConversationStage =
  | "initial"
  | "router_check"
  | "restart_router"
  | "internet_status"
  | "billing_check"
  | "payment_proof"
  | "ready_for_ticket"
  | "resolved"
  | "payment_required";

export type ConversationState = {
  messages: BaseMessage[];
  stage: ConversationStage;
};

const conversations = new Map<string, ConversationState>();

export function getConversation(chatId: string): ConversationState {
  let conversation = conversations.get(chatId);

  if (!conversation) {
    conversation = {
      messages: [],
      stage: "initial",
    };
    conversations.set(chatId, conversation);
  }

  return conversation;
}

export function resetConversation(chatId: string): boolean {
  return conversations.delete(chatId);
}