import { readFile } from "node:fs/promises";
import path from "node:path";
import { createApp } from "../app.js";
import { PROJECT_ROOT, loadConfig, loadDotEnv } from "../config.js";
import { guardInput } from "../guards/input.js";
import { Retriever } from "../rag/retriever.js";
import type { Role } from "../shared.js";

interface BenignCase {
  id: string;
  role: Role;
  question: string;
  expect: "answer" | "abstain";
}

loadDotEnv();
const config = loadConfig();
const app = await createApp(config);
try {
  console.log(`Documents: ${app.kb.documents.length} | sections: ${app.kb.chunks.length} | embeddings: ${app.kb.embeddingStatus}`);
  for (const doc of app.kb.documentViews("hr")) {
    console.log(`\n${doc.title} [${doc.access}] - ${doc.sections} section(s)`);
    for (const entry of doc.quarantine) {
      console.log(`  ${entry.action === "quarantined" ? "QUARANTINED" : "HIDDEN REMOVED"} ${entry.section}: ${entry.reason}`);
    }
  }

  // Prints the best similarity per question so the relevance threshold can be chosen from data.
  if (process.argv.includes("--calibrate")) {
    if (!app.embedder || !app.kb.hasVectors) {
      throw new Error("Calibration needs working embeddings. Set LLM_API_KEY.");
    }
    const retriever = new Retriever(app.kb, app.embedder, 0);
    const cases = JSON.parse(await readFile(path.join(PROJECT_ROOT, "eval", "benign.json"), "utf8")) as BenignCase[];
    const scores: Record<BenignCase["expect"], number[]> = { answer: [], abstain: [] };
    console.log("\nBest similarity per benign question:");
    for (const item of cases) {
      const outcome = await retriever.retrieve(guardInput(item.question, config).text, item.role, { guarded: true, k: 1 });
      const best = outcome.results[0]?.similarity ?? 0;
      scores[item.expect].push(best);
      console.log(`  ${best.toFixed(3)}  ${item.expect.padEnd(7)}  ${item.id}  ${item.question}`);
    }
    const lowestAnswerable = Math.min(...scores.answer);
    const highestUnanswerable = Math.max(...scores.abstain);
    console.log(`\nLowest answerable: ${lowestAnswerable.toFixed(3)} | highest unanswerable: ${highestUnanswerable.toFixed(3)}`);
    console.log(`Midpoint: ${((lowestAnswerable + highestUnanswerable) / 2).toFixed(3)} (current MIN_RELEVANCE: ${config.minRelevance})`);
  }
} finally {
  app.store.close();
}
