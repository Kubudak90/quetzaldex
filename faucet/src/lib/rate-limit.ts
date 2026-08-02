import Database from "better-sqlite3";

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds?: number;
  reason?: "per-ip" | "global-cap";
  /** M15: id of the reserved (allowed=1) row when allowed. Pass to release() if the
   *  drip this accounted for ultimately did NOT dispense, so failed drips don't
   *  permanently consume the per-IP / global-cap capacity. */
  id?: number;
}

/**
 * Wall-clock abstraction injected by callers for testability.
 *
 * **MUST return Unix seconds** (not milliseconds). The internal arithmetic
 * uses `now - 86_400` for the 24-hour window and `now - perIpWindowSeconds`
 * for the per-IP window. Passing `Date.now` (milliseconds) collapses the daily
 * window to 86.4 seconds and the per-IP window to milliseconds — silent
 * breakage with no runtime error.
 *
 * Production callers should use: `{ now: () => Math.floor(Date.now() / 1000) }`.
 */
export interface Clock { now(): number; }

interface RateLimiterOpts {
  sqlitePath: string;
  perIpMaxDripsPerWindow: number;
  perIpWindowSeconds: number;
  dailyCap: number;
}

/**
 * SQLite-backed per-IP count-in-window + global daily cap.
 * Schema bootstrap uses prepare().run() per statement (safer than multi-statement
 * helpers; same end state).
 */
export class RateLimiter {
  private readonly db: Database.Database;
  private readonly perIpMax: number;
  private readonly perIpWindow: number;
  private readonly cap: number;

  constructor(opts: RateLimiterOpts) {
    this.db = new Database(opts.sqlitePath);
    this.db.pragma("journal_mode = WAL");
    // Single-process only. better-sqlite3 is synchronous, so check-then-record
    // is effectively atomic WITHIN one Node process. Under PM2 cluster mode or
    // multiple containers sharing the same SQLite file, the WAL does not
    // serialize reads across processes — a distributed rate-limit layer
    // (Redis, etc.) would be needed at that scale.
    this.db.prepare(
      `CREATE TABLE IF NOT EXISTS hits (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         ip TEXT NOT NULL,
         ts INTEGER NOT NULL,
         allowed INTEGER NOT NULL
       )`
    ).run();
    this.db.prepare("CREATE INDEX IF NOT EXISTS idx_hits_ts ON hits(ts)").run();
    this.db.prepare("CREATE INDEX IF NOT EXISTS idx_hits_ip_ts ON hits(ip, ts)").run();
    this.perIpMax = opts.perIpMaxDripsPerWindow;
    this.perIpWindow = opts.perIpWindowSeconds;
    this.cap = opts.dailyCap;
  }

  checkAndRecord(ip: string, clock: Clock): RateLimitResult {
    const now = clock.now();
    const since24h = now - 86_400;
    const countRow = this.db
      .prepare("SELECT COUNT(*) AS n FROM hits WHERE ts >= ? AND allowed = 1")
      .get(since24h) as { n: number };
    if (countRow.n >= this.cap) {
      this.recordHit(ip, now, false);
      return { allowed: false, reason: "global-cap" };
    }
    const windowStart = now - this.perIpWindow;
    const ipHits = this.db
      .prepare(
        "SELECT ts FROM hits WHERE ip = ? AND allowed = 1 AND ts >= ? ORDER BY ts ASC"
      )
      .all(ip, windowStart) as Array<{ ts: number }>;
    if (ipHits.length >= this.perIpMax) {
      this.recordHit(ip, now, false);
      const oldest = ipHits[0]!.ts;
      const retryAfterSeconds = this.perIpWindow - (now - oldest);
      return {
        allowed: false,
        reason: "per-ip",
        retryAfterSeconds,
      };
    }
    const id = this.recordHit(ip, now, true);
    return { allowed: true, id };
  }

  /**
   * M15: cancel a reservation (set allowed=0) when the drip it accounted for did
   * NOT dispense (drained / transient failure). Only actually-dispensed drips then
   * count toward the per-IP and global caps. Idempotent.
   */
  release(id: number): void {
    this.db.prepare("UPDATE hits SET allowed = 0 WHERE id = ?").run(id);
  }

  stats(clock: Clock): { totalRequests24h: number; throttled24h: number } {
    const since = clock.now() - 86_400;
    const total = this.db
      .prepare("SELECT COUNT(*) AS n FROM hits WHERE ts >= ?")
      .get(since) as { n: number };
    const throttled = this.db
      .prepare("SELECT COUNT(*) AS n FROM hits WHERE ts >= ? AND allowed = 0")
      .get(since) as { n: number };
    return { totalRequests24h: total.n, throttled24h: throttled.n };
  }

  evictStale(clock: Clock): void {
    this.db.prepare("DELETE FROM hits WHERE ts < ?").run(clock.now() - 86_400);
  }

  close(): void { this.db.close(); }

  private recordHit(ip: string, ts: number, allowed: boolean): number {
    const info = this.db
      .prepare("INSERT INTO hits (ip, ts, allowed) VALUES (?, ?, ?)")
      .run(ip, ts, allowed ? 1 : 0);
    return Number(info.lastInsertRowid);
  }
}
