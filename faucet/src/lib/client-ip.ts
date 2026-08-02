import type { NextApiRequest } from "next";

/**
 * Extract the client IP from a request behind a single trusted reverse proxy.
 *
 * SECURITY (Audit #5): both our nginx front (`X-Forwarded-For
 * $proxy_add_x_forwarded_for`) and the live Caddy front append the real peer
 * address as the LAST X-Forwarded-For entry. A client can prepend arbitrary
 * fake entries (e.g. `X-Forwarded-For: 1.1.1.1`) but cannot append anything
 * after the proxy, so the LAST entry is the authoritative peer address used for
 * rate limiting. The previous implementation trusted the FIRST entry, which let
 * a client spoof its IP and bypass the per-IP rate limit.
 *
 * We deliberately do NOT trust X-Real-IP first: Caddy does not strip a
 * client-supplied X-Real-IP, so it is spoofable on the live box. X-Real-IP is
 * only a fallback for when no X-Forwarded-For is present at all (local dev with
 * no proxy, where there is no attacker), and finally the raw socket address.
 */
export function getClientIp(req: NextApiRequest): string {
  const xffRaw = req.headers["x-forwarded-for"];
  // Repeated headers may surface as an array; the closest proxy's value is the
  // last one, and within it the appended peer is the last comma-separated entry.
  const xff = Array.isArray(xffRaw) ? xffRaw[xffRaw.length - 1] : xffRaw;
  if (typeof xff === "string" && xff.length > 0) {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length > 0) {
      return parts[parts.length - 1]!;
    }
  }

  const xri = req.headers["x-real-ip"];
  if (typeof xri === "string" && xri.length > 0) {
    return xri;
  }

  return req.socket.remoteAddress ?? "unknown";
}
