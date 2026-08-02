import { describe, test, expect } from "vitest";
import { matchOrigin } from "@/lib/cors";

describe("matchOrigin", () => {
  test("exact-string match", () => {
    const allow: Array<string | RegExp> = ["https://quetzaldex.xyz"];
    expect(matchOrigin("https://quetzaldex.xyz", allow)).toBe(true);
    expect(matchOrigin("https://quetzaldex.xyz/", allow)).toBe(false);
    expect(matchOrigin("https://evil.example", allow)).toBe(false);
  });

  test("regex match", () => {
    const allow: Array<string | RegExp> = [/^https:\/\/.*-kubudak90s-projects\.vercel\.app$/];
    expect(matchOrigin("https://aztec-project-deadbeef-kubudak90s-projects.vercel.app", allow)).toBe(true);
    expect(matchOrigin("https://other.vercel.app", allow)).toBe(false);
  });

  test("mixed list", () => {
    const allow: Array<string | RegExp> = [
      "https://quetzaldex.xyz",
      /^https:\/\/preview-\d+\.example$/,
    ];
    expect(matchOrigin("https://quetzaldex.xyz", allow)).toBe(true);
    expect(matchOrigin("https://preview-7.example", allow)).toBe(true);
    expect(matchOrigin("https://preview-x.example", allow)).toBe(false);
  });

  test("null/empty origin rejected", () => {
    expect(matchOrigin("", ["https://x"])).toBe(false);
    expect(matchOrigin(null as unknown as string, ["https://x"])).toBe(false);
  });
});
