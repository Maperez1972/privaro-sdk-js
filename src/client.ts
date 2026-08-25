import type {
  PrivaroClientOptions,
  ProtectOptions,
  ProtectResult,
  ProtectOutputOptions,
  ProtectOutputResult,
  Detection,
  DocumentChunk,
  ProtectDocumentOptions,
  ProtectDocumentResult,
  RelayMessage,
  RelayOptions,
  RelayResult,
  AgentStep,
} from "./types/index.js";
import {
  PrivaroError,
  AuthError,
  PipelineNotFoundError,
  PolicyBlockError,
  RateLimitError,
  ProxyUnavailableError,
  OutputScanningDisabledError,
} from "./errors.js";
import { randomUUID } from "./utils.js";

const DEFAULT_BASE_URL = "https://api.privaro.ai/v1";

// ─── Internal helpers ─────────────────────────────────────────────────────────

function makeDetection(raw: Record<string, unknown>): Detection {
  return {
    type: raw.type as string,
    severity: raw.severity as Detection["severity"],
    action: raw.action as Detection["action"],
    token: (raw.token as string | null) ?? null,
    confidence: (raw.confidence as number) ?? 1.0,
    detector: ((raw.detector as string | undefined) ?? "regex") as Detection["detector"],
    start: (raw.start as number | null) ?? null,
    end: (raw.end as number | null) ?? null,
    regulation_ref: (raw.regulation_ref as string | null) ?? null,
    get isHighRisk() {
      return this.severity === "critical" || this.severity === "high";
    },
  };
}

function makeProtectResult(
  raw: Record<string, unknown>,
  original: string
): ProtectResult {
  const stats = (raw.stats as Record<string, unknown>) ?? {};
  const detections = ((raw.detections as unknown[]) ?? []).map((d) =>
    makeDetection(d as Record<string, unknown>)
  );

  const total_detected = (stats.total_detected as number) ?? detections.length;
  const total_masked = (stats.total_masked as number) ?? 0;
  const leaked = (stats.leaked as number) ?? 0;
  const coverage_pct = (stats.coverage_pct as number) ?? 100;
  const risk_score = (stats.risk_score as number | null) ?? null;
  const gdpr_compliant = (raw.gdpr_compliant as boolean) ?? true;
  const processing_ms = (stats.processing_ms as number) ?? 0;
  const rawCompressionStats = raw.compression_stats as
    | { tokens_saved?: number; compression_ratio?: number }
    | undefined;
  const compressionStats =
    rawCompressionStats && rawCompressionStats.tokens_saved
      ? {
          tokens_saved: rawCompressionStats.tokens_saved,
          compression_ratio: rawCompressionStats.compression_ratio ?? 0,
        }
      : undefined;

  return {
    protected: (raw.protected_prompt as string) ?? original,
    original,
    request_id: (raw.request_id as string) ?? "",
    audit_log_id: (raw.audit_log_id as string | null) ?? null,
    detections,
    total_detected,
    total_masked,
    leaked,
    coverage_pct,
    risk_score,
    gdpr_compliant,
    processing_ms,
    compressionStats,
    get riskLevel() {
      if (this.risk_score === null) return "unknown";
      if (this.risk_score >= 0.7) return "high";
      if (this.risk_score >= 0.4) return "medium";
      return "low";
    },
    get hasPii() {
      return this.total_detected > 0;
    },
    get isSafe() {
      return this.gdpr_compliant && this.leaked === 0;
    },
    summary() {
      return (
        `[Privaro] ${this.total_detected} detected, ` +
        `${this.total_masked} masked, ` +
        `risk=${this.riskLevel}${this.risk_score !== null ? ` (${this.risk_score.toFixed(2)})` : ""}, ` +
        `gdpr=${this.gdpr_compliant ? "✓" : "✗"}, ` +
        `${this.processing_ms}ms`
      );
    },
  };
}

