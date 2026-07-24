# Changelog

## 0.2.0 — 2026-07-24

Prompted by a real integration in progress (Octupus/Robin AI) asking whether they needed to build their own detokenization for a streaming chat — they didn't, but the SDK had no way to actually use streaming at all.

- **Added `client.relayStream(messages, opts?)`** — streams the LLM's response as it's generated (SSE under the hood), yielding already de-tokenised text deltas. Supported for OpenAI, Azure OpenAI, and Anthropic today; other providers throw a clear error.
- **Fixed:** `DEFAULT_BASE_URL` pointed at the old Railway auto-generated domain (`privaro-proxy-production.up.railway.app`) instead of the custom domain (`api.privaro.ai`). Both still resolve today, but the SDK should point at the real one.
- **Added `conversationId` and `idempotencyKey` to `RelayOptions`** (previously only available on `ProtectOptions`) — `relay()` now supports both; `relayStream()` supports `conversationId` (idempotency doesn't apply to a stream — see README).
- Tests: added coverage for `relayStream()`, including the case where a single SSE event is split across two raw network chunks (verifies the parser buffers correctly instead of dropping a partial delta).

## 0.1.0

Initial release — `protect()`, `detect()`, `relay()`, `AgentRun` (multi-step agent token consistency), OpenAI/LangChain/Vercel AI adapters.
