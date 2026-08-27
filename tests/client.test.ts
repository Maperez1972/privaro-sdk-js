import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { PrivaroClient, AgentRun } from "../src/client.js";
import {
  AuthError,
  PipelineNotFoundError,
  PrivaroError,
  OutputScanningDisabledError,
} from "../src/errors.js";
import { randomUUID } from "../src/utils.js";

// ─── Mock fetch ───────────────────────────────────────────────────────────────

const mockFetch = jest.fn() as jest.MockedFunction<typeof fetch>;
global.fetch = mockFetch;

function mockSuccess(body: unknown, status = 200) {
  mockFetch.mockResolvedValueOnce({
    ok: status < 400,
    status,
    json: async () => body,
  } as Response);
}

function mockHttpError(status: number, body: unknown = {}) {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status,
    json: async () => body,
  } as Response);
}

/**
 * Simulates an SSE response body, split across arbitrary chunk boundaries
 * (to exercise the buffer-across-chunks logic in relayStream()).
 *
 * Deliberately does NOT use the native ReadableStream class. Node's Web
 * Streams are only stable globals from Node 20 onward (present but
 * "experimental" in 18/19 — see https://nodejs.org/api/webstreams.html),
 * and this SDK needs to test cleanly across the Node matrix this repo's
 * CI actually runs (18/20/22). relayStream() only ever calls
 * response.body.getReader() and then reader.read()/releaseLock() — so a
 * plain object implementing exactly that minimal interface is both
 * simpler and fully version-independent.
 */
function mockSseStream(rawChunks: string[]) {
  const encoder = new TextEncoder();
  let i = 0;
  const reader = {
    async read(): Promise<{ done: boolean; value?: Uint8Array }> {
      if (i >= rawChunks.length) return { done: true };
      const value = encoder.encode(rawChunks[i]);
      i++;
      return { done: false, value };
    },
    releaseLock() {},
  };
  const body = { getReader: () => reader };
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    body,
    json: async () => ({}),
  } as unknown as Response);
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const VALID_OPTS = {
  apiKey: "prvr_test_key_12345",
  pipelineId: "550e8400-e29b-41d4-a716-446655440000",
};

const PROTECT_RESPONSE = {
  request_id: "req_abc12345",
  protected_prompt: "Patient [NM-0001], DNI [ID-0001]",
  detections: [
    {
      type: "full_name", severity: "medium", action: "tokenised",
      token: "[NM-0001]", confidence: 0.8, detector: "regex", start: 8, end: 20,
    },
    {
      type: "dni", severity: "critical", action: "tokenised",
      token: "[ID-0001]", confidence: 0.95, detector: "regex", start: 22, end: 32,
    },
  ],
  stats: {
    total_detected: 2, total_masked: 2, leaked: 0,
    coverage_pct: 100, processing_ms: 42,
  },
  audit_log_id: "uuid-audit-001",
  gdpr_compliant: true,
};

// ─── PrivaroClient constructor ────────────────────────────────────────────────

describe("PrivaroClient constructor", () => {
  it("throws AuthError for invalid API key format", () => {
    expect(() => new PrivaroClient({ ...VALID_OPTS, apiKey: "invalid_key" }))
      .toThrow(AuthError);
  });

  it("throws PrivaroError when pipelineId is missing", () => {
    expect(() => new PrivaroClient({ ...VALID_OPTS, pipelineId: "" }))
      .toThrow(PrivaroError);
  });

  it("constructs with valid options", () => {
    const client = new PrivaroClient(VALID_OPTS);
    expect(client.apiKey).toBe(VALID_OPTS.apiKey);
    expect(client.pipelineId).toBe(VALID_OPTS.pipelineId);
    expect(client.baseUrl).toBe(
      "https://api.privaro.ai/v1"
    );
  });

  it("strips trailing slash from baseUrl", () => {
    const client = new PrivaroClient({ ...VALID_OPTS, baseUrl: "https://example.com/v1/" });
    expect(client.baseUrl).toBe("https://example.com/v1");
  });
});

// ─── protect() ───────────────────────────────────────────────────────────────

