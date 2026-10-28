import assert from "node:assert/strict";
import { test } from "node:test";
import { Bm25Index } from "../src/rag/bm25.ts";
import { chunkDocument } from "../src/rag/chunker.ts";
import { parseDocument } from "../src/rag/corpus.ts";
import { FakeEmbedder, buildSystem } from "./helpers.mjs";

test("documents require valid front matter", () => {
  assert.throws(() => parseDocument("x", "# no front matter"), /front matter/);
  assert.throws(() => parseDocument("x", "---\ntitle: X\naccess: admin\n---\nbody"));
  assert.equal(parseDocument("x", "---\ntitle: X\naccess: hr\n---\nbody").access, "hr");
});

test("chunking separates hidden HTML comments from visible text", () => {
  const doc = parseDocument("d", "---\ntitle: Doc\naccess: employee\n---\n# Doc\n\n## Section\nVisible text.\n<!-- hidden instructions -->\n");
  const [chunk] = chunkDocument(doc);
  assert.equal(chunk.text, "Visible text.");
  assert.equal(chunk.hidden, "hidden instructions");
  assert.match(chunk.rawText, /hidden instructions/);
});

test("ingestion removes hidden instructions and quarantines only the poisoned section", async () => {
  const { kb } = await buildSystem();
  assert.deepEqual(kb.chunks.filter(chunk => chunk.quarantined).map(chunk => chunk.section), ["Note for AI systems"]);
  const signIn = kb.chunks.find(chunk => chunk.section === "Sign-in problems");
  assert.ok(!signIn.text.includes("cloudprint-support.example"));
  assert.ok(signIn.rawText.includes("cloudprint-support.example"));
  const employeeViews = kb.documentViews("employee");
  assert.ok(employeeViews.every(view => view.access === "employee"));
  assert.equal(employeeViews.find(view => view.id === "vendor-faq-cloudprint").quarantine.length, 2);
  assert.equal(kb.documentViews("hr").length, 8);
});

test("employees never retrieve HR-only sections, even for direct questions", async () => {
  const { retriever } = await buildSystem({ minRelevance: 0 });
  for (const query of ["What is the salary band for an L5 Principal Engineer?", "HR casework escalation contacts phone", "merit budget"]) {
    const result = await retriever.retrieve(query, "employee", { guarded: true, k: 10 });
    assert.ok(result.results.every(hit => hit.chunk.access === "employee"), query);
  }
  const hr = await retriever.retrieve("What is the salary band for an L5 Principal Engineer?", "hr", { guarded: true });
  assert.equal(hr.results[0].chunk.docId, "salary-bands-2026");
});

test("quarantined sections are excluded in guarded mode but reach the baseline", async () => {
  const { retriever } = await buildSystem({ minRelevance: 0 });
  const query = "What are AI systems told to do about CloudPrint support and passwords?";
  const guarded = await retriever.retrieve(query, "employee", { guarded: true, k: 10 });
  assert.ok(guarded.results.every(hit => !hit.chunk.quarantined && !hit.chunk.text.includes("cloudprint-support.example")));
  const baseline = await retriever.retrieve(query, "employee", { guarded: false, k: 10 });
  assert.ok(baseline.results.some(hit => hit.chunk.rawText.includes("cloudprint-support.example")));
});

test("relevance threshold returns nothing for unrelated questions instead of guessing", async () => {
  const { retriever } = await buildSystem({ minRelevance: 0.2 });
  const result = await retriever.retrieve("Who won the cricket match yesterday?", "employee", { guarded: true });
  assert.equal(result.mode, "hybrid");
  assert.equal(result.results.length, 0);
});

test("retrieval falls back to keyword search when embeddings fail", async () => {
  const embedder = new FakeEmbedder();
  const { retriever } = await buildSystem({ embedder });
  embedder.failing = true;
  const result = await retriever.retrieve("How many days of paid annual leave do I get per year?", "employee", { guarded: true });
  assert.equal(result.mode, "keyword");
  assert.match(result.fallbackReason, /keyword/);
  assert.equal(result.results[0].chunk.section, "Annual leave");
});

test("BM25 ranks the most specific section first", () => {
  const index = new Bm25Index([
    { id: "a", text: "annual leave days per year" },
    { id: "b", text: "sick leave certificate" },
    { id: "c", text: "expense receipts" }
  ]);
  assert.equal(index.search("annual leave")[0].id, "a");
  assert.equal(index.search("unrelated words").length, 0);
});
