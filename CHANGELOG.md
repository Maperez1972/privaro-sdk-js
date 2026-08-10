# Changelog

## 0.4.0 — 2026-08-10

Output-direction PII detection. Until now the SDK (and the proxy) only
ever scanned text going *into* an LLM. Direct production evidence showed
the gap: `conversation_messages` had 1,175 PII detections across 76 input
messages and zero across 78 output messages, and `pipelines.total_leaked`
read 0 across every pipeline. `relay()`/`relayStream()` already scan the
LLM response inline (Privaro makes the LLM call itself there), but
callers who use `protect()` and then hit their own LLM directly had no
equivalent — until now.

- **Added `client.protectOutput(responseText, opts?)`** and the
  module-level `privaro.protectOutput(...)` — calls the new
  `POST /v1/proxy/protect-output` endpoint to scan/mask PII in your LLM's
  raw response text before you return it to your own end user. Same
  `mode`/`reversible`/`conversationId`/`idempotencyKey` contract as
  `protect()` — pass the same `conversationId` you used for the matching
  `protect()` call so tokens replace consistently across the turn.
- **Added `ProtectOutputResult`** — mirrors `ProtectResult` but adds
  `.scan_mode` (`"shadow"` | `"enforce"`, reflecting the pipeline's
  dashboard setting) and `.response_modified`.
- **Added `OutputScanningDisabledError`** — thrown (not a silent
  passthrough) when the target pipeline hasn't opted into output
  scanning (`pipeline.output_scanning_enabled=false`). Enable it per
  pipeline in the dashboard: Pipelines → Settings → Output scanning.
- No breaking changes to existing methods.

## 0.3.0 — 2026-08-07

Found during a full backend integration audit of Context Optimization (privaro-proxy PR #1): the API gained the ability to compress tokenised prompts/messages before sending them to your LLM, but the SDK had no way to request or read it.

- **Added `optimizeContext?: boolean` to `ProtectOptions` and `RelayOptions`** — opt-in, defaults to `false`. Compresses the tokenised prompt/messages before the LLM call, reducing tokens sent. Never touches PII tokens (`[XX-0001]`) — verified end-to-end against real documents before release.
- **Added `compressionStats` to `ProtectResult`** (camelCase, field-mapped) and **`compression_stats` to `RelayResult`** (snake_case, direct passthrough — consistent with every other field on that interface) — populated only when `optimizeContext: true` was passed and the compressor actually ran.
- **`AgentRun.protect()`** now accepts an `optimizeContext` third argument and surfaces `compressionStats` on the resulting `AgentStep`.
- No breaking changes — all new fields are optional and default to `undefined`/`false`.

## 0.2.0 — 2026-07-24

Prompted by a real integration in progress (Octupus/Robin AI) asking whether they needed to build their own detokenization for a streaming chat — they didn't, but the SDK had no way to actually use streaming at all.

- **Added `client.relayStream(messages, opts?)`** — streams the LLM's response as it's generated (SSE under the hood), yielding already de-tokenised text deltas. Supported for OpenAI, Azure OpenAI, and Anthropic today; other providers throw a clear error.
- **Fixed:** `DEFAULT_BASE_URL` pointed at the old Railway auto-generated domain (`privaro-proxy-production.up.railway.app`) instead of the custom domain (`api.privaro.ai`). Both still resolve today, but the SDK should point at the real one.
- **Added `conversationId` and `idempotencyKey` to `RelayOptions`** (previously only available on `ProtectOptions`) — `relay()` now supports both; `relayStream()` supports `conversationId` (idempotency doesn't apply to a stream — see README).
- Tests: added coverage for `relayStream()`, including the case where a single SSE event is split across two raw network chunks (verifies the parser buffers correctly instead of dropping a partial delta).

## 0.1.0

Initial release — `protect()`, `detect()`, `relay()`, `AgentRun` (multi-step agent token consistency), OpenAI/LangChain/Vercel AI adapters.
