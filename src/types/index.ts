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

  /** Populated only when optimizeContext=true was passed to protect().
   *  Added 2026-07-30 after a full integration audit found the API
   *  already returns this field but the SDK silently dropped it. */
  compressionStats?: { tokens_saved: number; compression_ratio: number } | undefined;

  // Convenience helpers
  readonly riskLevel: "high" | "medium" | "low" | "unknown";
  readonly hasPii: boolean;
  readonly isSafe: boolean;

  /** One-line summary for logging */
  summary(): string;
}

// ─── ProtectOutputResult (output-direction PII scanning) ──────────────────────

export interface ProtectOutputOptions {
  /** tokenise | anonymise | block. Overrides client default */
  mode?: ProtectionMode;
  /** Store reversible tokens in vault. Default: true. If true,
   *  conversationId is required — pass the SAME conversationId used for
   *  the matching protect() call so tokens replace consistently. */
  reversible?: boolean;
  /** Enable stricter policies for agent/automated pipelines */
  agentMode?: boolean;
  /** Include per-entity details in response. Default: true */
  includeDetections?: boolean;
  /** Must match the protect() call for this turn when reversible=true */
  conversationId?: string;
  /** Safe-retry key — a repeated call with the same key returns the
   *  exact same result without re-billing. */
  idempotencyKey?: string;
}

export interface ProtectOutputResult {
  /** Response text with PII replaced by tokens — return this to your end user */
  protected: string;
  /** Original LLM response text — stored client-side */
  original: string;
  request_id: string;
  audit_log_id: string | null;

  detections: Detection[];

  total_detected: number;
  total_masked: number;
  leaked: number;
  coverage_pct: number;

  risk_score: number | null;
  gdpr_compliant: boolean;

  processing_ms: number;

  /** "shadow" (informational) or "enforce" — mirrors the pipeline's
   *  output_scanning_mode dashboard setting at the time of the call. */
  scan_mode: "shadow" | "enforce";
  /** True if .protected differs from .original — this call masked something */
  response_modified: boolean;

  readonly riskLevel: "high" | "medium" | "low" | "unknown";
  readonly hasPii: boolean;
  readonly isSafe: boolean;

  summary(): string;
}

// ─── Privaro Ingest (Fase 1 of the RAG expansion) ──────────────────────────

/** A single chunk of an already-protected document, ready to embed into
 *  a vector store. Chunk boundaries never split a Privaro token
 *  ([XX-0001]) across two chunks — see the backend's chunker.py. */
export interface DocumentChunk {
  index: number;
  text: string;
  char_start: number;
  char_end: number;
}

export interface ProtectDocumentOptions {
  mode?: "tokenise" | "anonymise" | "block";
  reversible?: boolean;
  /** Run Tier 2 (Presidio) in addition to Tier 1 regex — slower on
   *  large documents but catches names/PII with no adjacent keyword. */
  useNlp?: boolean;
  /** Target characters per chunk (64-8192). */
  chunkSize?: number;
  /** Your own external reference for this document. */
  documentId?: string;
  /** How often to poll job status for an async (large-document)
   *  request, in milliseconds. Default 2000. */
  pollIntervalMs?: number;
  /** Give up waiting after this long and throw — the job keeps running
   *  server-side regardless. Default 300000 (5 minutes). */
  pollTimeoutMs?: number;
}

export interface ProtectDocumentResult {
  request_id: string;
  protected_document: string;
  chunks: DocumentChunk[];
  detections: Detection[];
  stats: Record<string, number>;
  /** Set if the server processed this document asynchronously. */
  job_id?: string | undefined;

  readonly chunkCount: number;
  summary(): string;
}

// ─── Privaro Retrieval Guard (Fase 2 of the RAG expansion) ─────────────────

/** A single chunk to protect before it enters an LLM's context — e.g.
 *  right after a vector store similarity search, before you stuff the
 *  results into a RAG prompt. */
export interface RetrievalChunkInput {
  id: string;
  text: string;
  /** Optional per-chunk access control. If omitted, the chunk is
   *  visible to any requester. */
  allowedRoles?: string[] | undefined;
}

export interface ProtectRetrievalOptions {
  mode?: "tokenise" | "anonymise" | "block";
  /** Run Tier 2 (Presidio) in addition to Tier 1 regex. */
  useNlp?: boolean;
  /** The role making this retrieval request — checked against each
   *  chunk's allowedRoles, if set. */
  requesterRole?: string;
  /** Echoed into audit logs, not used for access control directly. */
  requesterUserId?: string;
}

/** A chunk that passed access control and was protected (tokenised). */
export interface AllowedChunk {
  id: string;
  protected_text: string;
  detections_count: number;
  from_cache: boolean;
}

/** A chunk withheld from the caller — either access-denied (its
 *  allowedRoles didn't include the requester's role) or a detection
 *  failure. Retrieval Guard fails CLOSED per chunk, unlike
 *  protectDocument()'s whole-document fail-open — a batch of unrelated
 *  chunks must never let one chunk's detection failure silently pass
 *  raw, unprotected text into an LLM prompt just because its
 *  neighbours in the same batch succeeded. */
export interface BlockedChunk {
  id: string;
  reason: string;
  detail?: string | undefined;
}

export interface ProtectRetrievalResult {
  request_id: string;
  allowed_chunks: AllowedChunk[];
  blocked_chunks: BlockedChunk[];
  stats: Record<string, number>;

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
  /** Compress the tokenised prompt before returning it, to reduce tokens
   *  sent to your LLM. Never touches PII tokens ([XX-0001]) — see
   *  result.compressionStats for tokens_saved / compression_ratio. */
  optimizeContext?: boolean;
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
  /** Compress tokenised messages before the LLM call. Never touches PII
   *  tokens ([XX-0001]) — see result.compressionStats. */
  optimizeContext?: boolean;
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
  compression_stats?: { tokens_saved: number; compression_ratio: number };
}

// ─── Agent run ────────────────────────────────────────────────────────────────

export interface AgentStep {
  /** Tokenised messages — pass to your LLM */
  protected_messages: RelayMessage[];
  /** Convenience: content of first message after protection */
  first_content: string;
  detections: Detection[];
  step_id: string;
  compressionStats?: { tokens_saved: number; compression_ratio: number } | undefined;
}
