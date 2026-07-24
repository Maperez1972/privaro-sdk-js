// ─── Detection ────────────────────────────────────────────────────────────────

export type EntityType =
  | "full_name"
  | "email"
  | "phone"
  | "dni"
  | "iban"
  | "credit_card"
  | "health_record"
  | "ip_address"
  | "date_of_birth"
  | "ssn"
  | "session_id"
  | "policy_number"
  | string; // extensible for custom entities

export type Severity = "critical" | "high" | "medium" | "low";
export type DetectionAction = "tokenised" | "anonymised" | "blocked" | "detected";
export type ProtectionMode = "tokenise" | "anonymise" | "block";
export type DetectorSource = "regex" | "presidio" | "custom";

export interface Detection {
  /** Entity type — e.g. "dni", "iban", "full_name" */
  type: EntityType;
  /** Risk level of this entity */
  severity: Severity;
  /** What Privaro did with this entity */
  action: DetectionAction;
  /** Replacement token — e.g. "[ID-0001]". Null in detect-only mode */
  token: string | null;
  /** Detection confidence 0.0–1.0 */
  confidence: number;
  /** Which detector found this entity */
  detector: DetectorSource;
  /** Character start offset in original text */
  start: number | null;
  /** Character end offset in original text */
  end: number | null;
  /** Regulation reference e.g. "GDPR Art.9" — set by policy engine */
  regulation_ref?: string | null;

  // Convenience helpers
  readonly isHighRisk: boolean;
}

// ─── ProtectResult ────────────────────────────────────────────────────────────

export interface ProtectResult {
  /** Prompt with PII replaced by tokens — send this to your LLM */
  protected: string;
  /** Original prompt — stored client-side, never echoed by proxy */
  original: string;
  /** Unique request ID from the proxy */
  request_id: string;
  /** Supabase audit_log row UUID — use for DPO reports */
  audit_log_id: string | null;

  // Per-entity details
  detections: Detection[];

  // Aggregate stats
  total_detected: number;
  total_masked: number;
  leaked: number;
  coverage_pct: number;

  // Risk
  risk_score: number | null;
  gdpr_compliant: boolean;

  // Performance
  processing_ms: number;

  // Convenience helpers
  readonly riskLevel: "high" | "medium" | "low" | "unknown";
  readonly hasPii: boolean;
  readonly isSafe: boolean;

  /** One-line summary for logging */
  summary(): string;
}

// ─── Client options ───────────────────────────────────────────────────────────

export interface PrivaroClientOptions {
  /** API key — must start with "prvr_" */
  apiKey: string;
  /** UUID of the active pipeline */
  pipelineId: string;
  /** Proxy base URL. Defaults to production Railway endpoint */
  baseUrl?: string;
  /** Request timeout in ms. Default: 10000 */
  timeout?: number;
  /** Default protection mode for protect() calls. Default: "tokenise" */
  defaultMode?: ProtectionMode;
}

export interface ProtectOptions {
  /** tokenise | anonymise | block. Overrides client default */
  mode?: ProtectionMode;
  /** Store reversible tokens in vault (BYOK-aware). Default: true */
  reversible?: boolean;
  /** Enable stricter policies for agent/automated pipelines */
  agentMode?: boolean;
  /** Include per-entity details in response. Default: true */
  includeDetections?: boolean;
  /** Group tokens within a conversation for consistent replacement */
  conversationId?: string;
  /** Safe-retry key — a repeated call with the same key returns the exact
   *  same result without re-billing. */
  idempotencyKey?: string;
}

// ─── Relay (full-cycle) ───────────────────────────────────────────────────────

export interface RelayMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface RelayOptions {
  mode?: ProtectionMode;
  detokeniseResponse?: boolean;
  includeDetections?: boolean;
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
  /** Group tokens within a conversation for consistent replacement across turns */
  conversationId?: string;
  /** Safe-retry key — a repeated call with the same key returns the exact
   *  same result without re-billing or re-calling the LLM. Not supported
   *  by relayStream(). */
  idempotencyKey?: string;
}

export interface RelayResult {
  request_id: string;
  provider: string;
  model: string;
  /** LLM response with tokens replaced back to original values */
  response: string;
  /** Raw LLM response before de-tokenisation */
  response_raw: string | null;
  pii_detected: number;
  pii_masked: number;
  risk_score: number;
  gdpr_compliant: boolean;
  audit_log_id: string | null;
  tokens_replaced: number;
  usage: Record<string, number>;
  processing_ms: number;
}

// ─── Agent run ────────────────────────────────────────────────────────────────

export interface AgentStep {
  /** Tokenised messages — pass to your LLM */
  protected_messages: RelayMessage[];
  /** Convenience: content of first message after protection */
  first_content: string;
  detections: Detection[];
  step_id: string;
}
