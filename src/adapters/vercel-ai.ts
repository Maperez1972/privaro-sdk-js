/**
 * Privaro × Vercel AI SDK adapter (ai >= 4; LanguageModel middleware).
 *
 * The LLM only ever sees tokens ([NM-0001]); your app gets the real values back,
 * for generateText, streamText and generateObject.
 *
 * @example
 * import { openai } from "@ai-sdk/openai";
 * import { generateText, wrapLanguageModel } from "ai";
 * import { PrivaroClient } from "privaro-sdk";
 * import { privaroMiddleware } from "privaro-sdk/adapters/vercel-ai";
 *
 * const privaro = new PrivaroClient({ apiKey: process.env.PRIVARO_API_KEY!, pipelineId: process.env.PRIVARO_PIPELINE_ID! });
 * const model = wrapLanguageModel({ model: openai("gpt-4o"), middleware: privaroMiddleware(privaro) });
 * const { text } = await generateText({ model, prompt: "Analiza el contrato de María García, DNI 34521789X" });
 *
 * NOTE: the previous `experimental_transform: privaroMiddleware(...)` usage never
 * applied masking; use wrapLanguageModel as above.
 */

import type { PrivaroClient } from "../client.js";
import type { ProtectOptions } from "../types/index.js";
import { randomUUID } from "../utils.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyRec = Record<string, any>;

export interface PrivaroMiddlewareOptions extends ProtectOptions {
  /** Reveal tokens in the response (default true). */
  deTokeniseResponse?: boolean;
  /** Scope for tokens. Default: one random id per middleware instance, so the same value keeps the same token across turns. */
  conversationId?: string;
}

/** Longest prefix of `buf` that cannot end inside a [XX-0001] token. */
export function safeFlushPoint(buf: string): number {
  const i = buf.lastIndexOf("[");
  if (i === -1 || buf.indexOf("]", i) !== -1) return buf.length;
  return buf.length - i > 16 ? buf.length : i; // an open bracket older than 16 chars is not a token
}

export function privaroMiddleware(privaro: PrivaroClient, opts: PrivaroMiddlewareOptions = {}) {
  const reveal = opts.deTokeniseResponse ?? true;
  const conversationId = opts.conversationId ?? randomUUID();
  const { deTokeniseResponse: _d, conversationId: _c, ...protectOpts } = opts;
  void _d; void _c;

  const mask = async (text: string): Promise<string> =>
    text?.trim() ? (await privaro.protect(text, { ...protectOpts, conversationId, includeDetections: false })).protected : text;
  const unmask = (text: string): Promise<string> => privaro.detokenize(text, { conversationId });

  async function maskPrompt(prompt: AnyRec[] | undefined): Promise<AnyRec[] | undefined> {
    if (!prompt) return prompt;
    return Promise.all(
      prompt.map(async (m) => {
        if (typeof m.content === "string") return { ...m, content: await mask(m.content) };
        if (Array.isArray(m.content))
          return {
            ...m,
            content: await Promise.all(
              m.content.map(async (p: AnyRec) =>
                p?.type === "text" ? { ...p, text: await mask(p.text) }
                : p?.type === "tool-result" && typeof p.output?.value === "string" ? { ...p, output: { ...p.output, value: await mask(p.output.value) } }
                : p
              )
            ),
          };
        return m;
      })
    );
  }

  return {
    transformParams: async ({ params }: { params: AnyRec }) => {
      const out: AnyRec = { ...params };
      if (params.prompt) out.prompt = await maskPrompt(params.prompt);
      if (params.messages) out.messages = await maskPrompt(params.messages);
      return out;
    },

    wrapGenerate: async ({ doGenerate }: { doGenerate: () => Promise<AnyRec> }) => {
      const res = await doGenerate();
      if (!reveal) return res;
      if (typeof res.text === "string") res.text = await unmask(res.text); // ai v4
      if (Array.isArray(res.content))                                      // ai v5+
        res.content = await Promise.all(res.content.map(async (p: AnyRec) => (p?.type === "text" ? { ...p, text: await unmask(p.text) } : p)));
      return res;
    },

    wrapStream: async ({ doStream }: { doStream: () => Promise<AnyRec> }) => {
      const { stream, ...rest } = await doStream();
      if (!reveal) return { stream, ...rest };
      const bufs = new Map<string, string>(); // text-part id -> pending text
      const field = (c: AnyRec) => (c.delta !== undefined ? "delta" : "textDelta");
      const emit = async (ctrl: TransformStreamDefaultController, c: AnyRec, text: string) => {
        if (text) ctrl.enqueue({ ...c, [field(c)]: await unmask(text) });
      };
      const flushAll = async (ctrl: TransformStreamDefaultController) => {
        for (const [id, b] of bufs) if (b) { await emit(ctrl, { type: "text-delta", id, delta: "" }, b); bufs.set(id, ""); }
      };
      const ts = new TransformStream({
        async transform(c: AnyRec, ctrl) {
          if (c.type === "text-delta") {
            const id = c.id ?? "_";
            const buf = (bufs.get(id) ?? "") + (c.delta ?? c.textDelta ?? "");
            const k = safeFlushPoint(buf);
            bufs.set(id, buf.slice(k));
            await emit(ctrl, c, buf.slice(0, k));
          } else if (c.type === "text-end" || c.type === "finish") {
            await flushAll(ctrl);
            ctrl.enqueue(c);
          } else ctrl.enqueue(c);
        },
        async flush(ctrl) { await flushAll(ctrl); },
      });
      return { stream: (stream as ReadableStream).pipeThrough(ts), ...rest };
    },
  };
}
