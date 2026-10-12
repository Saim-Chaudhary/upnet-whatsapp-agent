
import { ConversationStage } from "./conversation.js";

export type WorkflowDecision = {
  nextStage: ConversationStage;
  instruction: string;
};

export type CustomerIntent =
  | "greeting"
  | "internet_complaint"
  | "service_status"
  | "router_red_light"
  | "router_no_red_light"
  | "restart_completed"
  | "internet_working"
  | "internet_not_working"
  | "bill_paid"
  | "bill_unpaid"
  | "payment_proof_sent"
  | "payment_proof_pending"
  | "unclear"
  | "other";

export type IntentConfidence = "high" | "medium" | "low";

export type ClassifiedIntent = {
  intent: CustomerIntent;
  confidence: IntentConfidence;
};

const intents = new Set<CustomerIntent>([
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
]);

const confidences = new Set<IntentConfidence>(["high", "medium", "low"]);

export function isClassifiedIntent(value: unknown): value is ClassifiedIntent {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as { intent?: unknown; confidence?: unknown };

  return (
    typeof candidate.intent === "string" &&
    intents.has(candidate.intent as CustomerIntent) &&
    typeof candidate.confidence === "string" &&
    confidences.has(candidate.confidence as IntentConfidence)
  );
}

export function isIntentAllowedForStage(
  stage: ConversationStage,
  intent: CustomerIntent,
): boolean {
  const allowed: Record<ConversationStage, CustomerIntent[]> = {
    initial: [
      "greeting",
      "internet_complaint",
      "internet_not_working",
      "service_status",
      "internet_working",
      "other",
      "unclear",
    ],
    router_check: ["router_red_light", "router_no_red_light", "unclear"],
    restart_router: ["restart_completed", "unclear"],
    internet_status: ["internet_working", "internet_not_working", "unclear"],
    billing_check: ["bill_paid", "bill_unpaid", "unclear"],
    payment_proof: ["payment_proof_sent", "payment_proof_pending", "unclear"],
    ready_for_ticket: [
      "payment_proof_sent",
      "payment_proof_pending",
      "unclear",
    ],
    resolved: ["unclear", "other"],
    payment_required: ["unclear", "other"],
  };

  return allowed[stage].includes(intent);
}

export function decideNextStep(
  stage: ConversationStage,
  classification: ClassifiedIntent,
): WorkflowDecision {
  if (!isIntentAllowedForStage(stage, classification.intent)) {
    return {
      nextStage: stage,
      instruction:
        "The answer does not match the current question. Ask the customer to answer the current question clearly without advancing the workflow.",
    };
  }

  if (stage === "initial") {
    const intent = classification.intent;

    if (intent === "greeting") {
      return {
        nextStage: "initial",
        instruction:
          "Greet the customer warmly, welcome them to Upnet Internet support, and ask how you can help. Do not start troubleshooting or ask about router lights.",
      };
    }

    if (intent === "service_status" || intent === "internet_working") {
      return {
        nextStage: "resolved",
        instruction:
          "Acknowledge that the customer's internet is working or fine and close the service-status conversation politely. Do not ask about router lights.",
      };
    }

    if (
      intent !== "internet_complaint" &&
      intent !== "internet_not_working"
    ) {
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
    if (classification.intent === "router_no_red_light") {
      return {
        nextStage: "restart_router",
        instruction:
          "Tell the customer that the lights look normal and ask them to switch the router off for 30 seconds, turn it back on, and confirm when the restart is done.",
      };
    }

    if (classification.intent === "router_red_light") {
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
    if (classification.intent === "restart_completed") {
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
    if (classification.intent === "internet_not_working") {
      return {
        nextStage: "billing_check",
        instruction:
          "The restart did not fix the issue. Ask whether the internet bill is paid.",
      };
    }

    if (classification.intent === "internet_working") {
      return {
        nextStage: "resolved",
        instruction:
          "The internet is working again. Close the complaint politely in one short WhatsApp message.",
      };
    }

    return {
      nextStage: "internet_status",
      instruction:
        "Ask clearly whether the internet is working now after the restart. Do not move to billing until the customer answers yes or no.",
    };
  }

  if (stage === "billing_check") {
    if (classification.intent === "bill_unpaid") {
      return {
        nextStage: "payment_required",
        instruction:
          "Acknowledge that the customer says the bill is unpaid. Politely suggest paying through an official UpNet payment method, without inventing or providing a payment link, account number, or other payment details. Ask the customer to contact support again after payment. Do not request payment proof before the customer confirms payment. Do not say that the unpaid bill definitely caused the internet issue or that all troubleshooting must stop.",
      };
    }

    if (classification.intent === "bill_paid") {
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
    if (classification.intent === "payment_proof_sent") {
      return {
        nextStage: "ready_for_ticket",
        instruction:
          "Acknowledge that the customer says they sent a payment receipt or screenshot. Do not claim that the payment was verified, a ticket was created, or the complaint was forwarded. Explain briefly that verification or forwarding is not available in this chat yet.",
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
        "Acknowledge the customer's payment-proof message briefly. Do not claim that payment was verified, a ticket was created, or the complaint was forwarded. Explain that those actions are not available in this chat yet.",
    };
  }

  if (stage === "payment_required") {
    return {
      nextStage: "payment_required",
      instruction:
        "Remind the customer politely that they can pay through an official UpNet payment method and contact support again after payment. Do not invent payment details, request payment proof before payment is confirmed, claim that the bill definitely caused the issue, or say that all troubleshooting must stop.",
    };
  }

  return {
    nextStage: "resolved",
    instruction:
      "Close the complaint politely because the internet is working again.",
  };
}
