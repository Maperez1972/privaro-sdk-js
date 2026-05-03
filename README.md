# @privaro/sdk

**Privacy infrastructure for enterprise AI** — intercepts PII before it reaches any LLM.

Drop-in SDK for Node.js and edge runtimes. Wraps your existing OpenAI, Anthropic, LangChain, or Vercel AI calls with automatic PII detection, tokenisation, and blockchain-certified audit logging — no architecture changes required.

```
npm install @privaro/sdk
```

---

## Quickstart

```ts
import { PrivaroClient } from "@privaro/sdk";

const privaro = new PrivaroClient({
  apiKey: process.env.PRIVARO_API_KEY!,      // starts with "prvr_"
  pipelineId: process.env.PRIVARO_PIPELINE_ID!,
});

const result = await privaro.protect(
  "Solicitante: Laura Sánchez Blanco, DNI 23456789D, IBAN ES98 2100 0418 6819 6340 7321"
);

console.log(result.protected);
// → "Solicitante: [NM-0001], DNI [ID-0001], IBAN [BK-0001]"

console.log(result.total_detected);  // 3
console.log(result.gdpr_compliant);  // true
console.log(result.audit_log_id);    // Supabase row UUID — linked to iBS blockchain cert
```

Pass `result.protected` to your LLM. The original values are stored in the Privaro token vault — retrievable on demand, never logged in plaintext.

---

## Installation

```
npm install @privaro/sdk
```

**Node.js ≥ 18** required. No native dependencies — uses the built-in `fetch` API.

Peer dependencies are optional — install only what you use:

```
npm install openai          # OpenAI adapter
npm install @langchain/openai langchain   # LangChain adapter
npm install ai              # Vercel AI SDK adapter
```

---

## Configuration

```ts
const privaro = new PrivaroClient({
  apiKey: "prvr_...",           // required — from /app/admin/api-keys
  pipelineId: "uuid",          // required — from /app/pipelines
  baseUrl: "https://...",      // optional — defaults to production Railway endpoint
  timeout: 10_000,             // optional — ms, default 10s
  defaultMode: "tokenise",     // optional — tokenise | anonymise | block
});
```

