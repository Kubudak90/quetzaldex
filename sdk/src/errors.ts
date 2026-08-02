// sdk/src/errors.ts

export class QuetzalError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "QuetzalError";
  }
}

export class OrderError extends QuetzalError {
  constructor(
    code: "EPOCH_CLOSED" | "INVALID_PATH" | "ESCROW_FAILED" | "UNKNOWN",
    message: string,
    cause?: unknown,
  ) {
    super(code, message, cause);
    this.name = "OrderError";
  }
}

export class BridgeError extends QuetzalError {
  constructor(
    code: "L2_TX_FAILED" | "L1_CLAIM_NOT_READY" | "OUTBOX_PROOF_MISSING" | "UNKNOWN",
    message: string,
    cause?: unknown,
  ) {
    super(code, message, cause);
    this.name = "BridgeError";
  }
}

export class ConfigError extends QuetzalError {
  constructor(
    code: "MISSING_ENV" | "UNKNOWN_TOKEN" | "INVALID_NETWORK" | "UNKNOWN",
    message: string,
    cause?: unknown,
  ) {
    super(code, message, cause);
    this.name = "ConfigError";
  }
}
