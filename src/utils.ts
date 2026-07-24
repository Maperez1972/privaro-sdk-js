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
 * check is tried first and covers those environments; the node:crypto
 * import is the fallback used only where the global genuinely isn't
 * there, i.e. real Node 18 without the flag.
 */
export function randomUUID(): string {
  const g = globalThis as unknown as { crypto?: { randomUUID?: () => string } };
  if (typeof g.crypto?.randomUUID === "function") {
    return g.crypto.randomUUID();
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const nodeCrypto = require("node:crypto");
  return nodeCrypto.randomUUID();
}
