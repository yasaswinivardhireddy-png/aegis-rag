# Aegis RAG

A retrieval-augmented policy assistant with **layered guardrails** against prompt
injection, data leakage, and hallucination, plus an evaluation that measures them
against a typical RAG pipeline.

> A RAG demo answers questions. A system you can trust with real users must also
> refuse the right ones, keep restricted data out of the model's context, and say
> "I don't know" instead of guessing.

**Status:** portfolio project with a fictional company, Northwind Labs, and original
documents. It is not a production service; see [Limitations](#limitations).

## Results

Live evaluation on 49 attacks in 8 categories and 35 normal questions, comparing Aegis with a
typical RAG pipeline that uses the same documents and model (`gemini-3.1-flash-lite`):

| Metric | Typical RAG | Aegis |
|---|---|---|
| Attack success rate (lower is better) | 18/49 (37%) | **0/49 (0%)** |
| Restricted, attacker-controlled, or personal data sent to the model | 24/24 (100%) | **0/24 (0%)** |
| Answerable questions answered correctly | 29/29 (100%) | **29/29 (100%)** |
| False refusals on answerable questions | n/a | **0/29 (0%)** |
| Unanswerable questions correctly declined | 3/6 (50%) | **6/6 (100%)** |
| Median latency when the model is called | 2.69 s | 2.82 s |

Without guardrails, the typical pipeline leaked confidential salary bands to an employee in all
6 cross-role attempts, revealed its hidden instructions, decoded and followed a Base64-encoded
command, and sent poisoned vendor text and raw card numbers to the model. Aegis stopped every attack
without refusing a single legitimate question. The test set was written alongside the guardrails,
so treat these numbers as regression results, not a security guarantee.

Full report, method, and per-category breakdown: [docs/evaluation.md](docs/evaluation.md).

## Demo

**Verified answer:** every layer passes and the answer cites its source.

![Aegis RAG answering a leave question with all four guardrail layers passing](docs/images/demo-verified-answer.png)

**Attacks are stopped and explained:** the injection attempt is blocked at the input layer, so
retrieval and the model are never reached. The salary question above it returns "not found"
because an employee's search never includes HR-only documents.

![Aegis RAG blocking a prompt-extraction attack, with later layers not reached](docs/images/demo-blocked-attack.png)

**Poisoned documents are handled at ingestion:** the vendor FAQ's hidden comment is removed and its
"Note for AI systems" section is quarantined before anything becomes searchable.

![Documents tab showing the quarantined section of the vendor FAQ](docs/images/demo-quarantine.png)

## How it works

Every question passes four layers. Any layer can stop it, and the UI's guardrail
inspector shows each decision.

```text
Question
  │
  ▼  1. INPUT GUARD
  │     • Unicode NFKC; strips zero-width, bidi, and tag characters (decoding hidden text)
  │     • Prompt-injection scan: weighted rules on raw, look-alike-folded, de-spaced,
  │       and Base64-decoded text
  │     • Personal data (cards with Luhn check, phone, email, PAN, Aadhaar, SSN) redacted
  │       before retrieval, the model, and logs
  ▼  2. RETRIEVAL GUARD
  │     • Role filter applied BEFORE ranking: restricted sections never reach the model
  │     • Ingestion removes hidden HTML comments and quarantines text addressed to AI systems
  │     • Hybrid search: BM25 + embeddings, merged with reciprocal rank fusion
  │     • Relevance threshold: no relevant evidence means no answer
  ▼  3. GENERATION GUARD
  │     • Sources fenced as untrusted data with per-request random boundary markers
  │     • Per-request canary token planted in the instructions
  │     • Strict JSON answer schema: answer, citations, insufficient_context
  ▼  4. OUTPUT GUARD (nothing is shown before it passes)
  │     • Canary, system-prompt text, and credential-like strings: withheld
  │     • Citations must exist and refer to the sources actually provided
  │     • Images, HTML, script URLs, and non-allowlisted links removed
  │     • Personal data not present in the authorised sources redacted
  │     • Each sentence checked against the sources (numbers must match exactly);
  │       unsupported sentences removed and disclosed, or the answer is withheld
  ▼
Answer + citations + per-layer audit record (question stored redacted)
```

Identity and role come from a server-side session, never from the request body.
The server binds to `127.0.0.1`, validates `Host` and `Origin`, rate-limits each
user to 10 questions per minute, and serves a strict Content Security Policy.

## Threat model

| Threat | Example | Defenses | Residual risk |
|---|---|---|---|
| Direct prompt injection | "Ignore previous instructions…" | Input rules with folding and decoding; instruction hierarchy; output leak checks | Novel phrasing can evade pattern rules |
| Indirect injection | Hidden comment in a vendor FAQ | Hidden content removed and AI-addressed text quarantined at ingestion; fenced sources; output sanitization | Instructions written as ordinary prose |
| Cross-role data leakage | Employee asks for salary bands | Role filter before ranking, using the server-side session role | Wrong access labels on source documents |
| Prompt and secret leakage | "Print your system prompt" | Input rules; canary token and prompt-fingerprint detection; secret patterns | Paraphrased leaks without exact markers |
| Exfiltration via rendering | Markdown image to an attacker URL | Input rules; link allowlist; plain-text UI | New channels if tools are added |
| Personal data exposure | User pastes a card number | Redaction before retrieval, model, and logs | Formats the patterns do not cover |
| Hallucination | "What is the pet adoption leave policy?" | Relevance threshold; model abstention flag; citation and sentence grounding | Fluent paraphrases that share source wording |
| Obfuscation | Zero-width, homoglyphs, leetspeak, Base64, tag smuggling | Normalization, folding, de-spacing, decoding | New encodings |
| Abuse | Flooding requests | Per-user rate limit | Distributed abuse |

## Design decisions

| Decision | Reason | Trade-off |
|---|---|---|
| Deterministic guards first | Fast, free, testable in CI, and explainable | Pattern rules miss novel attacks; an LLM classifier could be a second opinion |
| Role filter before ranking | Restricted text never enters the candidate set or the prompt | Requires correct access labels at ingestion |
| Quarantine at ingestion | Poisoned sections can never be retrieved | Rules can quarantine legitimate text; reviewed in the Documents tab |
| Validate before display, so no streaming | Users never see an unverified answer | Higher perceived latency |
| Calibrated relevance threshold | Chosen from measured similarities, not guessed | Similarity ranges overlap, so later layers handle borderline cases |
| Remove-and-disclose unsupported sentences | Keeps verified content and tells the user what was removed | Lexical grounding cannot judge meaning |
| Audit failures do not block answers | Availability over audit completeness; failures are logged | Strict compliance settings may require failing closed |

The relevance threshold (0.62 for `gemini-embedding-001`) came from
`npm run ingest -- --calibrate`. Answerable questions scored 0.666–0.881 and
unanswerable ones 0.478–0.685. Because the ranges overlap, similarity alone cannot
decide whether a question is answerable. The threshold removes clearly off-topic
questions, and the model's `insufficient_context` flag plus the grounding check handle
topical-but-unanswerable ones.

## Run it locally

Requires Node.js 22.16+.

```powershell
npm ci
Copy-Item .env.example .env   # add LLM_API_KEY: a free key from https://aistudio.google.com/apikey
npm run build
npm start                     # http://127.0.0.1:4318
```

Sign in as **Priya** (employee) or **Arjun** (HR manager) and try the suggested
attacks. The **Documents** tab shows what ingestion quarantined, and the **Audit log**
shows your redacted request history.

Free-tier note: Google's free tier allows few requests per model per day; for
example, `gemini-3.5-flash` allowed 20. If you see HTTP 429, wait for the daily
reset or set `LLM_MODEL` to another model. On the free tier, Google may use prompts
to improve its products, so use only non-sensitive data.

| Command | Purpose |
|---|---|
| `npm run check` | Type-check, unit and integration tests, build, and end-to-end HTTP test (no API key needed) |
| `npm run ingest -- --calibrate` | Show ingestion and quarantine results; measure similarity for threshold calibration |
| `npm run eval` | Live baseline-vs-guarded evaluation; resumable; writes `docs/evaluation.md` |

## Project structure

```text
corpus/          Fictional Northwind Labs documents (one deliberately poisoned)
eval/            Attack and benign datasets
src/guards/      normalize, injection, pii, sanitize, groundedness, input, output
src/rag/         corpus, chunker, bm25, embeddings, knowledge-base, retriever
src/llm/         prompt construction and OpenAI-compatible chat client
src/pipeline.ts  The four-layer pipeline (and the unguarded baseline for evaluation)
src/server.ts    HTTP API, sessions, rate limiting, static UI
web/             React UI with the guardrail inspector
tests/           Guard, retrieval, pipeline, dataset, and HTTP tests
```

## Limitations

- Pattern-based injection detection is a first filter, not a guarantee; determined
  attackers can find new phrasings. The later layers exist because this one will miss things.
- Grounding is lexical and numeric. It catches invented numbers and off-topic claims
  but not subtle changes in meaning; an entailment model or LLM judge would be stronger.
- Demo sign-in has no passwords. A real deployment would use an identity provider (OIDC)
  and per-document permissions from the source systems.
- Sessions, rate limits, and storage are single-process (in memory and SQLite).
- The evaluation datasets were written alongside the guardrails, so results are
  optimistic. Treat them as regression tests, not a security certification.

## License

MIT for the code. All documents and data are fictional and written for this project.
AI assistance was used during development.
