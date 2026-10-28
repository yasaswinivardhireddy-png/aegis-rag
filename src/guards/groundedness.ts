import { contentTerms, extractNumbers } from "../text.js";

export const MIN_COVERAGE = 0.6;

export interface SentenceCheck {
  sentence: string;
  supported: boolean;
  coverage: number;
  unsupportedNumbers: string[];
}

export function splitSentences(text: string): string[] {
  return text.split(/\n+/)
    .flatMap(line => line.split(/(?<=[.!?])\s+(?=[\p{Lu}\p{N}₹"'(])/u))
    .map(sentence => sentence.trim())
    .filter(Boolean);
}

// A sentence is supported when its numbers appear in the sources and most of its content words do too.
export function checkGrounding(answer: string, sources: string[]): SentenceCheck[] {
  const sourceTerms = new Set(sources.flatMap(contentTerms));
  const sourceNumbers = new Set(sources.flatMap(extractNumbers).flatMap(number => number.includes(":") ? [number, number.split(":")[0]!] : [number]));
  return splitSentences(answer).map(sentence => {
    const terms = contentTerms(sentence).filter(term => !/^\d/.test(term));
    const unsupportedNumbers = extractNumbers(sentence).filter(number => !sourceNumbers.has(number));
    const coverage = terms.length ? terms.filter(term => sourceTerms.has(term)).length / terms.length : 1;
    return {
      sentence,
      supported: unsupportedNumbers.length === 0 && (terms.length < 3 || coverage >= MIN_COVERAGE),
      coverage: Number(coverage.toFixed(2)),
      unsupportedNumbers
    };
  });
}
