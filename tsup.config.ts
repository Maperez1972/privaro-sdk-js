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
  external: ["openai", "langchain", "ai", "@langchain/core"],
});
