/**
 * Privaro × OpenAI adapter
 *
 * Drop-in wrapper: replace your openai.chat.completions.create() call
 * with privaroOpenAI.chat.completions.create() — PII is automatically
 * protected before sending to OpenAI and de-tokenised in the response.
 *
 * @example
 * import OpenAI from "openai";
 * import { wrapOpenAI } from "@privaro/sdk/adapters/openai";
 * import { PrivaroClient } from "@privaro/sdk";
 *
 * const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
 * const privaro = new PrivaroClient({
 *   apiKey: process.env.PRIVARO_API_KEY!,
 *   pipelineId: process.env.PRIVARO_PIPELINE_ID!,
 * });
 *
 * const safe = wrapOpenAI(openai, privaro);
 *
 * // Exactly the same call — PII protected automatically
 * const response = await safe.chat.completions.create({
 *   model: "gpt-4o",
 *   messages: [{ role: "user", content: "Analyse contract for María García, DNI 34521789X" }],
 * });
 * // response.choices[0].message.content → real values restored
 */

import type { PrivaroClient } from "../client.js";
import type { ProtectOptions } from "../types/index.js";

// Minimal OpenAI types (avoids hard dependency — works with any openai version)
interface ChatMessage {
  role: string;
  content: string | null;
}

interface ChatCompletionParams {
  messages: ChatMessage[];
  [key: string]: unknown;
}

interface ChatCompletion {
  choices: Array<{ message: ChatMessage; [key: string]: unknown }>;
  _privaro?: {
    pii_detected: number;
    pii_masked: number;
    processing_ms: number;
    audit_log_id: string | null;
  };
  [key: string]: unknown;
}

interface OpenAIClient {
  chat: {
    completions: {
      create(params: ChatCompletionParams): Promise<ChatCompletion>;
    };
  };
}

/**
 * Wrap an OpenAI client instance with Privaro privacy protection.
 * All chat.completions.create() calls are intercepted — user messages
 * are tokenised before sending; assistant responses are de-tokenised.
 */
export function wrapOpenAI(
  openai: OpenAIClient,
  privaro: PrivaroClient,
  opts: ProtectOptions & { deTokeniseResponse?: boolean } = {}
): OpenAIClient {
  const deTokenise = opts.deTokeniseResponse ?? true;
  const conversationId = opts.conversationId ?? crypto.randomUUID();

  return {
    chat: {
      completions: {
        async create(params: ChatCompletionParams): Promise<ChatCompletion> {
          const t0 = Date.now();

          // Protect all user/system messages — collect results for metadata
          let totalDetected = 0;
          let totalMasked = 0;
          let lastAuditLogId: string | null = null;

          const protectedMessages = await Promise.all(
            params.messages.map(async (msg) => {
              if (
                (msg.role === "user" || msg.role === "system") &&
                typeof msg.content === "string" &&
                msg.content.trim()
              ) {
                const result = await privaro.protect(msg.content, {
                  ...opts,
                  agentMode: true,
                  conversationId,
                });
                totalDetected += result.total_detected;
                totalMasked += result.total_masked;
                lastAuditLogId = result.audit_log_id ?? lastAuditLogId;
                return { ...msg, content: result.protected };
              }
              return msg;
            })
          );

          // Call OpenAI with protected messages
          const response = await openai.chat.completions.create({
            ...params,
            messages: protectedMessages,
          });

          // De-tokenise assistant response if needed
          if (deTokenise && response.choices?.[0]?.message?.content) {
            try {
              const raw = response.choices[0].message.content;
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const _req = (privaro as any)._request.bind(privaro) as (m: string, p: string, b: unknown) => Promise<Record<string, unknown>>;
              const revealed = await _req(
                "POST",
                "/agent/reveal",
                {
                  pipeline_id: privaro.pipelineId,
                  conversation_id: conversationId,
                  text: raw,
                }
              );
              response.choices[0].message.content =
                (revealed.revealed as string) ?? raw;
            } catch {
              // De-tokenisation failure is non-fatal — return tokens as-is
            }
          }

          // Attach Privaro metadata to response
          response._privaro = {
            pii_detected: totalDetected,
            pii_masked: totalMasked,
            processing_ms: Date.now() - t0,
            audit_log_id: lastAuditLogId,
          };

          return response;
        },
      },
    },
  };
}