function makeProtectOutputResult(
  raw: Record<string, unknown>,
  original: string
): ProtectOutputResult {
  const stats = (raw.stats as Record<string, unknown>) ?? {};
  const detections = ((raw.detections as unknown[]) ?? []).map((d) =>
    makeDetection(d as Record<string, unknown>)
  );

  const total_detected = (stats.total_detected as number) ?? detections.length;
  const total_masked = (stats.total_masked as number) ?? 0;
  const leaked = (stats.leaked as number) ?? 0;
  const coverage_pct = (stats.coverage_pct as number) ?? 100;
  const risk_score = (stats.risk_score as number | null) ?? null;
  const gdpr_compliant = (raw.gdpr_compliant as boolean) ?? true;
  const processing_ms = (stats.processing_ms as number) ?? 0;
  const scan_mode = ((raw.scan_mode as string) ?? "shadow") as "shadow" | "enforce";
  const response_modified = (raw.response_modified as boolean) ?? false;

  return {
    protected: (raw.protected_response as string) ?? original,
    original,
    request_id: (raw.request_id as string) ?? "",
    audit_log_id: (raw.audit_log_id as string | null) ?? null,
    detections,
    total_detected,
    total_masked,
    leaked,
    coverage_pct,
    risk_score,
    gdpr_compliant,
    processing_ms,
    scan_mode,
    response_modified,
    get riskLevel() {
      if (this.risk_score === null) return "unknown";
      if (this.risk_score >= 0.7) return "high";
      if (this.risk_score >= 0.4) return "medium";
      return "low";
    },
    get hasPii() {
      return this.total_detected > 0;
    },
    get isSafe() {
      return this.gdpr_compliant && this.leaked === 0;
    },
    summary() {
      return (
        `[Privaro:output] ${this.total_detected} detected, ` +
        `${this.total_masked} masked, mode=${this.scan_mode}, ` +
        `risk=${this.riskLevel}${this.risk_score !== null ? ` (${this.risk_score.toFixed(2)})` : ""}, ` +
        `gdpr=${this.gdpr_compliant ? "✓" : "✗"}, ` +
        `${this.processing_ms}ms`
      );
    },
  };
}

// ─── PrivaroClient ────────────────────────────────────────────────────────────

export class PrivaroClient {
  readonly apiKey: string;
  readonly pipelineId: string;
  readonly baseUrl: string;
  readonly timeout: number;
  readonly defaultMode: ProtectOptions["mode"];

  constructor(opts: PrivaroClientOptions) {
    if (!opts.apiKey || !opts.apiKey.startsWith("prvr_")) {
      throw new AuthError(
        "Invalid API key format. Keys must start with 'prvr_'."
      );
    }
    if (!opts.pipelineId) {
      throw new PrivaroError("pipelineId is required.");
    }

    this.apiKey = opts.apiKey;
    this.pipelineId = opts.pipelineId;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.timeout = opts.timeout ?? 10_000;
    this.defaultMode = opts.defaultMode ?? "tokenise";
  }

