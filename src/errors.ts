export class PrivaroError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "PrivaroError";
  }
}

export class AuthError extends PrivaroError {
  constructor(message = "Invalid API key or unauthorized access.") {
    super(message);
    this.name = "AuthError";
  }
}

export class PipelineNotFoundError extends PrivaroError {
  constructor(pipelineId: string) {
    super(`Pipeline '${pipelineId}' not found or not accessible.`);
    this.name = "PipelineNotFoundError";
  }
}

export class PolicyBlockError extends PrivaroError {
  constructor(
    message = "Request blocked by privacy policy.",
    public readonly blockedEntities: string[] = []
  ) {
    super(message);
    this.name = "PolicyBlockError";
  }
}

export class RateLimitError extends PrivaroError {
  constructor(message = "Rate limit exceeded. Slow down requests.") {
    super(message);
    this.name = "RateLimitError";
  }
}

export class ProxyUnavailableError extends PrivaroError {
  constructor(baseUrl: string, cause?: unknown) {
    super(
      `Cannot reach Privaro proxy at ${baseUrl}. ` +
      `Check your network or PRIVARO_BASE_URL.`,
      cause
    );
    this.name = "ProxyUnavailableError";
  }
}

/**
 * Raised by protectOutput() when the pipeline hasn't opted into
 * output-direction PII scanning (pipeline.output_scanning_enabled=false).
 * Enable it in the dashboard: Pipelines → Settings → Output scanning.
 * A deliberate hard failure, not a silent passthrough — a caller
 * invoking protectOutput() explicitly wants their LLM's response
 * scanned, so a disabled pipeline must not pretend to have done that.
 */
export class OutputScanningDisabledError extends PrivaroError {
  constructor(
    message = "This pipeline has not enabled output-direction PII scanning. " +
      "Enable output_scanning_enabled for this pipeline in the dashboard " +
      "(Pipelines → Settings) before calling protectOutput()."
  ) {
    super(message);
    this.name = "OutputScanningDisabledError";
  }
}
