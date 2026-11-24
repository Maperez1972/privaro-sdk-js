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

import { RunnableLambda } from "@langchain/core/runnables";
import { Document } from "@langchain/core/documents";
import type { PrivaroClient } from "../client.js";
import type { Detection } from "../types/index.js";
import { randomUUID } from "../utils.js";

/** Token map for a single LangChain chain run */
interface RunContext {
  conversationId: string;
  piiDetected: number;
  detections: Detection[];
}

/**
 * @deprecated Callbacks cannot rewrite what a model receives (verified against
 * @langchain/core: plain LLMs ignore in-place prompt edits and this handler does not
 * implement handleChatModelStart), so it does NOT protect ChatOpenAI & co.
 * Use `privaroGuard` / `privaroMask` + `privaroUnmask` below.
 */
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


// ── Runnable-based adapters (recommended) ─────────────────────────────────────
/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * mask -> chain -> unmask, one conversation shared by both ends:
 *   const chain = privaroGuard(prompt.pipe(llm).pipe(new StringOutputParser()), privaro);
 */
export function privaroGuard(chain: any, privaro: PrivaroClient, conversationId: string = randomUUID()): any {
  return privaroMask(privaro, conversationId).pipe(chain).pipe(privaroUnmask(privaro, conversationId));
}

async function maskValue(privaro: PrivaroClient, cid: string, v: any): Promise<any> {
  if (typeof v === "string") return v.trim() ? (await privaro.protect(v, { conversationId: cid, includeDetections: false })).protected : v;
  if (Array.isArray(v)) return Promise.all(v.map((x) => maskValue(privaro, cid, x)));
  if (v && typeof v === "object" && typeof v.content === "string" && v.lc_namespace) {
    const clone = Object.assign(Object.create(Object.getPrototypeOf(v)), v);
    clone.content = await maskValue(privaro, cid, v.content);
    return clone;
  }
  if (v && typeof v === "object" && typeof v.toChatMessages === "function")
    return maskValue(privaro, cid, v.toChatMessages());
  if (v && typeof v === "object" && v.constructor === Object)
    return Object.fromEntries(await Promise.all(Object.entries(v).map(async ([k, x]) => [k, await maskValue(privaro, cid, x)])));
  return v;
}

export function privaroMask(privaro: PrivaroClient, conversationId: string = randomUUID()): any {
  return RunnableLambda.from((v: any) => maskValue(privaro, conversationId, v));
}

export function privaroUnmask(privaro: PrivaroClient, conversationId: string): any {
  return RunnableLambda.from(async (v: any) => {
    if (typeof v === "string") return privaro.detokenize(v, { conversationId });
    if (v && typeof v.content === "string") {
      const c = Object.assign(Object.create(Object.getPrototypeOf(v)), v);
      c.content = await privaro.detokenize(v.content, { conversationId });
      return c;
    }
    return v;
  });
}

/** Wrap any retriever: retrieved chunks are masked (and `allowed_roles` metadata enforced) before reaching the LLM. */
export function privaroRetriever(base: { invoke(q: string): Promise<any[]> }, privaro: PrivaroClient, role = "developer"): any {
  return RunnableLambda.from(async (query: string) => {
    const docs = await base.invoke(query);
    const res = await privaro.protectRetrieval(
      docs.map((d, i) => ({ id: String(i), text: d.pageContent, allowedRoles: d.metadata?.allowed_roles ?? undefined })),
      { requesterRole: role }
    );
    const by = new Map(res.allowed_chunks.map((c) => [c.id, c.protected_text]));
    return docs.flatMap((d, i) =>
      by.has(String(i)) ? [new Document({ pageContent: by.get(String(i))!, metadata: { ...d.metadata, privaro_masked: true } })] : []
    );
  });
}