  private _headers(idempotencyKey?: string): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Privaro-Key": this.apiKey,
    };
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    return headers;
  }

  private async _request<T = Record<string, unknown>>(
    method: string,
    path: string,
    body?: unknown,
    idempotencyKey?: string
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: this._headers(idempotencyKey),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      } as RequestInit);
    } catch (err) {
      clearTimeout(timer);
      if ((err as Error).name === "AbortError") {
        throw new ProxyUnavailableError(
          this.baseUrl,
          new Error(`Request timed out after ${this.timeout}ms`)
        );
      }
      throw new ProxyUnavailableError(this.baseUrl, err);
    } finally {
      clearTimeout(timer);
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      json = {};
    }

    if (!response.ok) {
      const detail =
        (json as Record<string, unknown>)?.detail ?? json ?? {};

      switch (response.status) {
        case 401:
          throw new AuthError();
        case 403: {
          const err403 = (detail as Record<string, unknown>)?.error;
          if (err403 === "output_scanning_disabled") {
            throw new OutputScanningDisabledError(
              ((detail as Record<string, unknown>)?.message as string) ?? undefined
            );
          }
          throw new AuthError();
        }
        case 404:
          throw new PipelineNotFoundError(this.pipelineId);
        case 429:
          throw new RateLimitError();
        case 500: {
          const err = (detail as Record<string, unknown>)?.error;
          if (err === "request_blocked") {
            throw new PolicyBlockError("Request blocked by privacy policy.");
          }
          throw new PrivaroError(`Proxy error: ${JSON.stringify(detail)}`);
        }
        default:
          throw new PrivaroError(
            `HTTP ${response.status}: ${JSON.stringify(detail)}`
          );
      }
    }

    return json as T;
  }

  // ── protect ──────────────────────────────────────────────────────────────────

  /**
   * Detect and tokenise PII in a prompt.
   * Writes an audit log entry + iBS blockchain certification.
   *
   * @example
   * const result = await client.protect("Patient María García, DNI 34521789X");
   * // result.protected → "Patient [NM-0001], DNI [ID-0001]"
   * const response = await openai.chat.completions.create({
   *   messages: [{ role: "user", content: result.protected }],
   * });
   */
  async protect(prompt: string, opts: ProtectOptions = {}): Promise<ProtectResult> {
    if (!prompt?.trim()) {
      return makeProtectResult(
        { protected_prompt: "", detections: [], gdpr_compliant: true, request_id: "" },
        prompt ?? ""
      );
    }

    const raw = await this._request<Record<string, unknown>>(
      "POST",
      "/proxy/protect",
      {
        pipeline_id: this.pipelineId,
        prompt,
        options: {
          mode: opts.mode ?? this.defaultMode,
          reversible: opts.reversible ?? true,
          agent_mode: opts.agentMode ?? false,
          include_detections: opts.includeDetections ?? true,
          optimize_context: opts.optimizeContext ?? false,
        },
        ...(opts.conversationId
          ? { conversation_id: opts.conversationId }
          : {}),
      },
      opts.idempotencyKey
    );

    return makeProtectResult(raw, prompt);
  }

  // ── detect ───────────────────────────────────────────────────────────────────

  /**
   * Analyse a prompt for PII without masking or writing an audit log.
   * Use for analysis/reporting — no state written.
   */
  async detect(prompt: string): Promise<ProtectResult> {
    if (!prompt?.trim()) {
      return makeProtectResult(
        { protected_prompt: prompt, detections: [], gdpr_compliant: true, request_id: "" },
        prompt ?? ""
      );
    }

    const raw = await this._request<Record<string, unknown>>(
      "POST",
      "/proxy/detect",
      { pipeline_id: this.pipelineId, prompt }
    );

    const result = makeProtectResult(
      { ...raw, protected_prompt: prompt, gdpr_compliant: true },
      prompt
    );
    result.protected = prompt; // detect never masks
    return result;
  }

  // ── protectOutput ────────────────────────────────────────────────────────────

  /**
   * Scan and mask PII in an LLM RESPONSE (output direction), for callers
   * who use protect() and then hit their own LLM directly — as opposed
   * to relay()/relayStream(), where Privaro makes the LLM call itself
   * and already scans the response inline.
   *
   * Requires the pipeline to have output-direction scanning enabled
   * (dashboard: Pipelines → Settings → Output scanning). Throws
   * OutputScanningDisabledError otherwise — this call never silently
   * passes text through unscanned.
   *
   * @example
   * const out = await client.protectOutput(llmResponseText, {
   *   conversationId, // same id used for the matching protect() call
   * });
   * return out.protected; // send this to your end user
   */
  async protectOutput(
    responseText: string,
    opts: ProtectOutputOptions = {}
  ): Promise<ProtectOutputResult> {
    if (!responseText?.trim()) {
      return makeProtectOutputResult(
        { protected_response: "", detections: [], gdpr_compliant: true, request_id: "" },
        responseText ?? ""
      );
    }

    const raw = await this._request<Record<string, unknown>>(
      "POST",
      "/proxy/protect-output",
      {
        pipeline_id: this.pipelineId,
        response_text: responseText,
        options: {
          mode: opts.mode ?? this.defaultMode,
          reversible: opts.reversible ?? true,
          agent_mode: opts.agentMode ?? false,
          include_detections: opts.includeDetections ?? true,
        },
        ...(opts.conversationId
          ? { conversation_id: opts.conversationId }
          : {}),
      },
      opts.idempotencyKey
    );

    return makeProtectOutputResult(raw, responseText);
  }

  // ── protectDocument ──────────────────────────────────────────────────────────

  /**
   * Protect a WHOLE document before ingesting it into a vector store
   * for RAG (Privaro Ingest — Fase 1 of the RAG expansion plan), rather
   * than a single chat prompt. Chunking happens server-side, AFTER
   * tokenisation — chunk boundaries never split a Privaro token
   * ([XX-0001]) across two chunks.
   *
   * Large documents may be processed asynchronously server-side
   * (returns { status: "processing", job_id }); this method polls
   * GET /proxy/protect-document/{jobId} transparently until the result
   * is ready, so callers always get back a single, finished result —
   * never a partial/in-progress state.
   *
   * @throws PrivaroError if the job fails server-side, or if
   *   pollTimeoutMs is exceeded (the job keeps running server-side
   *   regardless — poll GET /proxy/protect-document/{jobId} directly
   *   yourself if you need to resume watching it after a timeout).
   *
   * @example
   * const result = await client.protectDocument(pdfText, { chunkSize: 512 });
   * for (const chunk of result.chunks) {
   *   await vectorStore.upsert(chunk.text, { chunkIndex: chunk.index });
   * }
   */
  async protectDocument(
    document: string,
    opts: ProtectDocumentOptions = {}
  ): Promise<ProtectDocumentResult> {
    const pollIntervalMs = opts.pollIntervalMs ?? 2000;
    const pollTimeoutMs = opts.pollTimeoutMs ?? 300_000;

    let raw = await this._request<Record<string, unknown>>(
      "POST",
      "/proxy/protect-document",
      {
        pipeline_id: this.pipelineId,
        document,
        document_id: opts.documentId,
        options: {
          mode: opts.mode ?? this.defaultMode,
          reversible: opts.reversible ?? true,
          use_nlp: opts.useNlp ?? true,
          chunk_size: opts.chunkSize ?? 512,
        },
      }
    );

    if (raw.status === "processing" && raw.job_id) {
      const jobId = raw.job_id as string;
      const deadline = Date.now() + pollTimeoutMs;
      while (true) {
        if (Date.now() >= deadline) {
          throw new PrivaroError(
            `protectDocument job ${jobId} did not complete within ${pollTimeoutMs}ms — ` +
              `it may still finish server-side; increase pollTimeoutMs or check ` +
              `GET /proxy/protect-document/${jobId} directly.`
          );
        }
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        raw = await this._request<Record<string, unknown>>(
          "GET",
          `/proxy/protect-document/${jobId}`
        );
        if (raw.status !== "processing") break;
      }
    }

    if (raw.status === "failed") {
      throw new PrivaroError(
        `protectDocument failed: ${raw.degraded_reason ?? "unknown error"}`
      );
    }

    const chunks = (raw.chunks as DocumentChunk[] | undefined) ?? [];
    const detections = (raw.detections as Detection[] | undefined) ?? [];
    const stats = (raw.stats as Record<string, number> | undefined) ?? {};

    return {
      request_id: (raw.request_id as string) ?? "",
      protected_document: (raw.protected_document as string) ?? "",
      chunks,
      detections,
      stats,
      job_id: raw.job_id as string | undefined,
      get chunkCount() {
        return chunks.length;
      },
      summary() {
        return (
          `[Privaro:ingest] ${stats.total_detected ?? 0} entities detected, ` +
          `${chunks.length} chunks, ${stats.char_count ?? 0} chars, ` +
          `${stats.processing_ms ?? 0}ms`
        );
      },
    };
  }

  // ── relay ────────────────────────────────────────────────────────────────────

  /**
   * Full-cycle privacy relay.
   * Protect messages → route to configured LLM → de-tokenise response.
   * Requires LLM provider key configured in /app/admin/providers.
   *
   * @example
   * const result = await client.relay([
   *   { role: "user", content: "Analiza este contrato de María García..." }
   * ]);
   * // result.response → LLM reply with tokens replaced by real values
   */
  async relay(
    messages: RelayMessage[],
    opts: RelayOptions = {}
  ): Promise<RelayResult> {
    const raw = await this._request<Record<string, unknown>>(
      "POST",
      "/relay/complete",
      {
        pipeline_id: this.pipelineId,
        messages,
        options: {
          mode: opts.mode ?? this.defaultMode,
          detokenise_response: opts.detokeniseResponse ?? true,
          include_detections: opts.includeDetections ?? true,
          max_tokens: opts.maxTokens ?? 2048,
          temperature: opts.temperature ?? 0.7,
          optimize_context: opts.optimizeContext ?? false,
          ...(opts.systemPrompt ? { system_prompt: opts.systemPrompt } : {}),
        },
        ...(opts.conversationId ? { conversation_id: opts.conversationId } : {}),
      },
      opts.idempotencyKey
    );

    return raw as unknown as RelayResult;
  }

  // ── relayStream ─────────────────────────────────────────────────────────────

  /**
   * Full-cycle privacy relay, streamed as the LLM generates it.
   * Protect messages → route to configured LLM → yield de-tokenised text
   * deltas as they arrive (Server-Sent Events under the hood).
   *
   * Note: Idempotency-Key is not supported here (replaying a completed
   * stream doesn't have the same "just resend the result" semantics as a
   * short synchronous response) — use relay() if you need idempotent retries.
   *
   * @example
   * for await (const delta of client.relayStream(messages)) {
   *   process.stdout.write(delta); // already de-tokenised, safe to show
   * }
   */
  async *relayStream(
    messages: RelayMessage[],
    opts: RelayOptions = {}
  ): AsyncGenerator<string, void, unknown> {
    const url = `${this.baseUrl}/relay/stream`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: this._headers(),
        body: JSON.stringify({
          pipeline_id: this.pipelineId,
          messages,
          options: {
            mode: opts.mode ?? this.defaultMode,
            detokenise_response: opts.detokeniseResponse ?? true,
            include_detections: opts.includeDetections ?? true,
            max_tokens: opts.maxTokens ?? 2048,
            temperature: opts.temperature ?? 0.7,
            ...(opts.systemPrompt ? { system_prompt: opts.systemPrompt } : {}),
          },
          ...(opts.conversationId ? { conversation_id: opts.conversationId } : {}),
        }),
        signal: controller.signal,
      } as RequestInit);
    } catch (err) {
      clearTimeout(timer);
      if ((err as Error).name === "AbortError") {
        throw new ProxyUnavailableError(
          this.baseUrl,
          new Error(`Request timed out after ${this.timeout}ms`)
        );
      }
      throw new ProxyUnavailableError(this.baseUrl, err);
    }
    clearTimeout(timer);

    if (!response.ok || !response.body) {
      let detail: unknown = {};
      try {
        detail = await response.json();
      } catch {
        /* ignore */
      }
      switch (response.status) {
        case 401:
        case 403:
          throw new AuthError();
        case 404:
          throw new PipelineNotFoundError(this.pipelineId);
        case 429:
          throw new RateLimitError();
        default:
          throw new PrivaroError(
            `HTTP ${response.status}: ${JSON.stringify(detail)}`
          );
      }
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const raw = trimmed.slice(5).trim();
          if (!raw || raw === "[DONE]") continue;

          let event: Record<string, unknown>;
          try {
            event = JSON.parse(raw);
          } catch {
            continue; // skip malformed SSE line
          }

          if (event.error) {
            throw new PrivaroError(
              `LLM provider error: ${event.error}`,
              event
            );
          }
          if (typeof event.delta === "string" && event.delta) {
            yield event.delta;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  // ── health ───────────────────────────────────────────────────────────────────

  async health(): Promise<Record<string, unknown>> {
    return this._request<Record<string, unknown>>("GET", "/health");
  }

  toString() {
    return `PrivaroClient(pipeline=${this.pipelineId.slice(0, 8)}…, url=${this.baseUrl})`;
  }
}

// ─── AgentRun ─────────────────────────────────────────────────────────────────

/**
 * Multi-step agent session with shared token scope.
 * All steps within the same run share a conversationId so tokens are
 * consistent across turns — [NM-0001] always refers to the same person.
 *
 * @example
 * const run = new AgentRun({ apiKey: "prvr_xxx", pipelineId: "uuid" });
 * const step = await run.protect("Review contract for Juan García");
 * const response = await openai.chat.completions.create({
 *   messages: step.protected_messages,
 * });
 * const final = await run.reveal(response.choices[0].message.content);
 */
export class AgentRun {
  private readonly client: PrivaroClient;
  readonly conversationId: string;
  private _steps: AgentStep[] = [];

  constructor(opts: PrivaroClientOptions) {
    this.client = new PrivaroClient(opts);
    this.conversationId = randomUUID();
  }

  /** Protect a prompt, returning tokenised messages ready for your LLM */
  async protect(
    content: string,
    role: RelayMessage["role"] = "user",
    optimizeContext = false
  ): Promise<AgentStep> {
    const result = await this.client.protect(content, {
      agentMode: true,
      conversationId: this.conversationId,
      optimizeContext,
    });

    const step: AgentStep = {
      protected_messages: [{ role, content: result.protected }],
      first_content: result.protected,
      detections: result.detections,
      step_id: result.request_id,
      compressionStats: result.compressionStats,
    };

    this._steps.push(step);
    return step;
  }

  /**
   * De-tokenise LLM response — replaces [NM-0001] etc. with original values.
   * Uses /v1/agent/reveal on the proxy (token vault lookup).
   */
  async reveal(llmResponse: string): Promise<string> {
    const raw = await this.client["_request"]<Record<string, unknown>>(
      "POST",
      "/agent/reveal",
      {
        pipeline_id: this.client.pipelineId,
        conversation_id: this.conversationId,
        text: llmResponse,
      }
    );
    return (raw.revealed as string) ?? llmResponse;
  }

  get steps(): readonly AgentStep[] {
    return this._steps;
  }

  get stepCount(): number {
    return this._steps.length;
  }
}
