import { worstVerdict, type Check, type LayerReport, type Verdict } from "../shared.js";
import { BLOCK_THRESHOLD, WARN_THRESHOLD, describeFindings, detectInjection, type InjectionResult } from "./injection.js";
import { normalizeText } from "./normalize.js";
import { describePii, redactPii } from "./pii.js";

export const MAX_QUESTION_LENGTH = 1000;

export interface InputGuardResult {
  allowed: boolean;
  // Normalized and redacted question; the only form used for retrieval, prompts, and logs.
  text: string;
  refusal: string;
  injection: InjectionResult;
  report: LayerReport;
}

function result(allowed: boolean, text: string, refusal: string, injection: InjectionResult, checks: Check[]): InputGuardResult {
  return { allowed, text, refusal, injection, report: { layer: "input", verdict: worstVerdict(checks.map(check => check.verdict)), checks } };
}

export function guardInput(raw: string, options: { internalEmailDomains: string[] }): InputGuardResult {
  const checks: Check[] = [];
  const none: InjectionResult = { score: 0, findings: [] };
  if (!raw.trim() || raw.length > MAX_QUESTION_LENGTH) {
    checks.push({ name: "Length", verdict: "block", detail: `Questions must be 1–${MAX_QUESTION_LENGTH} characters.` });
    return result(false, "", "Please ask a question between 1 and 1,000 characters.", none, checks);
  }
  checks.push({ name: "Length", verdict: "pass", detail: `${raw.length} characters` });

  const normalized = normalizeText(raw);
  const removed = normalized.removedInvisible + normalized.removedControl;
  checks.push({
    name: "Unicode normalization",
    verdict: removed ? "warn" : "pass",
    detail: removed ? `Removed ${removed} invisible or control character(s)` : "NFKC applied; no hidden characters"
  });

  const injection = detectInjection(normalized.text, { removedInvisible: normalized.removedInvisible, hiddenText: normalized.hiddenText });
  const verdict: Verdict = injection.score >= BLOCK_THRESHOLD ? "block" : injection.score >= WARN_THRESHOLD ? "warn" : "pass";
  checks.push({
    name: "Prompt-injection scan",
    verdict,
    detail: injection.findings.length ? `Score ${injection.score.toFixed(1)}: ${describeFindings(injection)}` : "Score 0.0: no known attack patterns"
  });

  const pii = redactPii(normalized.text, options.internalEmailDomains);
  checks.push({
    name: "Personal data",
    verdict: pii.total ? "warn" : "pass",
    detail: pii.total ? `Redacted before retrieval and generation: ${describePii(pii.counts)}` : "None detected"
  });

  if (verdict === "block") {
    return result(false, pii.text, `I can't help with that request because it looks like an attempt to manipulate the assistant (${describeFindings(injection)}). Please ask a question about Northwind Labs policies.`, injection, checks);
  }
  return result(true, pii.text, "", injection, checks);
}
