import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { z } from "zod";
import { createApp } from "./app.js";
import { PROJECT_ROOT, loadConfig, loadDotEnv } from "./config.js";
import { MAX_QUESTION_LENGTH } from "./guards/input.js";
import type { DemoUser } from "./shared.js";
import { DEMO_USERS } from "./users.js";

loadDotEnv();
const config = loadConfig();
const app = await createApp(config);
const WEB_ROOT = path.join(PROJECT_ROOT, "dist", "web");
const SESSION_MS = 8 * 60 * 60 * 1000;
const ASK_LIMIT = 10;
const ASK_WINDOW_MS = 60_000;
const sessions = new Map<string, { user: DemoUser; expires: number }>();
const askLog = new Map<string, number[]>();
const ASSET_TYPES: Record<string, string> = { ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > 16_384) {
      throw new z.ZodError([]);
    }
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

// The role always comes from the server-side session, never from the request body.
function currentUser(request: IncomingMessage): DemoUser | undefined {
  const header = request.headers.authorization;
  const token = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
  const session = sessions.get(token);
  if (session && session.expires < Date.now()) {
    sessions.delete(token);
  }
  return session && session.expires >= Date.now() ? session.user : undefined;
}

function rateLimited(userId: string): boolean {
  const now = Date.now();
  const recent = (askLog.get(userId) ?? []).filter(time => now - time < ASK_WINDOW_MS);
  const limited = recent.length >= ASK_LIMIT;
  if (!limited) {
    recent.push(now);
  }
  askLog.set(userId, recent);
  return limited;
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Content-Security-Policy", "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  const host = request.headers.host;
  if (host !== `127.0.0.1:${config.port}` && host !== `localhost:${config.port}`) {
    json(response, 403, { error: "Localhost access only." });
    return;
  }
  if (request.headers.origin && request.headers.origin !== `http://${host}`) {
    json(response, 403, { error: "Cross-origin requests are forbidden." });
    return;
  }
  const url = new URL(request.url ?? "/", `http://${host}`);
  const route = `${request.method} ${url.pathname}`;

  if (route === "GET /api/health") {
    json(response, 200, {
      status: "ok",
      documents: app.kb.documents.length,
      sections: app.kb.chunks.length,
      quarantined: app.kb.quarantinedCount,
      embeddings: app.kb.embeddingStatus,
      modelConfigured: Boolean(app.pipeline)
    });
  } else if (route === "GET /api/users") {
    json(response, 200, DEMO_USERS);
  } else if (route === "POST /api/login") {
    const { userId } = z.object({ userId: z.string().max(40) }).parse(await readJson(request));
    const user = DEMO_USERS.find(candidate => candidate.id === userId);
    if (!user) {
      json(response, 404, { error: "Unknown demo user." });
      return;
    }
    const token = randomBytes(32).toString("hex");
    sessions.set(token, { user, expires: Date.now() + SESSION_MS });
    json(response, 200, { token, user, model: app.pipeline?.modelName ?? null, embeddings: app.kb.embeddingStatus });
  } else if (url.pathname.startsWith("/api/")) {
    const user = currentUser(request);
    if (!user) {
      json(response, 401, { error: "Sign in again to continue." });
      return;
    }
    if (route === "POST /api/logout") {
      sessions.delete(String(request.headers.authorization).slice(7));
      json(response, 200, { signedOut: true });
    } else if (route === "GET /api/documents") {
      json(response, 200, app.kb.documentViews(user.role));
    } else if (route === "GET /api/audit") {
      json(response, 200, app.store.recentAudit(user.id));
    } else if (route === "POST /api/ask") {
      if (!app.pipeline) {
        json(response, 503, { error: "Set LLM_API_KEY in .env and restart to enable answers." });
        return;
      }
      if (rateLimited(user.id)) {
        json(response, 429, { error: `Rate limit: at most ${ASK_LIMIT} questions per minute. Please wait a moment.` });
        return;
      }
      const { question } = z.object({ question: z.string().max(MAX_QUESTION_LENGTH * 2) }).parse(await readJson(request));
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 90_000);
      response.on("close", () => controller.abort());
      try {
        json(response, 200, await app.pipeline.ask(user, question, { signal: controller.signal }));
      } finally {
        clearTimeout(timeout);
      }
    } else {
      json(response, 404, { error: "API route not found." });
    }
  } else if (request.method !== "GET") {
    json(response, 405, { error: "Method not allowed." });
  } else if (url.pathname === "/" || /^\/assets\/[\w.-]+\.(js|css|svg)$/.test(url.pathname)) {
    const file = url.pathname === "/" ? path.join(WEB_ROOT, "index.html") : path.join(WEB_ROOT, ...url.pathname.split("/").filter(Boolean));
    try {
      const data = await readFile(file);
      response.writeHead(200, {
        "Content-Type": url.pathname === "/" ? "text/html; charset=utf-8" : ASSET_TYPES[path.extname(file)]!,
        "Cache-Control": url.pathname === "/" ? "no-store" : "public, max-age=3600"
      });
      response.end(data);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
      json(response, 404, { error: url.pathname === "/" ? "Run npm run build first." : "Asset not found." });
    }
  } else {
    json(response, 404, { error: "Page not found." });
  }
}

const server = createServer((request, response) => {
  void handle(request, response).catch(error => {
    const clientError = error instanceof z.ZodError || error instanceof SyntaxError;
    if (!clientError && !(error instanceof Error && error.name === "AbortError")) {
      console.error("Request failed:", error instanceof Error ? error.name : "UnknownError");
    }
    if (!response.headersSent) {
      json(response, clientError ? 400 : 500, { error: clientError ? "Invalid request." : "Request failed. See the server terminal for details." });
    } else {
      response.end();
    }
  });
});

server.requestTimeout = 120_000;
server.listen(config.port, "127.0.0.1", () => {
  console.info(`Aegis RAG: http://127.0.0.1:${config.port}`);
  console.info(`Documents: ${app.kb.documents.length} | sections: ${app.kb.chunks.length} | quarantined: ${app.kb.quarantinedCount} | embeddings: ${app.kb.embeddingStatus} | model: ${app.pipeline?.modelName ?? "not configured"}`);
});
server.on("error", error => {
  console.error("Server failed:", error.message);
  app.store.close();
  process.exitCode = 1;
});

function shutdown(): void {
  server.close();
  server.closeAllConnections();
  app.store.close();
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, shutdown);
}
