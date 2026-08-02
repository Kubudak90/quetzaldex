// Same-origin proxy for the aggregator's GET /health (see ./reveal.mjs for why).
// The landing page's live-status probe hits /api/health (base="/api" + "/health").
const AGG_ORIGIN = process.env.AGGREGATOR_ORIGIN || "https://aggregator.quetzaldex.xyz";

export default async function handler(_req, res) {
  try {
    const upstream = await fetch(`${AGG_ORIGIN}/health`);
    const text = await upstream.text();
    res.status(upstream.status).setHeader("content-type", "application/json").send(text);
  } catch (e) {
    res.status(502).json({ error: "aggregator proxy failed", detail: String((e && e.message) || e) });
  }
}
