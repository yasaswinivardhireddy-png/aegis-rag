import type { Role } from "../shared.js";
import { Bm25Index } from "./bm25.js";
import { canAccess } from "./corpus.js";
import { cosine, type Embedder } from "./embeddings.js";
import type { IndexedChunk, KnowledgeBase } from "./knowledge-base.js";

export interface RetrievedChunk {
  chunk: IndexedChunk;
  similarity: number | null;
  keywordScore: number;
}

export interface RetrievalOutcome {
  mode: "hybrid" | "keyword";
  searched: number;
  quarantinedExcluded: number;
  belowThreshold: number;
  results: RetrievedChunk[];
  fallbackReason?: string;
}

const RRF_K = 60;
export const MIN_KEYWORD_SCORE = 2.5;

export class Retriever {
  private readonly keywordIndexes = new Map<string, Bm25Index>();

  constructor(private readonly kb: KnowledgeBase, private readonly embedder: Embedder | undefined, readonly minRelevance: number) {}

  // Guarded retrieval filters by role and quarantine before ranking, so restricted text never
  // reaches the model. The baseline mimics a typical demo: every chunk, raw text, no threshold.
  async retrieve(query: string, role: Role, options: { guarded: boolean; k?: number }): Promise<RetrievalOutcome> {
    const k = options.k ?? 4;
    const { guarded } = options;
    const accessible = guarded ? this.kb.chunks.filter(chunk => canAccess(role, chunk.access)) : this.kb.chunks;
    const candidates = guarded ? accessible.filter(chunk => !chunk.quarantined && chunk.text) : accessible;
    const textOf = (chunk: IndexedChunk) => guarded ? chunk.text : chunk.rawText;
    const keywordScores = new Map(this.keywordIndex(guarded ? role : "baseline", candidates, textOf).search(query).map(hit => [hit.id, hit.score]));

    let similarities: Map<string, number> | undefined;
    let fallbackReason: string | undefined;
    if (this.embedder && this.kb.hasVectors) {
      try {
        const [queryVector] = await this.embedder.embed([query]);
        similarities = new Map(candidates.map(chunk => [chunk.id, cosine(queryVector!, (guarded ? chunk.vector : chunk.rawVector)!)]));
      } catch {
        fallbackReason = "Embedding service unavailable; used keyword search only";
      }
    } else {
      fallbackReason = "Embeddings unavailable; used keyword search only";
    }

    const rank = (scores: Map<string, number>) => new Map([...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id], index) => [id, index + 1]));
    const keywordRanks = rank(keywordScores);
    const vectorRanks = similarities ? rank(similarities) : new Map<string, number>();
    const fused = candidates.map(chunk => {
      const keywordRank = keywordRanks.get(chunk.id);
      const vectorRank = vectorRanks.get(chunk.id);
      return {
        chunk,
        score: (keywordRank ? 1 / (RRF_K + keywordRank) : 0) + (vectorRank ? 1 / (RRF_K + vectorRank) : 0),
        similarity: similarities?.get(chunk.id) ?? null,
        keywordScore: keywordScores.get(chunk.id) ?? 0
      };
    }).filter(entry => entry.score > 0).sort((a, b) => b.score - a.score);

    const relevant = (entry: (typeof fused)[number]) => !guarded
      || (similarities ? (entry.similarity ?? 0) >= this.minRelevance : entry.keywordScore >= MIN_KEYWORD_SCORE);
    const results = fused.filter(relevant).slice(0, k).map(({ chunk, similarity, keywordScore }) => ({ chunk, similarity, keywordScore }));
    return {
      mode: similarities ? "hybrid" : "keyword",
      searched: candidates.length,
      quarantinedExcluded: guarded ? accessible.filter(chunk => chunk.quarantined).length : 0,
      belowThreshold: fused.slice(0, k).filter(entry => !relevant(entry)).length,
      results,
      ...(fallbackReason ? { fallbackReason } : {})
    };
  }

  private keywordIndex(key: string, chunks: IndexedChunk[], textOf: (chunk: IndexedChunk) => string): Bm25Index {
    let index = this.keywordIndexes.get(key);
    if (!index) {
      index = new Bm25Index(chunks.map(chunk => ({ id: chunk.id, text: `${chunk.docTitle} ${chunk.section} ${textOf(chunk)}` })));
      this.keywordIndexes.set(key, index);
    }
    return index;
  }
}
