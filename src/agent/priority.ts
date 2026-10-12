import { initChatModel } from "langchain";
import { z } from "zod";

export type Priority = "Normal" | "High" | "Urgent";

export type PriorityAssessmentInput = {
  problemDescription: string;
  customerImpact: string;
  customerType?: string;
};

export type PriorityAssessment = {
  priority: Priority;
  reason: string;
  missingInformation: string[];
};

const prioritySchema = z.object({
  priority: z.enum(["Normal", "High", "Urgent"]),
  reason: z.string().min(1).max(300),
  missingInformation: z.array(z.string().min(1).max(160)),
});

export type PriorityModelInvoker = (
  input: PriorityAssessmentInput,
) => Promise<unknown> | unknown;

function safeAssessment(_input: PriorityAssessmentInput): PriorityAssessment {
  return {
    priority: "Normal",
    reason: "Customer impact is not sufficiently confirmed for a higher priority.",
    missingInformation: [
      "How many customers or locations are affected?",
      "Is there a safety, business-critical, or complete service impact?",
    ],
  };
}

export const assessPriority: PriorityModelInvoker = async (input) => {
  const priorityModel = await initChatModel("openai/gpt-oss-20b", {
    apiKey: process.env.GROQ_API_KEY,
    modelProvider: "groq",
    temperature: 0,
  });
  const result = await (
    priorityModel.withStructuredOutput(prioritySchema)
  ).invoke([
    {
      role: "system",
      content:
        "Recommend a support priority from Normal, High, or Urgent. This is only a recommendation, not official UpNet policy. Base it on actual customer impact, not keywords. A business connection is not automatically Urgent. If impact is unclear, choose Normal and list missing information. Never invent response times or escalation commitments.",
    },
    {
      role: "user",
      content: JSON.stringify(input),
    },
  ]);

  const parsed = prioritySchema.safeParse(result);
  if (!parsed.success) {
    return safeAssessment(input);
  }

  return parsed.data;
};

export function validatePriorityAssessment(
  value: unknown,
): value is PriorityAssessment {
  return prioritySchema.safeParse(value).success;
}

export { safeAssessment };