Get your API key and pipeline ID from [privaro.ai/app/admin](https://privaro.ai/app/admin).

---

## Core API

### `client.protect(prompt, opts?)`

Detect and tokenise PII. Writes an audit log entry with iBS blockchain certification.

```ts
const result = await privaro.protect("Patient María García, DNI 34521789X", {
  mode: "tokenise",          // tokenise | anonymise | block
  reversible: true,          // store reversible tokens in vault
  includeDetections: true,   // include per-entity details
});

// Send result.protected to your LLM
const llmResponse = await openai.chat.completions.create({
  messages: [{ role: "user", content: result.protected }],
  model: "gpt-4o",
});
```

**ProtectResult properties:**

```ts
result.protected        // tokenised prompt — send to LLM
result.original         // original text — stored client-side only
result.detections       // per-entity details array
result.total_detected   // number of PII entities found
result.total_masked     // number tokenised/anonymised
result.gdpr_compliant   // boolean
result.risk_score       // 0.0–1.0 | null
result.riskLevel        // "high" | "medium" | "low" | "unknown"
result.hasPii           // boolean convenience
result.isSafe           // gdpr_compliant && leaked === 0
result.audit_log_id     // Supabase UUID for DPO reports
result.processing_ms    // detection latency
result.summary()        // one-line log string
```

### `client.detect(prompt)`

Scan for PII without masking. No audit log written, no state changes. Use for analysis and reporting.

```ts
const result = await privaro.detect("Please call María at 677-23-45-67");
result.detections.forEach(d => {
  console.log(d.type, d.severity, d.start, d.end);
  // "phone", "high", 21, 33
});
```

### `client.relay(messages, opts?)`

Full-cycle relay: protect → route to your configured LLM → de-tokenise response. Requires an LLM provider configured in `/app/admin/providers`.

```ts
const result = await privaro.relay([
  { role: "user", content: "Analiza el contrato de María García, DNI 34521789X..." }
]);

console.log(result.response);   // LLM reply with original values restored
console.log(result.pii_masked); // number of entities protected
```

---

## Adapters

### OpenAI — drop-in wrapper

Replace your OpenAI client with the Privaro-wrapped version. Identical API surface.

```ts
import OpenAI from "openai";
import { PrivaroClient } from "@privaro/sdk";
import { wrapOpenAI } from "@privaro/sdk/adapters/openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const privaro = new PrivaroClient({
  apiKey: process.env.PRIVARO_API_KEY!,
  pipelineId: process.env.PRIVARO_PIPELINE_ID!,
});

const safe = wrapOpenAI(openai, privaro);

// Exactly the same call — PII protected and de-tokenised automatically
const response = await safe.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Analiza hipoteca de Laura Sánchez, DNI 23456789D" }],
});

console.log(response.choices[0].message.content); // real names restored in response
console.log(response._privaro?.pii_detected);      // 2
```

### LangChain — callback handler

Attach to any LangChain LLM or chain.

```ts
import { ChatOpenAI } from "@langchain/openai";
import { PrivaroClient } from "@privaro/sdk";
import { PrivaroCallbackHandler } from "@privaro/sdk/adapters/langchain";

const privaro = new PrivaroClient({
  apiKey: process.env.PRIVARO_API_KEY!,
  pipelineId: process.env.PRIVARO_PIPELINE_ID!,
});

const handler = new PrivaroCallbackHandler(privaro);

const llm = new ChatOpenAI({
  modelName: "gpt-4o",
  callbacks: [handler],
});

// PII tokenised automatically before reaching OpenAI
const response = await llm.invoke(
  "Revisa el contrato de María García, DNI 34521789X"
);
```

### Vercel AI SDK — middleware

Works with `generateText`, `streamText`, and `useChat`.

```ts
import { openai } from "@ai-sdk/openai";
import { generateText } from "ai";
import { PrivaroClient } from "@privaro/sdk";
import { privaroMiddleware } from "@privaro/sdk/adapters/vercel-ai";

const privaro = new PrivaroClient({
  apiKey: process.env.PRIVARO_API_KEY!,
  pipelineId: process.env.PRIVARO_PIPELINE_ID!,
});

const { text } = await generateText({
  model: openai("gpt-4o"),
  prompt: "Analiza el perfil de Carlos Gómez, DNI 45678901C",
  experimental_transform: privaroMiddleware(privaro),
});
// PII protected before OpenAI, de-tokenised in response
```

---

## Agent runs

For multi-step agents, `AgentRun` shares token scope across turns — `[NM-0001]` always refers to the same person throughout the conversation.

```ts
import { AgentRun } from "@privaro/sdk";

const run = new AgentRun({
  apiKey: process.env.PRIVARO_API_KEY!,
  pipelineId: process.env.PRIVARO_PIPELINE_ID!,
});

// Step 1 — protect user input
const step1 = await run.protect(
  "Review mortgage for Laura Sánchez, DNI 23456789D, income €2,340/mo"
);
const llmResponse = await openai.chat.completions.create({
  messages: step1.protected_messages,
  model: "gpt-4o",
});

// Step 2 — protect tool output (same run, same token scope)
const step2 = await run.protect("CIRBE score: 742 for DNI 23456789D");

// Restore original values in final response
const finalText = await run.reveal(llmResponse.choices[0].message.content!);
```

---

## Module-level API

Mirrors the Python SDK pattern for simpler apps:

```ts
import privaro from "@privaro/sdk";

privaro.init({
  apiKey: process.env.PRIVARO_API_KEY!,
  pipelineId: process.env.PRIVARO_PIPELINE_ID!,
});

const result = await privaro.protect("Patient DNI 34521789X...");
```

---

## Error handling

```ts
import {
  PrivaroError,
  AuthError,
  PipelineNotFoundError,
  PolicyBlockError,
  RateLimitError,
  ProxyUnavailableError,
} from "@privaro/sdk";

try {
  const result = await privaro.protect(prompt);
} catch (err) {
  if (err instanceof PolicyBlockError) {
    // Request blocked by privacy policy (mode: "block")
    return res.status(403).json({ error: "PII blocked" });
  }
  if (err instanceof AuthError) {
    // Invalid or expired API key
  }
  if (err instanceof RateLimitError) {
    // Implement exponential backoff
  }
  if (err instanceof ProxyUnavailableError) {
    // Network issue — proxy unreachable
  }
  // All errors extend PrivaroError
}
```

---

## Detected entity types

| Type | Severity | Examples |
|------|----------|---------|
| `full_name` | medium | María López Fernández, Dr. García |
| `email` | medium | user@empresa.com |
| `phone` | high | 677 23 45 67, +34 612 345 678 |
| `dni` | critical | 23456789D, 34521789X |
| `iban` | critical | ES91 2100 0418 4502 0005 1332 |
| `credit_card` | critical | 4111 1111 1111 1111 |
| `ssn` | critical | 123-45-6789 |
| `health_record` | critical | SIP/TSI card numbers |
| `ip_address` | medium | 192.168.1.45 |
| `date_of_birth` | medium | nacido 14/03/1978 |
| `session_id` | low | sess_8f3a2b1c |
| `policy_number` | high | nº póliza 00123456 |

Detection uses a hybrid engine: deterministic regex (Tier 1) + Microsoft Presidio with spaCy `es_core_news_md` (Tier 2). All detection runs server-side on the Railway proxy.

---

## Environment variables

```bash
PRIVARO_API_KEY=prvr_...
PRIVARO_PIPELINE_ID=550e8400-e29b-41d4-a716-446655440000
PRIVARO_BASE_URL=https://privaro-proxy-production.up.railway.app/v1  # optional
```

---

## Requirements

- **Node.js ≥ 18** — uses native `fetch` and `crypto.randomUUID`
- **Edge runtimes** — Cloudflare Workers, Vercel Edge, Deno: all supported
- **CommonJS** — bundled as both ESM and CJS

---

## Links

- [privaro.ai](https://privaro.ai) — product and live demo
- [privaro.ai/pricing](https://privaro.ai/pricing) — plans
- [Dashboard](https://privaro.ai/app) — pipelines, audit logs, DPO reports
- [Python SDK](https://github.com/Maperez1972/privaro-sdk-python) — `pip install privaro`
- [Proxy](https://github.com/Maperez1972/privaro-proxy) — FastAPI backend (Railway)

---

MIT © [iCommunity Labs](https://privaro.ai)
