export type PiiKind = "email" | "card" | "ssn" | "aadhaar" | "pan" | "phone";

export interface PiiMatch {
  kind: PiiKind;
  value: string;
}

function luhn(value: string): boolean {
  const digits = value.replace(/\D/g, "");
  let sum = 0;
  for (let index = 0; index < digits.length; index++) {
    let digit = Number(digits[digits.length - 1 - index]);
    if (index % 2 === 1) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }
    sum += digit;
  }
  return digits.length >= 13 && sum % 10 === 0;
}

const DETECTORS: { kind: PiiKind; pattern: RegExp; valid?: (match: string) => boolean }[] = [
  { kind: "email", pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
  { kind: "card", pattern: /\b\d(?:[ -]?\d){12,18}\b/g, valid: luhn },
  { kind: "ssn", pattern: /\b\d{3}-\d{2}-\d{4}\b/g },
  { kind: "aadhaar", pattern: /(?<!\d[ -]?)\b[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}\b(?![ -]?\d)/g },
  { kind: "pan", pattern: /\b[A-Z]{5}\d{4}[A-Z]\b/g },
  {
    kind: "phone",
    pattern: /(?<![\w₹])(?<!\d[ -])(?:\+\d{1,3}[ -]?)?(?:\(?\d{2,5}\)?[ -]?)?\d{3,5}[ -]?\d{4,5}\b(?![ -]?\d)/g,
    valid: match => match.replace(/\D/g, "").length >= 10 && match.replace(/\D/g, "").length <= 13
  }
];

function isInternalEmail(value: string, internalDomains: string[]): boolean {
  const domain = value.split("@")[1]?.toLowerCase() ?? "";
  return internalDomains.some(allowed => domain === allowed || domain.endsWith(`.${allowed}`));
}

// Role mailboxes on the company domain are not treated as personal data.
export function findPii(text: string, internalDomains: string[]): PiiMatch[] {
  const matches: PiiMatch[] = [];
  let remaining = text;
  for (const detector of DETECTORS) {
    remaining = remaining.replace(detector.pattern, match => {
      const relevant = (!detector.valid || detector.valid(match)) && !(detector.kind === "email" && isInternalEmail(match, internalDomains));
      if (relevant) {
        matches.push({ kind: detector.kind, value: match });
      }
      return relevant ? " ".repeat(match.length) : match;
    });
  }
  return matches;
}

export function redactPii(text: string, internalDomains: string[]): { text: string; counts: Partial<Record<PiiKind, number>>; total: number } {
  const counts: Partial<Record<PiiKind, number>> = {};
  let redacted = text;
  for (const detector of DETECTORS) {
    redacted = redacted.replace(detector.pattern, match => {
      if ((detector.valid && !detector.valid(match)) || (detector.kind === "email" && isInternalEmail(match, internalDomains))) {
        return match;
      }
      counts[detector.kind] = (counts[detector.kind] ?? 0) + 1;
      return `[REDACTED_${detector.kind.toUpperCase()}]`;
    });
  }
  return { text: redacted, counts, total: Object.values(counts).reduce((sum, count) => sum + count, 0) };
}

export function describePii(counts: Partial<Record<PiiKind, number>>): string {
  return Object.entries(counts).map(([kind, count]) => `${count} ${kind}`).join(", ");
}
