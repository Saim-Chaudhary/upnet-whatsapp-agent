import { HumanMessage } from "@langchain/core/messages";
import { upnetAgent } from "./agent/upnetAgent.js";

const result = await upnetAgent.invoke({
  messages: [
    new HumanMessage("Mera internet nahi chal raha"),
  ],
});

const response = result.messages.at(-1);

if (!response) {
  throw new Error("Agent returned no messages");
}

console.log(response.content);