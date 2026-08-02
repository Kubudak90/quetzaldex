export function matchOrigin(origin: string, allowed: Array<string | RegExp>): boolean {
  if (!origin || typeof origin !== "string") return false;
  for (const entry of allowed) {
    if (typeof entry === "string") {
      if (entry === origin) return true;
    } else {
      if (entry.test(origin)) return true;
    }
  }
  return false;
}
