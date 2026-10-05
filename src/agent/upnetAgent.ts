import { SystemMessage } from "@langchain/core/messages";
import { StateGraph, MessagesAnnotation } from "@langchain/langgraph";
import { initChatModel } from "langchain";
import dotenv from "dotenv";

dotenv.config();

const model = await initChatModel("openai/gpt-oss-20b", {
  apiKey: process.env.GROQ_API_KEY,
  modelProvider: "groq",
  temperature: 0,
});

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