describe("protect()", () => {
  let client: PrivaroClient;
  beforeEach(() => {
    client = new PrivaroClient(VALID_OPTS);
    mockFetch.mockReset();
  });

  it("returns empty result for blank prompt", async () => {
    const result = await client.protect("   ");
    expect(result.protected).toBe("");
    expect(result.hasPii).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("sends correct request and parses response", async () => {
    mockSuccess(PROTECT_RESPONSE);
    const result = await client.protect("Patient María García, DNI 34521789X");

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/proxy/protect");
    expect(JSON.parse(opts.body as string)).toMatchObject({
      pipeline_id: VALID_OPTS.pipelineId,
      prompt: "Patient María García, DNI 34521789X",
    });

    expect(result.protected).toBe("Patient [NM-0001], DNI [ID-0001]");
    expect(result.total_detected).toBe(2);
    expect(result.total_masked).toBe(2);
    expect(result.coverage_pct).toBe(100);
    expect(result.gdpr_compliant).toBe(true);
    expect(result.audit_log_id).toBe("uuid-audit-001");
    expect(result.detections).toHaveLength(2);
  });

  it("exposes Detection.isHighRisk correctly", async () => {
    mockSuccess(PROTECT_RESPONSE);
    const result = await client.protect("test");
    const dni = result.detections.find((d) => d.type === "dni")!;
    const name = result.detections.find((d) => d.type === "full_name")!;
    expect(dni.isHighRisk).toBe(true);    // critical
    expect(name.isHighRisk).toBe(false);  // medium
  });

  it("riskLevel computed correctly", async () => {
    mockSuccess({ ...PROTECT_RESPONSE, stats: { ...PROTECT_RESPONSE.stats, risk_score: 0.8 } });
    const result = await client.protect("test");
    expect(result.riskLevel).toBe("high");
  });

  it("isSafe is false when leaked > 0", async () => {
    mockSuccess({ ...PROTECT_RESPONSE, stats: { ...PROTECT_RESPONSE.stats, leaked: 1 } });
    const result = await client.protect("test");
    expect(result.isSafe).toBe(false);
  });

  it("summary() returns one-line string", async () => {
    mockSuccess(PROTECT_RESPONSE);
    const result = await client.protect("test");
    expect(result.summary()).toMatch(/\[Privaro\]/);
    expect(result.summary()).toMatch(/detected/);
  });

  it("throws AuthError on 401", async () => {
    mockHttpError(401);
    await expect(client.protect("test")).rejects.toThrow(AuthError);
  });

  it("throws PipelineNotFoundError on 404", async () => {
    mockHttpError(404);
    await expect(client.protect("test")).rejects.toThrow(PipelineNotFoundError);
  });

  it("passes X-Privaro-Key header", async () => {
    mockSuccess(PROTECT_RESPONSE);
    await client.protect("test");
    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect((opts.headers as Record<string, string>)["X-Privaro-Key"]).toBe(VALID_OPTS.apiKey);
  });
});

// ─── detect() ────────────────────────────────────────────────────────────────

describe("detect()", () => {
  let client: PrivaroClient;
  beforeEach(() => {
    client = new PrivaroClient(VALID_OPTS);
    mockFetch.mockReset();
  });

  it("calls /proxy/detect endpoint", async () => {
    mockSuccess({
      request_id: "req_detect01",
      detections: PROTECT_RESPONSE.detections,
      stats: PROTECT_RESPONSE.stats,
    });
    const result = await client.detect("Patient María García");

    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/proxy/detect");
    // detect never masks
    expect(result.protected).toBe("Patient María García");
  });
});

// ─── protectOutput() ───────────────────────────────────────────────────────────

const PROTECT_OUTPUT_RESPONSE = {
  request_id: "req_out_001",
  protected_response: "Según nuestros registros, [NM-0001] tiene DNI [ID-0001].",
  detections: [
    {
      type: "dni", severity: "critical", action: "tokenised",
      token: "[ID-0001]", confidence: 0.95, detector: "regex", start: 45, end: 54,
    },
  ],
  stats: {
    total_detected: 1, total_masked: 1, leaked: 0,
    coverage_pct: 100, processing_ms: 33, risk_score: 0.7,
  },
  audit_log_id: "uuid-output-audit-001",
  gdpr_compliant: true,
  scan_mode: "shadow",
  response_modified: true,
};

describe("protectOutput()", () => {
  let client: PrivaroClient;
  beforeEach(() => {
    client = new PrivaroClient(VALID_OPTS);
    mockFetch.mockReset();
  });

  it("returns empty result for blank response text", async () => {
    const result = await client.protectOutput("   ");
    expect(result.protected).toBe("");
    expect(result.hasPii).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("calls /proxy/protect-output with response_text and conversation_id", async () => {
    mockSuccess(PROTECT_OUTPUT_RESPONSE);
    const result = await client.protectOutput("respuesta del LLM con PII", {
      conversationId: "conv-1",
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/proxy/protect-output");
    expect(JSON.parse(opts.body as string)).toMatchObject({
      pipeline_id: VALID_OPTS.pipelineId,
      response_text: "respuesta del LLM con PII",
      conversation_id: "conv-1",
    });

    expect(result.protected).toBe(PROTECT_OUTPUT_RESPONSE.protected_response);
    expect(result.total_detected).toBe(1);
    expect(result.scan_mode).toBe("shadow");
    expect(result.response_modified).toBe(true);
    expect(result.gdpr_compliant).toBe(true);
  });

  it("parses detections and scan_mode='enforce'", async () => {
    mockSuccess({ ...PROTECT_OUTPUT_RESPONSE, scan_mode: "enforce" });
    const result = await client.protectOutput("texto");
    expect(result.detections).toHaveLength(1);
    expect(result.detections[0].isHighRisk).toBe(true);
    expect(result.scan_mode).toBe("enforce");
  });

  it("throws OutputScanningDisabledError when the pipeline hasn't opted in", async () => {
    mockHttpError(403, {
      detail: {
        error: "output_scanning_disabled",
        message: "This pipeline has not enabled output-direction PII scanning.",
      },
    });
    await expect(client.protectOutput("texto con PII")).rejects.toThrow(
      OutputScanningDisabledError
    );
  });

  it("still throws AuthError on a plain 403 (no output_scanning_disabled detail)", async () => {
    mockHttpError(403, {});
    await expect(client.protectOutput("texto")).rejects.toThrow(AuthError);
  });

  it("summary() returns one-line string", async () => {
    mockSuccess(PROTECT_OUTPUT_RESPONSE);
    const result = await client.protectOutput("texto");
    expect(result.summary()).toMatch(/\[Privaro:output\]/);
  });
});

// ─── protectDocument() ──────────────────────────────────────────────────────

describe("protectDocument()", () => {
  let client: PrivaroClient;
  beforeEach(() => {
    client = new PrivaroClient(VALID_OPTS);
    mockFetch.mockReset();
  });

  const SYNC_RESPONSE = {
    request_id: "req_abc",
    status: "completed",
    protected_document: "Hola [NM-0001]",
    chunks: [{ index: 0, text: "Hola [NM-0001]", char_start: 0, char_end: 14 }],
    detections: [
      {
        type: "full_name",
        severity: "low",
        action: "tokenised",
        token: "[NM-0001]",
        confidence: 0.8,
        detector: "regex",
        start: 5,
        end: 13,
      },
    ],
    stats: { total_detected: 1, char_count: 14, chunk_count: 1, processing_ms: 12 },
  };

  it("returns immediately for a synchronous (small document) response", async () => {
    mockSuccess(SYNC_RESPONSE);
    const result = await client.protectDocument("Hola Juan Perez");

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/proxy/protect-document");
    expect(JSON.parse(opts.body as string)).toMatchObject({
      pipeline_id: VALID_OPTS.pipelineId,
      document: "Hola Juan Perez",
    });

    expect(result.protected_document).toBe("Hola [NM-0001]");
    expect(result.chunkCount).toBe(1);
    expect(result.chunks[0].text).toBe("Hola [NM-0001]");
    expect(result.detections[0].type).toBe("full_name");
  });

  it("polls the job until completion for an async (large document) response", async () => {
    mockSuccess({ request_id: "req_x", status: "processing", job_id: "job_999", estimated_seconds: 10 });
    mockSuccess({ request_id: "req_x", status: "processing", job_id: "job_999" });
    mockSuccess({
      request_id: "req_x",
      status: "completed",
      job_id: "job_999",
      protected_document: "Documento largo protegido [NM-0001]",
      chunks: [{ index: 0, text: "chunk1", char_start: 0, char_end: 6 }],
      detections: [],
      stats: { total_detected: 1, char_count: 100000, chunk_count: 1, processing_ms: 5000 },
    });

    const result = await client.protectDocument("documento muy largo".repeat(10000), {
      pollIntervalMs: 1,
    });

    expect(result.job_id).toBe("job_999");
    expect(result.protected_document).toBe("Documento largo protegido [NM-0001]");
    expect(mockFetch).toHaveBeenCalledTimes(3);

    const [postUrl, postOpts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(postUrl).toContain("/proxy/protect-document");
    expect(postOpts.method).toBe("POST");

    const [getUrl, getOpts] = mockFetch.mock.calls[1] as [string, RequestInit];
    expect(getUrl).toContain("/proxy/protect-document/job_999");
    expect(getOpts.method).toBe("GET");
  });

  it("throws PrivaroError when the job ends up failed", async () => {
    mockSuccess({ request_id: "req_y", status: "processing", job_id: "job_fail" });
    mockSuccess({ status: "failed", degraded_reason: "detector_timeout" });

    await expect(
      client.protectDocument("doc", { pollIntervalMs: 1 })
    ).rejects.toThrow(PrivaroError);
  });

  it("throws PrivaroError when the polling timeout is exceeded", async () => {
    mockSuccess({ request_id: "req_z", status: "processing", job_id: "job_stuck" });
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: "processing", job_id: "job_stuck" }),
    } as Response);

    await expect(
      client.protectDocument("doc", { pollIntervalMs: 5, pollTimeoutMs: 20 })
    ).rejects.toThrow(PrivaroError);
  });

  it("summary() returns one-line string", async () => {
    mockSuccess(SYNC_RESPONSE);
    const result = await client.protectDocument("Hola Juan Perez");
    expect(result.summary()).toMatch(/\[Privaro:ingest\]/);
  });
});

// ─── protectRetrieval() ─────────────────────────────────────────────────────

describe("protectRetrieval()", () => {
  let client: PrivaroClient;
  beforeEach(() => {
    client = new PrivaroClient(VALID_OPTS);
    mockFetch.mockReset();
  });

  const RETRIEVAL_RESPONSE = {
    request_id: "req_ret1",
    allowed_chunks: [
      { id: "c1", protected_text: "El paciente [NM-0001] fue atendido.", detections_count: 1, from_cache: false },
      { id: "c3", protected_text: "El paciente [NM-0001] fue atendido.", detections_count: 1, from_cache: true },
    ],
    blocked_chunks: [
      { id: "c2", reason: "access_denied", detail: "requester role 'developer' not in chunk's allowed_roles" },
    ],
    stats: { chunks_in: 3, chunks_allowed: 2, chunks_blocked: 1, cache_hits: 1, cache_hit_rate: 0.333, total_detected: 2, processing_ms: 45 },
  };

  it("parses allowed and blocked chunks, and sends the correct payload shape", async () => {
    mockSuccess(RETRIEVAL_RESPONSE);

    const chunks = [
      { id: "c1", text: "El paciente Juan Perez fue atendido." },
      { id: "c2", text: "Info confidencial.", allowedRoles: ["admin"] },
      { id: "c3", text: "El paciente Juan Perez fue atendido." },
    ];
    const result = await client.protectRetrieval(chunks, { requesterRole: "developer" });

    expect(result.allowed_chunks).toHaveLength(2);
    expect(result.blocked_chunks).toHaveLength(1);
    expect(result.allowed_chunks[0].id).toBe("c1");
    expect(result.allowed_chunks[1].from_cache).toBe(true);
    expect(result.blocked_chunks[0].reason).toBe("access_denied");

    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/proxy/protect-retrieval");
    const body = JSON.parse(opts.body as string);
    expect(body.requester.role).toBe("developer");
    expect(body.chunks).toHaveLength(3);
    expect(body.chunks[1].allowed_roles).toEqual(["admin"]);
  });

  it("summary() returns one-line string", async () => {
    mockSuccess(RETRIEVAL_RESPONSE);
    const result = await client.protectRetrieval([{ id: "c1", text: "texto" }]);
    expect(result.summary()).toMatch(/\[Privaro:retrieval\]/);
  });

  it("handles an empty allowed_chunks / blocked_chunks response gracefully", async () => {
    mockSuccess({
      request_id: "req_empty",
      allowed_chunks: [],
      blocked_chunks: [],
      stats: { chunks_in: 0, chunks_allowed: 0, chunks_blocked: 0 },
    });
    const result = await client.protectRetrieval([]);
    expect(result.allowed_chunks).toEqual([]);
    expect(result.blocked_chunks).toEqual([]);
  });
});

// ─── AgentRun ─────────────────────────────────────────────────────────────────

describe("AgentRun", () => {
  beforeEach(() => { mockFetch.mockReset(); });

  it("generates a UUID conversationId", () => {
    const run = new AgentRun(VALID_OPTS);
    expect(run.conversationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  it("protect() sets agentMode: true", async () => {
    mockSuccess(PROTECT_RESPONSE);
    const run = new AgentRun(VALID_OPTS);
    await run.protect("María García, DNI 34521789X");

    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string);
    expect(body.options.agent_mode).toBe(true);
  });

  it("accumulates steps", async () => {
    mockSuccess(PROTECT_RESPONSE);
    mockSuccess(PROTECT_RESPONSE);
    const run = new AgentRun(VALID_OPTS);
    await run.protect("step 1");
    await run.protect("step 2");
    expect(run.stepCount).toBe(2);
  });
});

describe("relayStream()", () => {
  it("yields de-tokenised deltas as they arrive", async () => {
    mockSseStream([
      'data: {"delta": "Claro, "}\n\n',
      'data: {"delta": "Juan Pérez"}\n\ndata: {"delta": ", su cita es el..."}\n\n',
      "data: [DONE]\n\n",
    ]);

    const client = new PrivaroClient(VALID_OPTS);
    const deltas: string[] = [];
    for await (const delta of client.relayStream([
      { role: "user", content: "hola" },
    ])) {
      deltas.push(delta);
    }

    expect(deltas.join("")).toBe("Claro, Juan Pérez, su cita es el...");
  });

  it("handles an SSE event split across two raw chunks", async () => {
    // The exact same logical event, but the chunk boundary falls
    // mid-JSON — must still parse correctly once buffered.
    mockSseStream([
      'data: {"del',
      'ta": "hola mundo"}\n\ndata: [DONE]\n\n',
    ]);

    const client = new PrivaroClient(VALID_OPTS);
    const deltas: string[] = [];
    for await (const delta of client.relayStream([
      { role: "user", content: "hola" },
    ])) {
      deltas.push(delta);
    }

    expect(deltas.join("")).toBe("hola mundo");
  });

  it("throws PrivaroError when the stream reports a provider error", async () => {
    mockSseStream([
      'data: {"error": "OpenAI error 401: invalid key", "provider": "openai"}\n\n',
      "data: [DONE]\n\n",
    ]);

    const client = new PrivaroClient(VALID_OPTS);
    await expect(async () => {
      for await (const _ of client.relayStream([
        { role: "user", content: "hola" },
      ])) {
        // consume
      }
    }).rejects.toThrow(PrivaroError);
  });

  it("throws AuthError on 401", async () => {
    mockHttpError(401);
    const client = new PrivaroClient(VALID_OPTS);
    await expect(async () => {
      for await (const _ of client.relayStream([
        { role: "user", content: "hola" },
      ])) {
        // consume
      }
    }).rejects.toThrow(AuthError);
  });
});

describe("randomUUID() fallback (utils.ts)", () => {
  /**
   * Regression test for the real Node 18 CI failure chased over several
   * rounds (2026-07-24): globalThis.crypto.randomUUID doesn't exist on
   * Node 18 without a flag, so randomUUID() must fall back to
   * node:crypto. Every other test in this file runs on whatever Node
   * version executes the test suite (Node 22 locally) — where the global
   * already exists — so none of them actually exercise the fallback
   * branch. This one forces it by deleting globalThis.crypto for the
   * duration of the test, so the createRequire("node:crypto") path is
   * genuinely proven to work, not just assumed to.
   */
  it("falls back to node:crypto when globalThis.crypto is unavailable", () => {
    const original = (globalThis as any).crypto;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).crypto;
    try {
      const id = randomUUID();
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      );
    } finally {
      (globalThis as any).crypto = original;
    }
  });

  it("uses globalThis.crypto.randomUUID when available", () => {
    const original = (globalThis as any).crypto;
    const fakeUUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    (globalThis as any).crypto = { randomUUID: () => fakeUUID };
    try {
      expect(randomUUID()).toBe(fakeUUID);
    } finally {
      (globalThis as any).crypto = original;
    }
  });
});
