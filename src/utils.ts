/**
 * Isomorphic randomUUID — works in Node.js (any version this SDK
 * supports, engines.node >= 18), edge runtimes, and browsers.
 *
 * Why this exists (found 2026-07-24 via a real CI failure on Node 18):
 * globalThis.crypto.randomUUID() is NOT available without a flag in
 * Node.js 18 (ReferenceError: crypto is not defined) — it only became a
 * global without --experimental-global-webcrypto starting in Node 19.
 * Browsers and edge runtimes (Cloudflare Workers, Vercel Edge, etc.) all
 * have had globalThis.crypto.randomUUID for a long time, so the global
 * check is tried first and covers those environments; node:crypto is
 * the fallback used only where the global genuinely isn't there, i.e.
 * real Node 18 without the flag.
 *
 * Uses createRequire() rather than a bare `require(...)` call — a bare
 * require is undefined in an ESM module on Node 18 without a bundler's
 * shim (tsup's shims:true only patches the COMPILED dist/ output, not
 * this source file when ts-jest runs it directly in tests).
 *
 * Deliberately does NOT anchor createRequire on import.meta.url: this
 * repo's ts-jest transform config rejects import.meta outside its own
 * isolated per-file module setting ("import.meta meta-property is only
 * allowed when..."), and it's unnecessary anyway — we're only ever
 * resolving a Node built-in (node:crypto), whose resolution doesn't
 * depend on the anchor path at all. process.cwd() is any valid absolute
 * path, evaluated lazily inside the function (not at module load time),
 * so it's never touched in browser/edge environments, where this branch
 * is never reached because globalThis.crypto.randomUUID already exists.
 */
import { createRequire } from "node:module";

export function randomUUID(): string {
  const g = globalThis as unknown as { crypto?: { randomUUID?: () => string } };
  if (typeof g.crypto?.randomUUID === "function") {
    return g.crypto.randomUUID();
  }
  const require = createRequire(process.cwd() + "/");
  const nodeCrypto = require("node:crypto");
  return nodeCrypto.randomUUID();
}
