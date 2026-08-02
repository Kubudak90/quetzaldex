import { collectDefaultMetrics, Registry } from "prom-client";
import { createServer } from "node:http";

/**
 * Sub-5c C1: shared Prometheus registry + HTTP server setup.
 */
export function setupRegistry(): Registry {
  const r = new Registry();
  collectDefaultMetrics({ register: r });
  return r;
}

export function startServer(registry: Registry, port: number): void {
  createServer(async (req, res) => {
    if (req.url === "/metrics") {
      res.setHeader("Content-Type", registry.contentType);
      res.end(await registry.metrics());
    } else if (req.url === "/health") {
      res.end("ok\n");
    } else {
      res.statusCode = 404;
      res.end();
    }
  }).listen(port, () => console.log(`exporter listening on :${port}`));
}
