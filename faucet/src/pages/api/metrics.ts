import type { NextApiRequest, NextApiResponse } from "next";
import { metrics } from "@/lib/metrics";

export default async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== "GET") { res.status(405).end(); return; }
  res.setHeader("Content-Type", metrics.registry.contentType);
  res.status(200).send(await metrics.registry.metrics());
}
