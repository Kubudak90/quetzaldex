// drpc-fetch-shim.mjs — Node --import preload. drpc free tier rejects JSON-RPC
// batches >3 (HTTP 500 code 31). Transparently split outgoing batch POSTs into
// chunks of <=3 and merge the responses, so aztec.js works on drpc unchanged.
// No dependency-file edits; intercepts global fetch only.
const orig = globalThis.fetch;
globalThis.fetch = async function (url, opts) {
  try {
    if (opts && opts.method === "POST" && typeof opts.body === "string" && opts.body[0] === "[") {
      const parsed = JSON.parse(opts.body);
      if (Array.isArray(parsed) && parsed.length > 3) {
        const merged = [];
        for (let i = 0; i < parsed.length; i += 3) {
          const chunk = parsed.slice(i, i + 3);
          const r = await orig(url, { ...opts, body: JSON.stringify(chunk) });
          if (!r.ok) return r; // surface server errors unchanged
          const j = await r.json();
          if (Array.isArray(j)) merged.push(...j); else merged.push(j);
        }
        return new Response(JSON.stringify(merged), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
    }
  } catch {
    // fall through to the original fetch on any parsing/shaping issue
  }
  return orig(url, opts);
};
