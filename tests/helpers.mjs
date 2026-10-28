import { CORPUS_DIR } from "../src/config.ts";
import { AegisPipeline } from "../src/pipeline.ts";
import { loadCorpus } from "../src/rag/corpus.ts";
import { toUnitVector } from "../src/rag/embeddings.ts";
import { KnowledgeBase } from "../src/rag/knowledge-base.ts";
import { Retriever } from "../src/rag/retriever.ts";
import { contentTerms } from "../src/text.ts";

export const SETTINGS = { allowedLinkHosts: ["northwind.example"], internalEmailDomains: ["northwind.example"] };
export const EMPLOYEE = { id: "priya", name: "Priya Sharma", title: "Software Engineer", role: "employee" };
export const HR = { id: "arjun", name: "Arjun Rao", title: "HR Manager", role: "hr" };

// Deterministic bag-of-words embedding: cosine similarity reflects shared content words.
export function fakeVector(text, dimensions = 512) {
  const values = new Array(dimensions).fill(0);
  for (const term of contentTerms(text)) {
    let hash = 0;
    for (const char of term) {
      hash = (hash * 31 + char.codePointAt(0)) >>> 0;
    }
    values[hash % dimensions] += 1;
  }
  return toUnitVector(values);
}

export class FakeEmbedder {
  model = "fake-embedding";
  failing = false;

  async embed(texts) {
    if (this.failing) {
      throw new Error("embedding outage");
    }
    return texts.map(text => fakeVector(text));
  }
}

export class ScriptedChat {
  name = "scripted-model";
  requests = [];

  constructor(respond) {
    this.respond = respond;
  }

  async complete(messages, options) {
    this.requests.push({ messages, options });
    return this.respond(messages, this.requests.length);
  }
}

// Answers with the first sentence of source S1, as a well-behaved grounded model would.
export function groundedResponder(messages) {
  const match = /\[\[SOURCE S1 [0-9a-f]+\]\][^\n]*\n([\s\S]*?)\n\[\[END S1/.exec(messages.at(-1).content);
  const sentence = match ? match[1].split(/(?<=\.)\s/)[0] : "";
  return JSON.stringify({ answer: sentence, citations: sentence ? ["S1"] : [], insufficient_context: !sentence });
}

export function requestText(chat) {
  return chat.requests.map(request => request.messages.map(message => message.content).join("\n")).join("\n");
}

export async function buildSystem({ respond = groundedResponder, minRelevance = 0.2, embedder = new FakeEmbedder() } = {}) {
  const kb = await KnowledgeBase.build(await loadCorpus(CORPUS_DIR), embedder);
  const retriever = new Retriever(kb, embedder, minRelevance);
  const chat = new ScriptedChat(respond);
  return { kb, retriever, chat, embedder, pipeline: new AegisPipeline(retriever, chat, SETTINGS) };
}
