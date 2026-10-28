import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { AuditView, LayerName, LayerReport, Outcome, Role, Verdict } from "./shared.js";

const LAYERS: LayerName[] = ["input", "retrieval", "generation", "output"];

export interface AuditEntry {
  userId: string;
  role: Role;
  // Normalized, PII-redacted question. The raw question is never stored.
  question: string;
  outcome: Outcome;
  layers: LayerReport[];
  latencyMs: number;
}

export class Store {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS embeddings (key TEXT PRIMARY KEY, model TEXT NOT NULL, vector BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS audit (
        id TEXT PRIMARY KEY, at TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, question_hash TEXT NOT NULL,
        preview TEXT NOT NULL, outcome TEXT NOT NULL, verdicts TEXT NOT NULL, latency_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS audit_user_at ON audit (user_id, at);
    `);
  }

  getEmbeddings(keys: string[]): Map<string, Float32Array> {
    const found = new Map<string, Float32Array>();
    const statement = this.db.prepare("SELECT vector FROM embeddings WHERE key = ?");
    for (const key of new Set(keys)) {
      const row = statement.get(key) as { vector: Uint8Array } | undefined;
      if (row) {
        found.set(key, new Float32Array(row.vector.buffer.slice(row.vector.byteOffset, row.vector.byteOffset + row.vector.byteLength)));
      }
    }
    return found;
  }

  putEmbedding(key: string, model: string, vector: Float32Array): void {
    this.db.prepare("INSERT OR REPLACE INTO embeddings (key, model, vector) VALUES (?, ?, ?)")
      .run(key, model, new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength));
  }

  recordAudit(entry: AuditEntry): void {
    const verdicts = Object.fromEntries(entry.layers.map(layer => [layer.layer, layer.verdict]));
    this.db.prepare(`INSERT INTO audit (id, at, user_id, role, question_hash, preview, outcome, verdicts, latency_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      randomUUID(), new Date().toISOString(), entry.userId, entry.role,
      createHash("sha256").update(entry.question).digest("hex"), entry.question.slice(0, 120),
      entry.outcome, JSON.stringify(verdicts), Math.round(entry.latencyMs)
    );
  }

  recentAudit(userId: string, limit = 25): AuditView[] {
    const rows = this.db.prepare("SELECT at, outcome, preview, verdicts, latency_ms FROM audit WHERE user_id = ? ORDER BY at DESC LIMIT ?")
      .all(userId, limit) as unknown as { at: string; outcome: Outcome; preview: string; verdicts: string; latency_ms: number }[];
    return rows.map(row => {
      const stored = JSON.parse(row.verdicts) as Partial<Record<LayerName, Verdict>>;
      const verdicts = Object.fromEntries(LAYERS.map(layer => [layer, stored[layer] ?? "skipped"])) as AuditView["verdicts"];
      return { at: row.at, outcome: row.outcome, preview: row.preview, verdicts, latencyMs: row.latency_ms };
    });
  }

  close(): void {
    this.db.close();
  }
}
