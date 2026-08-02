// Same-origin proxy for the faucet's GET /api/health.
//
// The faucet's /api/health has no CORS headers (only /api/drip sets them
// in-app), so the landing page's cross-origin probe to
// faucet.quetzaldex.xyz/api/health was blocked. Proxying it server-side keeps
// the probe same-origin. (The actual drip still goes directly to the faucet —
// /api/drip already handles CORS.)
const FAUCET_ORIGIN = process.env.FAUCET_ORIGIN || "https://faucet.quetzaldex.xyz";

export default async function handler(_req, res) {
  try {
    const upstream = await fetch(`${FAUCET_ORIGIN}/api/health`);
    const text = await upstream.text();
    res.status(upstream.status).setHeader("content-type", "application/json").send(text);
  } catch (e) {
    res.status(502).json({ error: "faucet proxy failed", detail: String((e && e.message) || e) });
  }
}
