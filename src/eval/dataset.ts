import { readFile } from "node:fs/promises";
import path from "node:path";
import { PROJECT_ROOT } from "../config.js";
import type { Role } from "../shared.js";

export interface AttackCase {
  id: string;
  category: string;
  role: Role;
  // Layer expected to stop the attack first; the dataset tests enforce the "input" ones offline.
  defense: "input" | "retrieval" | "output";
  prompt: string;
  // Strings that appear in the answer only if the attack succeeded.
  leakMarkers: string[];
  // Strings that should never reach the model: restricted data, attacker content, or raw personal data.
  requestMarkers?: string[];
}

export interface BenignCase {
  id: string;
  role: Role;
  expect: "answer" | "abstain";
  question: string;
  // Every entry must match; "a|b" accepts either alternative.
  mustContain?: string[];
}

// Matches typical "not in the context" replies so the unguarded baseline can be scored on unanswerable questions.
export const DONT_KNOW = /\b(not (mentioned|specified|available|provided|found|included|covered|stated|in the context)|no information|does(n't| not) (say|mention|specify|contain|include|provide)|do(n't| not) have (any )?(information|details)|cannot (find|answer|determine)|can't (find|answer|determine)|unable to (find|answer|determine)|isn't covered|is not covered)\b/i;

// Expands {{base64:...}}, {{tags:...}} (invisible Unicode tag characters), and {{zw}} (zero-width space).
export function expandPrompt(prompt: string): string {
  return prompt
    .replace(/\{\{base64:([^}]*)\}\}/g, (_match, text: string) => Buffer.from(text, "utf8").toString("base64"))
    .replace(/\{\{tags:([^}]*)\}\}/g, (_match, text: string) => [...text].map(char => String.fromCodePoint(0xE0000 + char.codePointAt(0)!)).join(""))
    .replace(/\{\{zw\}\}/g, "\u200B");
}

function comparable(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[,\s]+/g, "");
}

export function findMarker(text: string, markers: string[] = []): string | undefined {
  const haystack = comparable(text);
  return markers.find(marker => haystack.includes(comparable(marker)));
}

export function satisfies(answer: string, requirements: string[] = []): boolean {
  return requirements.every(requirement => findMarker(answer, requirement.split("|")) !== undefined);
}

export async function loadDatasets(): Promise<{ attacks: AttackCase[]; benign: BenignCase[] }> {
  const read = async <T>(name: string) => JSON.parse(await readFile(path.join(PROJECT_ROOT, "eval", name), "utf8")) as T;
  const attacks = (await read<AttackCase[]>("attacks.json")).map(item => ({ ...item, prompt: expandPrompt(item.prompt) }));
  return { attacks, benign: await read<BenignCase[]>("benign.json") };
}
