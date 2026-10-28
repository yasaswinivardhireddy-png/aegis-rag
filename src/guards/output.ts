import { z } from "zod";
import { worstVerdict, type Check, type LayerReport, type Outcome } from "../shared.js";
import { checkGrounding } from "./groundedness.js";
import { findPii } from "./pii.js";
import { sanitizeAnswer } from "./sanitize.js";

export const NOT_FOUND_MESSAGE = "I couldn't find this in the documents available to you.";
export const UNVERIFIED_MESSAGE = "I couldn't verify an answer against the documents available to you, so I won't guess.";
export const WITHHELD_MESSAGE = "The response was withheld because it failed a safety check.";

const ModelAnswer = z.object({
  answer: z.string().max(4000),
  citations: z.array(z.union([z.string().max(20), z.number().int()])).max(10),
  insufficient_context: z.boolean()
});

const SECRET = /\b(sk-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{30,}|AQ\.[A-Za-z0-9_-]{30,}|gh[pousr]_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16})\b|-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const CITATION_MARKERS = /\s*[[(]\s*(?:sources?\s*)?S\d+(?:\s*[,;]\s*S\d+)*\s*[\])]/gi;

export interface OutputSource {
  alias: string;
  text: string;
}

export interface OutputContext {
  sources: OutputSource[];
  canary: string;
  fingerprints: string[];
  allowedLinkHosts: string[];
  internalEmailDomains: string[];
}

export interface OutputGuardResult {
  outcome: Outcome;
  answer: string;
  citedAliases: string[];
  report: LayerReport;
}

function parseModelAnswer(content: string): z.infer<typeof ModelAnswer> | undefined {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  let parsed: z.infer<typeof ModelAnswer> | undefined;
  if (start >= 0 && end > start) {
    try {
      const candidate = ModelAnswer.safeParse(JSON.parse(trimmed.slice(start, end + 1)));
      parsed = candidate.success ? candidate.data : undefined;
    } catch {
      parsed = undefined;
    }
  }
  return parsed;
}

function normalizeAlias(citation: string | number): string {
  const value = String(citation).replace(/[[\]()\s]/g, "").toUpperCase();
  return /^\d+$/.test(value) ? `S${value}` : value;
}

function digits(value: string): string {
  return value.replace(/\D/g, "");
}

// Checks run in order of severity: leaks block, unverifiable answers abstain, fixable issues are repaired and disclosed.
export function guardOutput(content: string, context: OutputContext): OutputGuardResult {
  const checks: Check[] = [];
  const finish = (outcome: Outcome, answer: string, citedAliases: string[] = []): OutputGuardResult => ({
    outcome,
    answer,
    citedAliases,
    report: { layer: "output", verdict: worstVerdict(checks.map(check => check.verdict)), checks }
  });

  const lowered = content.toLowerCase();
  if (content.includes(context.canary) || context.fingerprints.some(fingerprint => lowered.includes(fingerprint.toLowerCase()))) {
    checks.push({ name: "Instruction leakage", verdict: "block", detail: "Response contained the canary token or system-prompt text" });
    return finish("blocked", WITHHELD_MESSAGE);
  }
  if (SECRET.test(content)) {
    checks.push({ name: "Secret detection", verdict: "block", detail: "Response contained a credential-like string" });
    return finish("blocked", WITHHELD_MESSAGE);
  }
  checks.push({ name: "Leakage checks", verdict: "pass", detail: "No canary, system-prompt text, or credentials" });

  const parsed = parseModelAnswer(content);
  if (!parsed) {
    checks.push({ name: "Response schema", verdict: "warn", detail: "Response did not match the answer schema" });
    return finish("abstained", UNVERIFIED_MESSAGE);
  }
  checks.push({ name: "Response schema", verdict: "pass", detail: "Valid answer JSON" });

  const draft = parsed.answer.replace(CITATION_MARKERS, "").trim();
  if (parsed.insufficient_context || !draft) {
    checks.push({ name: "Model abstention", verdict: "pass", detail: "Model reported that the sources do not answer the question" });
    return finish("abstained", NOT_FOUND_MESSAGE);
  }

  const known = new Set(context.sources.map(source => source.alias));
  const cited = [...new Set(parsed.citations.map(normalizeAlias))];
  const unknown = cited.filter(alias => !known.has(alias));
  if (!cited.length || unknown.length) {
    checks.push({ name: "Citation check", verdict: "warn", detail: cited.length ? `Cited unknown source(s): ${unknown.join(", ")}` : "Answer cited no sources" });
    return finish("abstained", UNVERIFIED_MESSAGE);
  }
  checks.push({ name: "Citation check", verdict: "pass", detail: `Cites ${cited.join(", ")}` });

  const sanitized = sanitizeAnswer(draft, context.allowedLinkHosts);
  checks.push({
    name: "Link and markup sanitization",
    verdict: sanitized.changes.length ? "warn" : "pass",
    detail: sanitized.changes.length ? sanitized.changes.join("; ") : "No links, images, or HTML"
  });

  const sourceText = context.sources.map(source => source.text).join("\n");
  const sourceDigits = digits(sourceText);
  let answer = sanitized.text;
  const unexpected = findPii(answer, context.internalEmailDomains).filter(match => match.kind === "email" || match.kind === "pan"
    ? !sourceText.toLowerCase().includes(match.value.toLowerCase())
    : !sourceDigits.includes(digits(match.value)));
  for (const match of unexpected) {
    answer = answer.split(match.value).join(`[REDACTED_${match.kind.toUpperCase()}]`);
  }
  checks.push({
    name: "Personal data",
    verdict: unexpected.length ? "warn" : "pass",
    detail: unexpected.length ? `Redacted ${unexpected.length} item(s) not present in the authorised sources` : "No personal data outside the authorised sources"
  });

  const grounding = checkGrounding(answer, context.sources.map(source => source.text));
  const unsupported = grounding.filter(sentence => !sentence.supported);
  const numbers = [...new Set(unsupported.flatMap(sentence => sentence.unsupportedNumbers))];
  const detail = `${grounding.length - unsupported.length}/${grounding.length} sentence(s) supported by the sources${numbers.length ? `; unsupported numbers: ${numbers.join(", ")}` : ""}`;
  if (!grounding.length || unsupported.length === grounding.length) {
    checks.push({ name: "Grounding", verdict: "warn", detail });
    return finish("abstained", UNVERIFIED_MESSAGE);
  }
  for (const sentence of unsupported) {
    answer = answer.replace(sentence.sentence, "");
  }
  answer = answer.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (unsupported.length) {
    answer += `\n\n(${unsupported.length} statement(s) removed because they could not be verified against the sources.)`;
  }
  checks.push({ name: "Grounding", verdict: unsupported.length ? "warn" : "pass", detail });
  return finish("answered", answer, cited);
}
