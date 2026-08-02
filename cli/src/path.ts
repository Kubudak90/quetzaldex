export type TokenAliases = Record<string, string>;

export interface PathInput {
  path_len: 2 | 3;
  path: [string, string, string];   // hex addresses; path[2] = "0x0" if path_len == 2
}

/** Parse "tUSDC,tETH" or "tUSDC,tETH,tBTC" into a PathInput resolving aliases. */
export function parsePath(spec: string, aliases: TokenAliases): PathInput {
  const parts = spec.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
  if (parts.length < 2 || parts.length > 3) {
    throw new Error(`path_len must be 2 or 3, got ${parts.length}`);
  }
  const resolved: string[] = [];
  for (const part of parts) {
    if (!(part in aliases)) {
      throw new Error(`unknown token alias: ${part}`);
    }
    resolved.push(aliases[part]!);
  }
  // Distinctness check
  for (let i = 0; i < resolved.length; i++) {
    for (let j = i + 1; j < resolved.length; j++) {
      if (resolved[i] === resolved[j]) {
        throw new Error(`path[${i}] == path[${j}]: ${resolved[i]}`);
      }
    }
  }
  const path: [string, string, string] = [
    resolved[0]!,
    resolved[1]!,
    resolved[2] ?? "0x0",
  ];
  return { path_len: parts.length as 2 | 3, path };
}

/** Canonical lex ordering of two address hex strings via BigInt comparison. */
export function canonicalize(a: string, b: string): [string, string] {
  const ai = BigInt(a);
  const bi = BigInt(b);
  return ai < bi ? [a, b] : [b, a];
}
