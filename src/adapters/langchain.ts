/**
 * Privaro × LangChain adapter
 *
 * PrivaroCallbackHandler intercepts LLM calls via LangChain callbacks.
 * Attach it to any LangChain chain or LLM — PII is protected before
 * each LLM call and de-tokenised in the output.
 *
 * @example
 * import { ChatOpenAI } from "@langchain/openai";
 * import { PrivaroClient } from "@privaro/sdk";
 * import { PrivaroCallbackHandler } from "@privaro/sdk/adapters/langchain";
 *
 * const privaro = new PrivaroClient({
 *   apiKey: process.env.PRIVARO_API_KEY!,
 *   pipelineId: process.env.PRIVARO_PIPELINE_ID!,
 * });
 *
 * const handler = new PrivaroCallbackHandler(privaro);
 *
 * const llm = new ChatOpenAI({
 *   modelName: "gpt-4o",
 *   callbacks: [handler],
 * });
 *
 * // PII in messages is automatically tokenised before hitting OpenAI
 * const response = await llm.invoke("Analiza contrato de María García, DNI 34521789X");
 */

import type { PrivaroClient } from "../client.js";
import type { Detection } from "../types/index.js";
import { randomUUID } from "../utils.js";

/** Token map for a single LangChain chain run */
interface RunContext {
  conversationId: string;
  piiDetected: number;
  detections: Detection[];
}

export class PrivaroCallbackHandler {
  readonly name = "PrivaroCallbackHandler";
  private readonly privaro: PrivaroClient;
  private readonly runs = new Map<string, RunContext>();

  constructor(privaro: PrivaroClient) {
    this.privaro = privaro;
  }

  /** Called before an LLM receives messages — tokenise user content */
  async handleLLMStart(
    _llm: Record<string, unknown>,
    prompts: string[],
    runId: string
  ): Promise<void> {
    const conversationId = randomUUID();
    let totalDetected = 0;
    const allDetections: Detection[] = [];

    const protected_prompts = await Promise.all(
      prompts.map(async (p) => {
        const result = await this.privaro.protect(p, {
          agentMode: true,
          conversationId,
        });
        totalDetected += result.total_detected;
        allDetections.push(...result.detections);
        return result.protected;
      })
    );

    this.runs.set(runId, {
      conversationId,
      piiDetected: totalDetected,
      detections: allDetections,
    });

    // Mutate prompts in-place — LangChain passes the array by reference
    protected_prompts.forEach((p, i) => { prompts[i] = p; });
  }

  /** Called with the LLM response — de-tokenise if tokens present */
  async handleLLMEnd(
    output: { generations: Array<Array<{ text: string }>> },
    runId: string
  ): Promise<void> {
    const ctx = this.runs.get(runId);
    if (!ctx) return;

    for (const generation_list of output.generations) {
      for (const generation of generation_list) {
        if (generation.text && ctx.piiDetected > 0) {
          try {
            const revealed = await this.privaro["_request"]<Record<string, unknown>>(
              "POST",
              "/agent/reveal",
              {
                pipeline_id: this.privaro.pipelineId,
                conversation_id: ctx.conversationId,
                text: generation.text,
              }
            );
            generation.text = (revealed.revealed as string) ?? generation.text;
          } catch {
            // Non-fatal — return original
          }
        }
      }
    }

    this.runs.delete(runId);
  }

  handleLLMError(_err: Error, runId: string): void {
    this.runs.delete(runId);
  }
}
