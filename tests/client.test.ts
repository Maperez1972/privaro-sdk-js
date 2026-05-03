import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { PrivaroClient, AgentRun } from "../src/client.js";
import { AuthError, PipelineNotFoundError, PrivaroError } from "../src/errors.js";

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
      "https://privaro-proxy-production.up.railway.app/v1"
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
