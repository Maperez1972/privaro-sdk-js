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
