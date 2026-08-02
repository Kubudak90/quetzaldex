import { describe, test, expect } from "vitest";
import { CLAIM_DEPLOY_PHASES } from "./claim-deploy";

describe("CLAIM_DEPLOY_PHASES", () => {
  test("declares the canonical phase order", () => {
    expect(CLAIM_DEPLOY_PHASES).toEqual([
      "claiming",
      "proving",
      "sending",
      "waiting",
      "done",
    ] as const);
  });
});
