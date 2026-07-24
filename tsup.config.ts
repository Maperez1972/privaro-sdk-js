import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "adapters/openai": "src/adapters/openai.ts",
    "adapters/langchain": "src/adapters/langchain.ts",
    "adapters/vercel-ai": "src/adapters/vercel-ai.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  treeshake: true,
  // Enables require()/__dirname/import.meta.url shims in whichever output
  // format doesn't natively have them (found needed 2026-07-24: the
  // Node-18 randomUUID fallback in utils.ts uses require("node:crypto"),
  // which doesn't exist as a global in the ESM output without this).
  shims: true,
  external: ["openai", "langchain", "ai", "@langchain/core"],
});
