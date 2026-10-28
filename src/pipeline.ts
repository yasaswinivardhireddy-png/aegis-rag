import { randomBytes } from "node:crypto";
import { guardInput } from "./guards/input.js";
import { NOT_FOUND_MESSAGE, guardOutput } from "./guards/output.js";
import { describeModelError, type ChatModel } from "./llm/chat.js";
import { SYSTEM_FINGERPRINTS, baselineMessages, guardedMessages, type PromptSource } from "./llm/prompt.js";
import type { RetrievedChunk, Retriever } from "./rag/retriever.js";
import { worstVerdict, type AskResult, type Check, type DemoUser, type LayerName, type LayerReport, type SourceView } from "./shared.js";
import type { Store } from "./store.js";

export interface PipelineSettings {
  allowedLinkHosts: string[];
  internalEmailDomains: string[];
}

export interface AskOptions {
  mode?: "guarded" | "baseline";
  signal?: AbortSignal;
  // Receives the exact text sent to the model; the evaluation uses it to measure data exposure.
  onModelRequest?: (text: string) => void;
}

type Draft = Omit<AskResult, "latencyMs">;

function layer(name: LayerName, checks: Check[]): LayerReport {
  return { layer: name, verdict: worstVerdict(checks.map(check => check.verdict)), checks };
}

function sourceView(alias: string, hit: RetrievedChunk, guarded: boolean): SourceView {
  return {
    alias,
    docTitle: hit.chunk.docTitle,
    section: hit.chunk.section,
    text: guarded ? hit.chunk.text : hit.chunk.rawText,
    similarity: hit.similarity === null ? null : Number(hit.similarity.toFixed(3)),
    keywordScore: Number(hit.keywordScore.toFixed(2))
  };
}

function promptSources(sources: SourceView[]): PromptSource[] {
  return sources.map(source => ({ alias: source.alias, title: source.docTitle, section: source.section, text: source.text }));
}

export class AegisPipeline {
  constructor(
    private readonly retriever: Retriever,
    private readonly chat: ChatModel,
    private readonly settings: PipelineSettings,
    private readonly store?: Store
  ) {}

  get modelName(): string {
    return this.chat.name;
  }

  async ask(user: DemoUser, question: string, options: AskOptions = {}): Promise<AskResult> {
    const started = performance.now();
    const guarded = options.mode !== "baseline";
    const { draft, auditText } = guarded
      ? await this.guarded(user, question, options)
      : { draft: await this.baseline(user, question, options), auditText: "" };
    const latencyMs = Math.round(performance.now() - started);
    if (guarded && this.store) {
      try {
        this.store.recordAudit({ userId: user.id, role: user.role, question: auditText, outcome: draft.outcome, layers: draft.layers, latencyMs });
      } catch (error) {
        // Availability over audit completeness: the failure is reported to operators without the question text.
        console.warn("Audit record could not be written:", error instanceof Error ? error.message : "unknown error");
      }
    }
    return { ...draft, latencyMs };
  }

  private async guarded(user: DemoUser, question: string, options: AskOptions): Promise<{ draft: Draft; auditText: string }> {
    const layers: LayerReport[] = [];

    // Layer 1: input guard. Blocked requests never reach retrieval or the model.
    const input = guardInput(question, this.settings);
    layers.push(input.report);
    if (!input.allowed) {
      return { draft: { outcome: "blocked", answer: input.refusal, citations: [], sources: [], layers }, auditText: input.text || "(invalid input)" };
    }

    // Layer 2: retrieval guard. Role filtering happens before ranking.
    const retrieval = await this.retriever.retrieve(input.text, user.role, { guarded: true });
    const sources = retrieval.results.map((hit, index) => sourceView(`S${index + 1}`, hit, true));
    layers.push(layer("retrieval", [
      { name: "Access control", verdict: "pass", detail: `Searched only the ${retrieval.searched} section(s) your role can access` },
      { name: "Quarantine", verdict: "pass", detail: retrieval.quarantinedExcluded ? `${retrieval.quarantinedExcluded} quarantined section(s) excluded` : "No quarantined sections in scope" },
      retrieval.fallbackReason
        ? { name: "Search mode", verdict: "warn", detail: retrieval.fallbackReason }
        : { name: "Search mode", verdict: "pass", detail: "Hybrid: BM25 keywords + embeddings, reciprocal rank fusion" },
      sources.length
        ? { name: "Relevance threshold", verdict: "pass", detail: `${sources.length} section(s) passed the relevance threshold (${this.retriever.minRelevance})` }
        : { name: "Relevance threshold", verdict: "warn", detail: "No section was relevant enough; answering would mean guessing" }
    ]));
    if (!sources.length) {
      return { draft: { outcome: "abstained", answer: NOT_FOUND_MESSAGE, citations: [], sources, layers }, auditText: input.text };
    }

    // Layer 3: generation guard. Sources are fenced as data and a canary detects prompt leaks.
    const canary = `AEGIS-CANARY-${randomBytes(6).toString("hex")}`;
    const messages = guardedMessages(input.text, promptSources(sources), canary, randomBytes(4).toString("hex"));
    options.onModelRequest?.(messages.map(message => message.content).join("\n"));
    const generationChecks: Check[] = [
      { name: "Context isolation", verdict: "pass", detail: `${sources.length} source(s) fenced with per-request boundary markers` },
      { name: "Canary token", verdict: "pass", detail: "Unique canary planted to detect instruction leaks" }
    ];
    const modelStarted = performance.now();
    let content: string;
    try {
      content = await this.chat.complete(messages, { json: true, signal: options.signal });
    } catch (error) {
      options.signal?.throwIfAborted();
      generationChecks.push({ name: "Model call", verdict: "block", detail: describeModelError(error) });
      layers.push(layer("generation", generationChecks));
      return { draft: { outcome: "error", answer: describeModelError(error), citations: [], sources, layers }, auditText: input.text };
    }
    generationChecks.push({ name: "Model call", verdict: "pass", detail: `${this.chat.name} responded in ${Math.round(performance.now() - modelStarted)} ms` });
    layers.push(layer("generation", generationChecks));

    // Layer 4: output guard. Nothing is shown until the answer is validated.
    const output = guardOutput(content, {
      sources: sources.map(source => ({ alias: source.alias, text: source.text })),
      canary,
      fingerprints: SYSTEM_FINGERPRINTS,
      allowedLinkHosts: this.settings.allowedLinkHosts,
      internalEmailDomains: this.settings.internalEmailDomains
    });
    layers.push(output.report);
    return {
      draft: { outcome: output.outcome, answer: output.answer, citations: sources.filter(source => output.citedAliases.includes(source.alias)), sources, layers },
      auditText: input.text
    };
  }

  private async baseline(user: DemoUser, question: string, options: AskOptions): Promise<Draft> {
    const retrieval = await this.retriever.retrieve(question, user.role, { guarded: false });
    const sources = retrieval.results.map((hit, index) => sourceView(`S${index + 1}`, hit, false));
    const messages = baselineMessages(question, promptSources(sources), `AEGIS-CANARY-${randomBytes(6).toString("hex")}`);
    options.onModelRequest?.(messages.map(message => message.content).join("\n"));
    let draft: Draft;
    try {
      draft = { outcome: "answered", answer: await this.chat.complete(messages, { json: false, signal: options.signal }), citations: [], sources, layers: [] };
    } catch (error) {
      options.signal?.throwIfAborted();
      draft = { outcome: "error", answer: describeModelError(error), citations: [], sources, layers: [] };
    }
    return draft;
  }
}
