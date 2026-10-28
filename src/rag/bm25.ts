import { contentTerms } from "../text.js";

export interface KeywordHit {
  id: string;
  score: number;
}

// Okapi BM25 over stemmed content words.
export class Bm25Index {
  private readonly entries: { id: string; frequencies: Map<string, number>; length: number }[];
  private readonly documentFrequency = new Map<string, number>();
  private readonly averageLength: number;

  constructor(documents: { id: string; text: string }[], private readonly k1 = 1.2, private readonly b = 0.75) {
    this.entries = documents.map(({ id, text }) => {
      const terms = contentTerms(text);
      const frequencies = new Map<string, number>();
      for (const term of terms) {
        frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
      }
      for (const term of frequencies.keys()) {
        this.documentFrequency.set(term, (this.documentFrequency.get(term) ?? 0) + 1);
      }
      return { id, frequencies, length: terms.length };
    });
    this.averageLength = this.entries.reduce((sum, entry) => sum + entry.length, 0) / Math.max(1, this.entries.length);
  }

  search(query: string): KeywordHit[] {
    const terms = [...new Set(contentTerms(query))];
    const total = this.entries.length;
    const hits: KeywordHit[] = [];
    for (const entry of this.entries) {
      let score = 0;
      for (const term of terms) {
        const frequency = entry.frequencies.get(term);
        if (frequency) {
          const documents = this.documentFrequency.get(term) ?? 0;
          const idf = Math.log(1 + (total - documents + 0.5) / (documents + 0.5));
          score += idf * (frequency * (this.k1 + 1)) / (frequency + this.k1 * (1 - this.b + this.b * entry.length / this.averageLength));
        }
      }
      if (score > 0) {
        hits.push({ id: entry.id, score });
      }
    }
    return hits.sort((a, b) => b.score - a.score);
  }
}
