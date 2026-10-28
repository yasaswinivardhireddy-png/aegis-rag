export type Role = "employee" | "hr";
export type Verdict = "pass" | "warn" | "block";
export type Outcome = "answered" | "abstained" | "blocked" | "error";
export type LayerName = "input" | "retrieval" | "generation" | "output";

export interface Check {
  name: string;
  verdict: Verdict;
  detail: string;
}

export interface LayerReport {
  layer: LayerName;
  verdict: Verdict;
  checks: Check[];
}

export interface SourceView {
  alias: string;
  docTitle: string;
  section: string;
  text: string;
  similarity: number | null;
  keywordScore: number;
}

export interface AskResult {
  outcome: Outcome;
  answer: string;
  citations: SourceView[];
  sources: SourceView[];
  layers: LayerReport[];
  latencyMs: number;
}

export interface DemoUser {
  id: string;
  name: string;
  title: string;
  role: Role;
}

export interface QuarantineView {
  chunkId: string;
  section: string;
  action: "quarantined" | "hidden_content_removed";
  reason: string;
}

export interface DocumentView {
  id: string;
  title: string;
  access: Role;
  sections: number;
  quarantine: QuarantineView[];
}

export interface AuditView {
  at: string;
  outcome: Outcome;
  preview: string;
  verdicts: Record<LayerName, Verdict | "skipped">;
  latencyMs: number;
}

export function worstVerdict(verdicts: Verdict[]): Verdict {
  return verdicts.includes("block") ? "block" : verdicts.includes("warn") ? "warn" : "pass";
}
