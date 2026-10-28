// Zero-width, bidirectional-override, variation-selector, and Unicode tag characters hide text from human reviewers.
const INVISIBLE = /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\u{E0000}-\u{E007F}]/gu;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const TAG_CHARACTERS = /[\u{E0020}-\u{E007E}]/gu;

export interface NormalizedText {
  text: string;
  removedInvisible: number;
  removedControl: number;
  // Text smuggled with Unicode tag characters, decoded so it can be scanned.
  hiddenText: string;
}

export function normalizeText(input: string): NormalizedText {
  const hiddenText = [...input.matchAll(TAG_CHARACTERS)].map(match => String.fromCodePoint(match[0].codePointAt(0)! - 0xE0000)).join("");
  let removedInvisible = 0;
  let removedControl = 0;
  const text = input.normalize("NFKC")
    .replace(INVISIBLE, () => { removedInvisible++; return ""; })
    .replace(CONTROL, () => { removedControl++; return ""; })
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, removedInvisible, removedControl, hiddenText };
}

const CONFUSABLES: Record<string, string> = {
  "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "у": "y", "х": "x", "і": "i", "ј": "j", "ѕ": "s", "һ": "h", "ԁ": "d", "ӏ": "l", "ɡ": "g",
  "А": "a", "В": "b", "Е": "e", "К": "k", "М": "m", "Н": "h", "О": "o", "Р": "p", "С": "c", "Т": "t", "Х": "x", "І": "i", "Ј": "j", "Ѕ": "s",
  "α": "a", "ε": "e", "ι": "i", "κ": "k", "ν": "v", "ο": "o", "ρ": "p", "τ": "t", "υ": "u", "χ": "x",
  "Α": "a", "Β": "b", "Ε": "e", "Ζ": "z", "Η": "h", "Ι": "i", "Κ": "k", "Μ": "m", "Ν": "n", "Ο": "o", "Ρ": "p", "Τ": "t", "Υ": "y", "Χ": "x"
};
const LEET: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s" };

// Folds look-alike letters, leetspeak, and spaced-out letters so detection rules see the intended words.
export function foldForDetection(text: string): string {
  const folded = [...text].map(char => CONFUSABLES[char] ?? char).join("").toLowerCase();
  const unLeet = folded.replace(/[\p{L}\p{N}@$]+/gu, word => /\p{L}/u.test(word) && /[0-9@$]/.test(word)
    ? [...word].map(char => LEET[char] ?? char).join("")
    : word);
  return unLeet.replace(/\b(?:\p{L} ){2,}\p{L}\b/gu, run => run.replace(/ /g, ""));
}

export function squash(text: string): string {
  return text.replace(/[^\p{L}]/gu, "");
}
