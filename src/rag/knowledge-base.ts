import { BLOCK_THRESHOLD, describeFindings, detectInjection } from "../guards/injection.js";
import { normalizeText } from "../guards/normalize.js";
import type { DocumentView, QuarantineView, Role } from "../shared.js";
import { chunkDocument, type Chunk } from "./chunker.js";
import { canAccess, type SourceDocument } from "./corpus.js";
import type { Embedder } from "./embeddings.js";

export interface IndexedChunk extends Chunk {
  quarantined: boolean;
  vector?: Float32Array;
  rawVector?: Float32Array;
}

interface QuarantineRecord extends QuarantineView {
  docId: string;
}

function embeddingText(chunk: Chunk, text: string): string {
  return `${chunk.docTitle} > ${chunk.section}\n${text}`;
}

// Ingestion is the first defense against indirect prompt injection: hidden content is removed
// and sections that address AI systems are quarantined before anything is searchable.
export class KnowledgeBase {
  private constructor(
    readonly documents: SourceDocument[],
    readonly chunks: IndexedChunk[],
    private readonly quarantine: QuarantineRecord[],
    readonly embeddingStatus: string
  ) {}

  static async build(documents: SourceDocument[], embedder?: Embedder): Promise<KnowledgeBase> {
    const chunks: IndexedChunk[] = [];
    const quarantine: QuarantineRecord[] = [];
    for (const doc of documents) {
      for (const chunk of chunkDocument(doc)) {
        const normalized = normalizeText(chunk.text);
        const indexed: IndexedChunk = { ...chunk, text: normalized.text, quarantined: false };
        if (chunk.hidden) {
          const hiddenScan = detectInjection(chunk.hidden);
          quarantine.push({
            docId: doc.id, chunkId: chunk.id, section: chunk.section, action: "hidden_content_removed",
            reason: hiddenScan.score >= BLOCK_THRESHOLD
              ? `Hidden comment contained instructions (${describeFindings(hiddenScan)}); removed before indexing`
              : "Hidden comment removed before indexing"
          });
        }
        const scan = detectInjection(normalized.text, { removedInvisible: normalized.removedInvisible, hiddenText: normalized.hiddenText });
        if (scan.score >= BLOCK_THRESHOLD) {
          indexed.quarantined = true;
          quarantine.push({
            docId: doc.id, chunkId: chunk.id, section: chunk.section, action: "quarantined",
            reason: `Text addressed to AI systems (${describeFindings(scan)}); excluded from search`
          });
        }
        chunks.push(indexed);
      }
    }

    let embeddingStatus = "not configured";
    if (embedder) {
      try {
        const vectors = await embedder.embed(chunks.map(chunk => embeddingText(chunk, chunk.text)));
        const rawVectors = await embedder.embed(chunks.map(chunk => embeddingText(chunk, chunk.rawText)));
        chunks.forEach((chunk, index) => {
          chunk.vector = vectors[index];
          chunk.rawVector = rawVectors[index];
        });
        embeddingStatus = embedder.model;
      } catch (error) {
        embeddingStatus = `unavailable: ${error instanceof Error ? error.message.slice(0, 120) : "unknown error"}`;
      }
    }
    return new KnowledgeBase(documents, chunks, quarantine, embeddingStatus);
  }

  get hasVectors(): boolean {
    return this.chunks.length > 0 && this.chunks.every(chunk => chunk.vector && chunk.rawVector);
  }

  get quarantinedCount(): number {
    return this.chunks.filter(chunk => chunk.quarantined).length;
  }

  documentViews(role: Role): DocumentView[] {
    return this.documents.filter(doc => canAccess(role, doc.access)).map(doc => ({
      id: doc.id,
      title: doc.title,
      access: doc.access,
      sections: this.chunks.filter(chunk => chunk.docId === doc.id).length,
      quarantine: this.quarantine.filter(entry => entry.docId === doc.id)
        .map(({ chunkId, section, action, reason }) => ({ chunkId, section, action, reason }))
    }));
  }
}
