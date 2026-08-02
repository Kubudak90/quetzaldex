// Same-origin proxy for the aggregator's GET /proof (Sub-4 browser claim path).
//
// The browser GETs /api/proof?order_nonce=…&epoch_id=…&hop_index=… (HTTPS,
// same-origin as quetzaldex.xyz); this Vercel function forwards it SERVER-SIDE to
// the aggregator over plain HTTP. Same rationale as api/reveal.mjs:
//   - mixed-content (an HTTPS page can't fetch http://<vps>:3001 directly)
//   - CORS (same-origin call needs none)
//
// Shares AGGREGATOR_ORIGIN with the reveal proxy so both target the same box.
// The SDK's fetchHopProof GETs `${base}/proof`, so the frontend sets base="/api".
const AGG_ORIGIN = process.env.AGGREGATOR_ORIGIN || "https://aggregator.quetzaldex.xyz";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }
  try {
    const qIdx = req.url.indexOf("?");
    const qs = qIdx >= 0 ? req.url.slice(qIdx) : "";
    const upstream = await fetch(`${AGG_ORIGIN}/proof${qs}`, {
      method: "GET",
      headers: { accept: "application/json" },
    });
    const text = await upstream.text();
    res.status(upstream.status).setHeader("content-type", "application/json").send(text);
  } catch (e) {
    res.status(502).json({ error: "aggregator proxy failed", detail: String((e && e.message) || e) });
  }
}
