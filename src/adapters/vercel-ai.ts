/**
 * Privaro × Vercel AI SDK adapter
 *
 * privaroMiddleware wraps any Vercel AI SDK model with PII protection.
 * Compatible with streamText, generateText, and useChat.
 *
 * @example
 * import { openai } from "@ai-sdk/openai";
 * import { generateText } from "ai";
 * import { PrivaroClient } from "@privaro/sdk";
 * import { privaroMiddleware } from "@privaro/sdk/adapters/vercel-ai";
 *
 * const privaro = new PrivaroClient({
 *   apiKey: process.env.PRIVARO_API_KEY!,
 *   pipelineId: process.env.PRIVARO_PIPELINE_ID!,
 * });
 *
 * const { text } = await generateText({
 *   model: openai("gpt-4o"),
 *   prompt: "Analiza contrato de María García, DNI 34521789X",
 *   experimental_transform: privaroMiddleware(privaro),
 * });
 */

import type { PrivaroClient } from "../client.js";
import type { ProtectOptions } from "../types/index.js";
import { randomUUID } from "../utils.js";

interface VercelAIMessage {
  role: string;
  content: string | Array<{ type: string; text?: string }>;
}

interface VercelParams {
  prompt?: VercelAIMessage[];
  messages?: VercelAIMessage[];
  [key: string]: unknown;
}

interface LanguageModelMiddleware {
  transformParams?: (options: {
    params: VercelParams;
  }) => Promise<{ params: VercelParams }>;
  wrapGenerate?: (options: {
    doGenerate: () => Promise<{ text?: string; [key: string]: unknown }>;
  }) => Promise<{ text?: string; [key: string]: unknown }>;
}

/**
 * Create a Vercel AI SDK middleware that protects PII in prompts
 * and de-tokenises LLM responses.
 */
export function privaroMiddleware(
  privaro: PrivaroClient,
  opts: ProtectOptions & { deTokeniseResponse?: boolean } = {}
): LanguageModelMiddleware {
  const deTokenise = opts.deTokeniseResponse ?? true;
  let conversationId = randomUUID();
  let lastConversationId = conversationId;

  return {
    async transformParams({ params }) {
      conversationId = randomUUID();
      lastConversationId = conversationId;

      const messages: VercelAIMessage[] = params.messages ?? params.prompt ?? [];

      const protected_messages = await Promise.all(
        messages.map(async (msg: VercelAIMessage) => {
          if (msg.role !== "user" && msg.role !== "system") return msg;

          const text =
            typeof msg.content === "string"
              ? msg.content
              : (msg.content as Array<{ type: string; text?: string }>)
                  .filter((c) => c.type === "text")
                  .map((c) => c.text ?? "")
                  .join("\n");

          if (!text.trim()) return msg;

          const result = await privaro.protect(text, {
            ...opts,
            agentMode: true,
            conversationId,
          });

          return {
            ...msg,
            content:
              typeof msg.content === "string"
                ? result.protected
                : (msg.content as Array<{ type: string; text?: string }>).map((c) =>
                    c.type === "text" ? { ...c, text: result.protected } : c
                  ),
          };
        })
      );

      if (params.messages) {
        return { params: { ...params, messages: protected_messages } };
      }
      return { params: { ...params, prompt: protected_messages } };
    },

    async wrapGenerate({ doGenerate }) {
      const result = await doGenerate();

      if (deTokenise && typeof result.text === "string") {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const req = (privaro as any)._request.bind(privaro) as (m: string, p: string, b: unknown) => Promise<Record<string, unknown>>;
          const revealed = await req("POST", "/agent/reveal", {
            pipeline_id: privaro.pipelineId,
            conversation_id: lastConversationId,
            text: result.text,
          });
          result.text = (revealed.revealed as string) ?? result.text;
        } catch {
          // Non-fatal — return original response
        }
      }

      return result;
    },
  };
}
