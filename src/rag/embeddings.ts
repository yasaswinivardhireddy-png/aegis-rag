import { createHash } from "node:crypto";
import type OpenAI from "openai";
import type { Store } from "../store.js";

export interface Embedder {
  readonly model: string;
  embed(texts: string[]): Promise<Float32Array[]>;
}

export function toUnitVector(values: ArrayLike<number>): Float32Array {
  const vector = Float32Array.from(values);
  let norm = 0;
  for (const value of vector) {
    norm += value * value;
  }
  norm = Math.sqrt(norm) || 1;
  for (let index = 0; index < vector.length; index++) {
    vector[index] = vector[index]! / norm;
  }
  return vector;
}

// Vectors are unit length, so the dot product is the cosine similarity.
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) {
    dot += a[index]! * b[index]!;
  }
  return dot;
}

export class OpenAICompatibleEmbedder implements Embedder {
  constructor(private readonly client: OpenAI, readonly model: string) {}

  async embed(texts: string[]): Promise<Float32Array[]> {
    const vectors: Float32Array[] = [];
    for (let start = 0; start < texts.length; start += 50) {
      const batch = texts.slice(start, start + 50);
      const response = await this.client.embeddings.create({ model: this.model, input: batch, encoding_format: "float" });
      const ordered = [...response.data].sort((a, b) => a.index - b.index);
      if (ordered.length !== batch.length) {
        throw new Error("Embedding response size did not match the request.");
      }
      vectors.push(...ordered.map(item => toUnitVector(item.embedding)));
    }
    return vectors;
  }
}

export class CachedEmbedder implements Embedder {
  constructor(private readonly inner: Embedder, private readonly store: Store) {}

  get model(): string {
    return this.inner.model;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const keys = texts.map(text => createHash("sha256").update(`${this.inner.model}\n${text}`).digest("hex"));
    const vectors = this.store.getEmbeddings(keys);
    const missing = [...new Set(keys.filter(key => !vectors.has(key)))];
    if (missing.length) {
      const fresh = await this.inner.embed(missing.map(key => texts[keys.indexOf(key)]!));
      missing.forEach((key, index) => {
        vectors.set(key, fresh[index]!);
        try {
          this.store.putEmbedding(key, this.inner.model, fresh[index]!);
        } catch {
          // The cache only saves time; a failed write (for example, a full disk) must not fail retrieval.
        }
      });
    }
    return keys.map(key => vectors.get(key)!);
  }
}
