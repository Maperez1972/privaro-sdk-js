/**
 * @privaro/sdk
 * Privacy Infrastructure for Enterprise AI — iCommunity Labs
 *
 * Quick start:
 *   import { PrivaroClient } from "@privaro/sdk";
 *
 *   const privaro = new PrivaroClient({
 *     apiKey: process.env.PRIVARO_API_KEY,
 *     pipelineId: process.env.PRIVARO_PIPELINE_ID,
 *   });
 *
 *   const result = await privaro.protect("Patient María García, DNI 34521789X");
 *   console.log(result.protected); // "Patient [NM-0001], DNI [ID-0001]"
 *
 * Module-level shorthand (mirrors Python SDK):
 *   import privaro from "@privaro/sdk";
 *   privaro.init({ apiKey: "prvr_xxx", pipelineId: "uuid" });
 *   const result = await privaro.protect("...");
 */

export { PrivaroClient, AgentRun } from "./client.js";
export type {
  PrivaroClientOptions,
  ProtectOptions,
  ProtectResult,
  Detection,
  EntityType,
  Severity,
  DetectionAction,
  ProtectionMode,
  DetectorSource,
  RelayMessage,
  RelayOptions,
  RelayResult,
  AgentStep,
} from "./types/index.js";
export {
  PrivaroError,
  AuthError,
  PipelineNotFoundError,
  PolicyBlockError,
  RateLimitError,
  ProxyUnavailableError,
} from "./errors.js";

// ─── Module-level API (mirrors Python SDK) ───────────────────────────────────

import { PrivaroClient } from "./client.js";
import type { PrivaroClientOptions, ProtectOptions, ProtectResult } from "./types/index.js";

let _defaultClient: PrivaroClient | null = null;

function _requireClient(): PrivaroClient {
  if (!_defaultClient) {
    throw new Error(
      "Privaro not initialized. Call privaro.init({ apiKey, pipelineId }) first."
    );
  }
  return _defaultClient;
}

const privaro = {
  /**
   * Initialize the default Privaro client.
   * Use this for the module-level API — or instantiate PrivaroClient directly
   * for multiple pipelines.
   */
  init(opts: PrivaroClientOptions): PrivaroClient {
    _defaultClient = new PrivaroClient(opts);
    return _defaultClient;
  },

  /** Detect and tokenise PII in a prompt. */
  async protect(prompt: string, opts?: ProtectOptions): Promise<ProtectResult> {
    return _requireClient().protect(prompt, opts);
  },

  /** Detect PII without masking (analysis only). */
  async detect(prompt: string): Promise<ProtectResult> {
    return _requireClient().detect(prompt);
  },

  /** Access the current default client (throws if not initialized). */
  get client(): PrivaroClient {
    return _requireClient();
  },
} as const;

export default privaro;
