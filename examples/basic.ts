/**
 * @privaro/sdk — Basic usage examples
 * Run: npx tsx examples/basic.ts
 */

import { PrivaroClient, AgentRun } from "../src/index.js";
import type { ProtectResult } from "../src/types/index.js";

const client = new PrivaroClient({
  apiKey: process.env.PRIVARO_API_KEY ?? "prvr_your_key_here",
  pipelineId: process.env.PRIVARO_PIPELINE_ID ?? "your-pipeline-uuid",
});

// ── Example 1: Basic protect ──────────────────────────────────────────────────

async function example1_basicProtect() {
  console.log("\n── Example 1: protect() ──");

  const result: ProtectResult = await client.protect(
    "Solicitante: Laura Sánchez Blanco (DNI: 23456789D)\n" +
    "Email: laura.sanchez@empresa.com · Teléfono: 677 23 45 67\n" +
    "IBAN domiciliación: ES98 2100 0418 6819 6340 7321\n" +
    "Score CIRBE: 742/850 · Ratio deuda/ingresos: 34,2%"
  );

  console.log("Protected:\n", result.protected);
  console.log("\nSummary:", result.summary());
  console.log("Safe to send to LLM:", result.isSafe);
  console.log("Entities detected:");
  result.detections.forEach((d) => {
    console.log(`  [${d.severity.toUpperCase()}] ${d.type} → ${d.token}`);
  });
}

// ── Example 2: detect-only (no masking) ──────────────────────────────────────

async function example2_detectOnly() {
  console.log("\n── Example 2: detect() — no masking ──");

  const result = await client.detect(
    "Clinical note: patient Ana Ruiz Torres (DNI: 87654321B), " +
    "email ana.ruiz@hospital.es, phone 699-12-34-56"
  );

  console.log("Original returned unchanged:", result.protected === result.original);
  console.log("Entities found:", result.total_detected);
  result.detections.forEach((d) => {
    console.log(`  ${d.type}: start=${d.start}, end=${d.end}, confidence=${d.confidence}`);
  });
}

// ── Example 3: AgentRun — multi-step with shared token scope ──────────────────

async function example3_agentRun() {
  console.log("\n── Example 3: AgentRun ──");

  const run = new AgentRun({
    apiKey: process.env.PRIVARO_API_KEY ?? "prvr_your_key_here",
    pipelineId: process.env.PRIVARO_PIPELINE_ID ?? "your-pipeline-uuid",
  });

  console.log("ConversationId:", run.conversationId);

  // Step 1: protect the user message
  const step1 = await run.protect(
    "Analiza el contrato de Juan Martínez, DNI 45678901C, IBAN ES12 3456 7890 1234 5678 90"
  );
  console.log("\nStep 1 — protected messages:");
  step1.protected_messages.forEach((m) => console.log(`  [${m.role}] ${m.content}`));

  // In production: send step1.protected_messages to your LLM here
  const fakeResponse = "[NM-0001] es un cliente de alto valor con buen historial de pago.";

  // Step 2: reveal — tokens replaced with real values
  const revealed = await run.reveal(fakeResponse);
  console.log("\nLLM response after reveal:", revealed);
  console.log("Total steps:", run.stepCount);
}

// ── Example 4: OpenAI drop-in ─────────────────────────────────────────────────

async function example4_openaiAdapter() {
  console.log("\n── Example 4: OpenAI adapter (pseudo-code) ──");
  console.log(`
// Replace your OpenAI calls with this:
import OpenAI from "openai";
import { wrapOpenAI } from "@privaro/sdk/adapters/openai";
import { PrivaroClient } from "@privaro/sdk";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const privaro = new PrivaroClient({
  apiKey: process.env.PRIVARO_API_KEY,
  pipelineId: process.env.PRIVARO_PIPELINE_ID,
});

const safe = wrapOpenAI(openai, privaro);

// Exactly the same API — PII protected automatically
const response = await safe.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Analiza contrato de María García, DNI 34521789X" }],
});
// response._privaro → { pii_detected: 2, pii_masked: 2, audit_log_id: "..." }
  `);
}

// ── Run all examples ──────────────────────────────────────────────────────────

(async () => {
  try {
    await example1_basicProtect();
    await example2_detectOnly();
    await example3_agentRun();
    await example4_openaiAdapter();
  } catch (err) {
    console.error("Example failed:", err);
    console.log("(Set PRIVARO_API_KEY and PRIVARO_PIPELINE_ID env vars to run live examples)");
  }
})();
