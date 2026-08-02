// Same-origin proxy for the aggregator's POST /reveal.
//
// The browser posts to /api/reveal (HTTPS, same-origin as quetzaldex.xyz); this
// Vercel function forwards it SERVER-SIDE to the aggregator over plain HTTP.
// Avoids three problems at once:
//   - mixed-content (an HTTPS page can't fetch http://<vps>:3001 directly)
//   - CORS (same-origin call needs none)
//
// Without this, trade.tsx's reveal broadcast never reached the aggregator, so
// browser-placed orders were never revealed and never cleared.
//
// NOTE: kept FLAT under /api (not /api/aggregator/) — Vercel only deployed the
// top-level /api function on this project; nested /api/aggregator/* 404'd. The
// SDK's directReveal posts to `${base}/reveal`, so the frontend sets base="/api".
const AGG_ORIGIN = process.env.AGGREGATOR_ORIGIN || "https://aggregator.quetzaldex.xyz";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }
  try {
    const body = typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {});
    const upstream = await fetch(`${AGG_ORIGIN}/reveal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    const text = await upstream.text();
    res.status(upstream.status).setHeader("content-type", "application/json").send(text);
  } catch (e) {
    res.status(502).json({ error: "aggregator proxy failed", detail: String((e && e.message) || e) });
  }
}
