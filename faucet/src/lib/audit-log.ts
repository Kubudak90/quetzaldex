import { appendFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";

export interface AuditRecord {
  ts: number;
  ip: string;
  address: string;
  success: boolean;
  claimAmount?: string;
  mintTxs?: { tUSDC?: string; tETH?: string };
  error?: string;
}

export class AuditLog {
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  append(r: AuditRecord): void {
    const ipHash = createHash("sha256").update(r.ip).digest("hex");
    const { ip: _drop, ...rest } = r;
    void _drop;
    appendFileSync(this.path, JSON.stringify({ ...rest, ipHash }) + "\n");
  }
}
