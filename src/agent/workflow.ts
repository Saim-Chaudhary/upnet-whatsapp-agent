import { ConversationStage } from "./conversation.js";

export type WorkflowDecision = {
  nextStage: ConversationStage;
  instruction: string;
};

export type CustomerIntent =
  | "greeting"
  | "internet_complaint"
  | "other"
  | "unclear";

function normalize(message: string): string {
  return message.toLowerCase().replace(/[.!?,]/g, " ").replace(/\s+/g, " ").trim();
}

function hasAny(message: string, phrases: string[]): boolean {
  return phrases.some((phrase) => message.includes(phrase));
}

function hasWord(message: string, words: string[]): boolean {
  return words.some((word) => new RegExp(`\\b${word}\\b`).test(message));
}

export function detectIntent(customerMessage: string): CustomerIntent {
  const message = normalize(customerMessage);
  const greeting = hasWord(message, [
    "hi",
    "hello",
    "hey",
  ]) || hasAny(message, [
    "salam",
    "assalam o alaikum",
    "assalamu alaikum",
    "good morning",
    "good evening",
    "how are you",
  ]);
  const internetComplaint = hasAny(message, [
    "internet",
    "wifi",
    "wi fi",
    "net ",
    "net down",
    "broadband",
  ]) && hasAny(message, [
    "not",
    "nahi",
    "ni ",
    "problem",
    "issue",
    "down",
    "slow",
    "kaam nahi",
    "kam nahi",
    "chl",
    "chal",
    "work",
    "connect",
    "band",
  ]);

  if (internetComplaint) {
    return "internet_complaint";
  }

  if (greeting && message.split(" ").length <= 6) {
    return "greeting";
  }

  return greeting ? "unclear" : "other";
}

export function decideNextStep(
  stage: ConversationStage,
  customerMessage: string,
): WorkflowDecision {
  const message = normalize(customerMessage);

  if (stage === "initial") {
    const intent = detectIntent(customerMessage);

    if (intent === "greeting") {
      return {
        nextStage: "initial",
        instruction:
          "Greet the customer warmly, welcome them to Upnet Internet support, and ask how you can help. Do not start troubleshooting or ask about router lights.",
      };
    }

    if (intent !== "internet_complaint") {
      return {
        nextStage: "initial",
        instruction:
          "Ask the customer what help they need with Upnet Internet. Do not start troubleshooting until they describe an internet problem.",
      };
    }

    return {
      nextStage: "router_check",
      instruction:
        "Acknowledge the internet complaint briefly and ask whether the router or ONT has a red or problem light.",
    };
  }

  if (stage === "router_check") {
    if (
      hasAny(message, [
        "all green",
        "sab green",
        "lights green",
        "no red",
        "red nahi",
        "red light nahi",
        "green hain",
      ])
    ) {
      return {
        nextStage: "restart_router",
        instruction:
          "Tell the customer that the lights look normal and ask them to switch the router off for 30 seconds, turn it back on, and confirm when the restart is done.",
      };
    }

    if (hasAny(message, ["red", "blinking red", "problem light", "los light"])) {
      return {
        nextStage: "restart_router",
        instruction:
          "Explain basic troubleshooting: check the power and internet cables, then switch the router or ONT off for 30 seconds and turn it back on. Ask the customer to confirm when the restart is done.",
      };
    }

    return {
      nextStage: "router_check",
      instruction:
        "The customer did not clearly answer the light question. Ask clearly whether there is a red/problem light or whether all router/ONT lights are green.",
    };
  }

  if (stage === "restart_router") {
    if (
      hasAny(message, [
        "restart kar diya",
        "restarted",
        "restart done",
        "rebooted",
        "kar diya",
        "done",
      ])
    ) {
      return {
        nextStage: "internet_status",
        instruction:
          "Thank the customer and ask whether the internet is working now.",
      };
    }

    return {
      nextStage: "restart_router",
      instruction:
        "Ask the customer to restart the router or ONT as instructed and confirm after it is done.",
    };
  }

  if (stage === "internet_status") {
    if (
      hasAny(message, [
        "working",
        "chal raha",
        "chal rha",
        "aa raha",
        "aa rha",
        "theek ho gaya",
        "it works",
        "yes",
        "haan",
      ])
    ) {
      return {
        nextStage: "resolved",
        instruction:
          "The internet is working again. Close the complaint politely in one short WhatsApp message.",
      };
    }

    if (
      hasAny(message, [
        "not working",
        "still not",
        "doesn't work",
        "doesnt work",
        "nahi chal",
        "nahi aa",
        "abhi bhi",
        "no",
        "nahi",
      ])
    ) {
      return {
        nextStage: "billing_check",
        instruction:
          "The restart did not fix the issue. Ask whether the internet bill is paid.",
      };
    }

    return {
      nextStage: "internet_status",
      instruction:
        "Ask clearly whether the internet is working now after the restart. Do not move to billing until the customer answers yes or no.",
    };
  }

  if (stage === "billing_check") {
    if (
      hasAny(message, [
        "not paid",
        "unpaid",
        "pending",
        "due",
        "paid nahi",
        "nahi paid",
        "bill nahi diya",
      ])
    ) {
      return {
        nextStage: "payment_required",
        instruction:
          "Explain politely that the unpaid bill must be paid before further troubleshooting, and stop the workflow without asking another troubleshooting question.",
      };
    }

    if (hasAny(message, ["paid", "payment done", "pay kar diya", "haan"])) {
      return {
        nextStage: "payment_proof",
        instruction:
          "The customer says the bill is paid. Ask them to send a payment receipt or screenshot as proof.",
      };
    }

    return {
      nextStage: "billing_check",
      instruction:
        "Ask clearly whether the internet bill is paid. Do not assume the answer from an unclear message.",
    };
  }

  if (stage === "payment_proof") {
    if (
      hasAny(message, [
        "screenshot",
        "proof",
        "receipt",
        " bhej",
        "send kar",
        "attached",
        "attach",
      ])
    ) {
      return {
        nextStage: "ready_for_ticket",
        instruction:
          "Thank the customer for the payment proof and tell them the complaint will be forwarded to the technical team. Do not claim that a ticket has already been created.",
      };
    }

    return {
      nextStage: "payment_proof",
      instruction:
        "Ask the customer to send a screenshot or receipt showing the bill payment.",
    };
  }

  if (stage === "ready_for_ticket") {
    return {
      nextStage: "ready_for_ticket",
      instruction:
        "Tell the customer briefly that their complaint is ready to be forwarded to the technical team and that no further action is needed right now.",
    };
  }

  if (stage === "payment_required") {
    return {
      nextStage: "payment_required",
      instruction:
        "Repeat politely that payment of the outstanding bill is required before troubleshooting can continue.",
    };
  }

  return {
    nextStage: "resolved",
    instruction:
      "Close the complaint politely because the internet is working again.",
  };
}
