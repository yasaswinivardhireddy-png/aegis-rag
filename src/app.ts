import { mkdir } from "node:fs/promises";
import path from "node:path";
import { CORPUS_DIR, type Config } from "./config.js";
import { OpenAICompatibleChat, createClient } from "./llm/chat.js";
import { AegisPipeline } from "./pipeline.js";
import { loadCorpus } from "./rag/corpus.js";
import { CachedEmbedder, OpenAICompatibleEmbedder, type Embedder } from "./rag/embeddings.js";
import { KnowledgeBase } from "./rag/knowledge-base.js";
import { Retriever } from "./rag/retriever.js";
import { Store } from "./store.js";

export interface AppContext {
  config: Config;
  store: Store;
  kb: KnowledgeBase;
  embedder?: Embedder;
  retriever: Retriever;
  pipeline?: AegisPipeline;
}

export async function createApp(config: Config, options: { maxRetries?: number } = {}): Promise<AppContext> {
  const dataDir = path.join(config.home, ".aegis");
  await mkdir(dataDir, { recursive: true });
  const store = new Store(path.join(dataDir, "aegis.db"));
  try {
    const client = config.apiKey ? createClient(config, options.maxRetries) : undefined;
    const embedder = client ? new CachedEmbedder(new OpenAICompatibleEmbedder(client, config.embeddingModel), store) : undefined;
    const kb = await KnowledgeBase.build(await loadCorpus(CORPUS_DIR), embedder);
    const retriever = new Retriever(kb, embedder, config.minRelevance);
    const pipeline = client ? new AegisPipeline(retriever, new OpenAICompatibleChat(client, config.model, config.reasoningEffort), config, store) : undefined;
    return { config, store, kb, retriever, ...(embedder ? { embedder } : {}), ...(pipeline ? { pipeline } : {}) };
  } catch (error) {
    store.close();
    throw error;
  }
}
