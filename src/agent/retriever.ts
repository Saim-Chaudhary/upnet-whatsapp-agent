import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type KnowledgePassage = {
  source: string;
  text: string;
  score: number;
};

type KnowledgeDocument = {
  source: string;
  passages: string[];
};

const knowledgeDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "knowledge",
);

const knowledgeFiles = [
  "internet-troubleshooting.md",
  "billing-and-payment.md",
  "maintenance-and-outages.md",
  "office-and-support.md",
] as const;

const stopWords = new Set([
  "a",
  "about",
  "am",
  "an",
  "and",
  "are",
  "can",
  "for",
  "how",
  "i",
  "is",
  "it",
  "my",
  "of",
  "on",
  "or",
  "the",
  "to",
  "what",
  "with",
]);

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2 && !stopWords.has(token));
}

function loadDocuments(): KnowledgeDocument[] {
  return knowledgeFiles.map((source) => {
    const content = readFileSync(resolve(knowledgeDirectory, source), "utf8");
    const passages = content
      .split(/\n\s*\n/)
      .map((passage) => passage.trim())
      .filter(Boolean);

    return { source, passages };
  });
}

const documents = loadDocuments();

export function retrieveKnowledge(
  query: string,
  limit = 3,
): KnowledgePassage[] {
  const queryTokens = new Set(tokenize(query));
  if (queryTokens.size === 0) {
    return [];
  }

  return documents
    .flatMap(({ source, passages }) =>
      passages.map((text) => {
        const passageTokens = new Set(tokenize(text));
        const score = [...queryTokens].filter((token) =>
          passageTokens.has(token),
        ).length;
        return { source, text, score };
      }),
    )
    .filter((passage) => passage.score >= 2)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}

export function formatKnowledgeContext(query: string): string {
  const passages = retrieveKnowledge(query);
  if (passages.length === 0) {
    return "No relevant confirmed knowledge was found for this message.";
  }

  return passages
    .map(
      (passage, index) =>
        `[Reference ${index + 1} | ${passage.source}]\n${passage.text}`,
    )
    .join("\n\n");
}
