import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const CORPUS_DIR = path.join(PROJECT_ROOT, "corpus");
// Calibrated with `npm run ingest -- --calibrate` for gemini-embedding-001: answerable questions scored
// 0.666-0.881 and unanswerable ones 0.478-0.685. The ranges overlap, so this threshold only removes
// clearly off-topic questions; the model's abstention flag and the grounding check handle the rest.
export const DEFAULT_MIN_RELEVANCE = 0.62;

const EFFORTS = ["", "none", "minimal", "low", "medium", "high"] as const;

export interface Config {
  apiKey: string;
  baseUrl: string;
  model: string;
  reasoningEffort: Exclude<(typeof EFFORTS)[number], ""> | undefined;
  embeddingModel: string;
  port: number;
  home: string;
  minRelevance: number;
  allowedLinkHosts: string[];
  internalEmailDomains: string[];
}

function setting(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const effort = env.LLM_REASONING_EFFORT;
  return {
    apiKey: setting(env, "LLM_API_KEY") ?? "",
    baseUrl: z.string().url().parse(setting(env, "LLM_BASE_URL") ?? "https://generativelanguage.googleapis.com/v1beta/openai/"),
    model: setting(env, "LLM_MODEL") ?? "gemini-3.5-flash",
    reasoningEffort: (effort === undefined ? "low" : z.enum(EFFORTS).parse(effort.trim())) || undefined,
    embeddingModel: setting(env, "EMBEDDING_MODEL") ?? "gemini-embedding-001",
    port: z.coerce.number().int().min(1024).max(65535).parse(setting(env, "PORT") ?? 4318),
    home: path.resolve(setting(env, "AEGIS_HOME") ?? PROJECT_ROOT),
    minRelevance: z.coerce.number().min(0).max(1).parse(setting(env, "MIN_RELEVANCE") ?? DEFAULT_MIN_RELEVANCE),
    allowedLinkHosts: ["northwind.example"],
    internalEmailDomains: ["northwind.example"]
  };
}

export function loadDotEnv(file = path.join(process.cwd(), ".env")): void {
  try {
    process.loadEnvFile(file);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
}
