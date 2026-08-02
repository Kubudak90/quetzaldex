/**
 * Map an arbitrary thrown value to a coarse, non-sensitive category string.
 *
 * SECURITY (Audit #7): faucet endpoints must never echo a raw error message to
 * the client. Upstream errors have leaked full RPC URLs + API keys (e.g. a
 * Quicknode URL with its key embedded). This returns ONLY a category and never
 * any substring of the original message, so connection strings, URLs, keys, or
 * file paths embedded in the error cannot cross the response boundary. Callers
 * should log the full error server-side separately.
 */
export function safeReason(e: unknown): string {
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
  if (msg.includes("timeout") || msg.includes("etimedout") || msg.includes("timed out")) {
    return "timeout";
  }
  if (
    msg.includes("econnrefused") ||
    msg.includes("enotfound") ||
    msg.includes("eai_again") ||
    msg.includes("fetch failed") ||
    msg.includes("network") ||
    msg.includes("socket hang up")
  ) {
    return "upstream-unreachable";
  }
  if (msg.includes("429") || msg.includes("rate") || msg.includes("throttl")) {
    return "upstream-throttled";
  }
  return "unavailable";
}
