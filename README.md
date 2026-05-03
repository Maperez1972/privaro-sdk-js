# @privaro/sdk

**Privacy Infrastructure for Enterprise AI** — JavaScript/TypeScript SDK by [iCommunity Labs](https://privaro.ai)

Protect what your AI sees. Privaro intercepts prompts, detects and tokenises PII before it reaches any LLM, and generates GDPR-ready audit trails with blockchain certification.

```bash
npm install @privaro/sdk
```

---

## Quick start

```ts
import { PrivaroClient } from "@privaro/sdk";

const privaro = new PrivaroClient({
  apiKey: process.env.PRIVARO_API_KEY,      // starts with "prvr_"
  pipelineId: process.env.PRIVARO_PIPELINE_ID,
});

const result = await privaro.protect(
  "Patient María García, DNI 34521789X, IBAN ES91 2100 0418 4502 0005 1332"
);

console.log(result.protected);
// "Patient [NM-0001], DNI [ID-0001], IBAN [BK-0001]"

// Safe to send to any LLM — no PII in the request
const response = await openai.chat.completions.create({
  messages: [{ role: "user", content: result.protected }],
});
```

---

## Installation

```bash
npm install @privaro/sdk       # npm
pnpm add @privaro/sdk          # pnpm
yarn add @privaro/sdk           # yarn
```

**Requirements:** Node.js ≥ 18. Zero runtime dependencies — uses native `fetch`.

---

## API reference

### `new PrivaroClient(opts)`

| Option | Type | Required | Default |
|--------|------|----------|---------|
| `apiKey` | `string` | ✓ | — |
| `pipelineId` | `string` | ✓ | — |
| `baseUrl` | `string` | | production Railway endpoint |
| `timeout` | `number` (ms) | | `10000` |
| `defaultMode` | `"tokenise" \| "anonymise" \| "block"` | | `"tokenise"` |

---

### `client.protect(prompt, opts?)`

Detect and tokenise PII. Writes an audit log entry and triggers iBS blockchain certification.

```ts
const result = await client.protect("Review contract for Juan García, DNI 45678901C");
```

**Options:**

| Option | Type | Default |
|--------|------|---------|
| `mode` | `"tokenise" \| "anonymise" \| "block"` | client default |
| `reversible` | `boolean` | `true` |
| `agentMode` | `boolean` | `false` |
| `includeDetections` | `boolean` | `true` |
| `conversationId` | `string` | — |

**Returns: `ProtectResult`**

```ts
result.protected       // tokenised prompt — send to your LLM
result.original        // original text — never sent to proxy
result.detections      // per-entity details
result.total_detected  // number
result.total_masked    // number
result.coverage_pct    // 0–100
result.risk_score      // 0.0–1.0 | null
result.gdpr_compliant  // boolean
result.audit_log_id    // Supabase row UUID
result.processing_ms   // latency

// Computed helpers
result.riskLevel       // "high" | "medium" | "low" | "unknown"
result.hasPii          // boolean
result.isSafe          // gdpr_compliant && leaked === 0
result.summary()       // "[Privaro] 3 detected, 3 masked, risk=low, 42ms"
```

---

### `client.detect(prompt)`

Analyse a prompt for PII without masking or writing an audit log. Use for reporting and analysis.

```ts
const result = await client.detect("Texto con datos sensibles");
result.protected === result.original  // true — never modifies the text
result.detections  // full entity list with start/end offsets
```

---

### `client.relay(messages, opts?)`

Full-cycle relay: protect → send to configured LLM → de-tokenise response. Requires your LLM API key configured in `/app/admin/providers`.

```ts
const result = await client.relay([
  { role: "user", content: "Analiza contrato de María García..." }
]);

console.log(result.response);  // LLM reply with tokens replaced by real values
console.log(result.pii_detected);
console.log(result.gdpr_compliant);
```

---

### `AgentRun` — multi-step agent sessions

Maintains a shared `conversationId` so token references are consistent across turns — `[NM-0001]` always refers to the same person throughout the session.

```ts
import { AgentRun } from "@privaro/sdk";

const run = new AgentRun({
  apiKey: process.env.PRIVARO_API_KEY,
  pipelineId: process.env.PRIVARO_PIPELINE_ID,
});

// Step 1 — protect
const step = await run.protect("Analiza el contrato de Juan García, DNI 45678901C");
// step.protected_messages → [{ role: "user", content: "Analiza el contrato de [NM-0001], DNI [ID-0001]" }]
// step.first_content → same as above

// Send to your LLM
const llmResponse = await openai.chat.completions.create({
  messages: step.protected_messages,
  model: "gpt-4o",
});

// Step 2 — reveal tokens in the response
const revealed = await run.reveal(llmResponse.choices[0].message.content);
// "[NM-0001]" → "Juan García" — token replaced with real value
```

---

## Adapters

### OpenAI drop-in

Wrap your existing OpenAI client — same API, PII protected automatically:

```ts
import OpenAI from "openai";
import { PrivaroClient } from "@privaro/sdk";
import { wrapOpenAI } from "@privaro/sdk/adapters/openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const privaro = new PrivaroClient({
  apiKey: process.env.PRIVARO_API_KEY,
  pipelineId: process.env.PRIVARO_PIPELINE_ID,
});

const safe = wrapOpenAI(openai, privaro);

// Exactly the same call — zero code changes
const response = await safe.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Analiza contrato de María García, DNI 34521789X" }],
});

// response._privaro → { pii_detected: 2, pii_masked: 2, audit_log_id: "..." }
```

---

### LangChain

```ts
import { ChatOpenAI } from "@langchain/openai";
import { PrivaroClient } from "@privaro/sdk";
import { PrivaroCallbackHandler } from "@privaro/sdk/adapters/langchain";

const privaro = new PrivaroClient({ apiKey: "prvr_...", pipelineId: "uuid" });
const handler = new PrivaroCallbackHandler(privaro);

const llm = new ChatOpenAI({
  modelName: "gpt-4o",
  callbacks: [handler],  // attach here — no other changes needed
});

const response = await llm.invoke("Contract review for María García, DNI 34521789X");
// PII tokenised before hitting OpenAI, de-tokenised in the response
```

---

### Vercel AI SDK

```ts
import { openai } from "@ai-sdk/openai";
import { generateText } from "ai";
import { PrivaroClient } from "@privaro/sdk";
import { privaroMiddleware } from "@privaro/sdk/adapters/vercel-ai";

const privaro = new PrivaroClient({ apiKey: "prvr_...", pipelineId: "uuid" });

const { text } = await generateText({
  model: openai("gpt-4o"),
  prompt: "Analiza contrato de María García, DNI 34521789X",
  experimental_transform: privaroMiddleware(privaro),
});
```

---

## Entity types detected

| Type | Severity | Description |
|------|----------|-------------|
| `full_name` | medium | Person names (ES/EU context) |
| `email` | medium | Email addresses |
| `phone` | high | Phone numbers (ES format + international) |
| `dni` | critical | Spanish DNI / NIE / NIF |
| `iban` | critical | IBAN (all countries) |
| `credit_card` | critical | Credit/debit card numbers |
| `health_record` | critical | SIP / TSI health card numbers |
| `ip_address` | medium | IPv4 private addresses |
| `date_of_birth` | medium | Date of birth patterns |
| `ssn` | critical | US Social Security Numbers |

---

## Error handling

```ts
import {
  AuthError,
  PipelineNotFoundError,
  PolicyBlockError,
  RateLimitError,
  ProxyUnavailableError,
  PrivaroError,
} from "@privaro/sdk";

try {
  const result = await client.protect(prompt);
} catch (err) {
  if (err instanceof PolicyBlockError) {
    // Request contained PII that policy says to block entirely
    return res.status(400).json({ error: "Sensitive data detected" });
  }
  if (err instanceof AuthError) {
    // Invalid API key or insufficient permissions
  }
  if (err instanceof RateLimitError) {
    // Slow down — implement exponential backoff
  }
  if (err instanceof ProxyUnavailableError) {
    // Network issue — check PRIVARO_BASE_URL and Railway status
  }
  if (err instanceof PrivaroError) {
    // Other Privaro-specific error
    console.error(err.message, err.cause);
  }
}
```

---

## Environment variables

```bash
PRIVARO_API_KEY=prvr_your_key_here
PRIVARO_PIPELINE_ID=your-pipeline-uuid
# Optional — override for staging/self-hosted:
PRIVARO_BASE_URL=https://privaro-proxy-production.up.railway.app/v1
```

---

## Module-level API (Python-style)

For projects that prefer a module-level singleton over explicit instantiation:

```ts
import privaro from "@privaro/sdk";

privaro.init({
  apiKey: process.env.PRIVARO_API_KEY,
  pipelineId: process.env.PRIVARO_PIPELINE_ID,
});

const result = await privaro.protect("Patient María García, DNI 34521789X");
const analysis = await privaro.detect("Text to analyse without masking");
```

---

## Links

- **Dashboard:** [app.privaro.ai](https://privaro.ai/app)
- **Docs:** [docs.privaro.ai](https://docs.privaro.ai)
- **Python SDK:** [privaro-sdk-python](https://github.com/Maperez1972/privaro-sdk-python)
- **Support:** hola@privaro.ai

---

## License

MIT © [iCommunity Labs](https://privaro.ai)
