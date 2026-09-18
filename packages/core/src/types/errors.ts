/** Thrown when a session cannot currently support a requested operation. */
export class CapabilityUnsupportedError extends Error {
  readonly sessionId: string;
  readonly capability: string;
  readonly reason: string;

  constructor(sessionId: string, capability: string, reason: string) {
    super(`Session ${sessionId} does not support ${capability}: ${reason}`);
    this.name = 'CapabilityUnsupportedError';
    this.sessionId = sessionId;
    this.capability = capability;
    this.reason = reason;
  }
}

/** Thrown when an operation names a session we have never seen. */
export class UnknownSessionError extends Error {
  constructor(sessionId: string) {
    super(`Unknown session: ${sessionId}`);
    this.name = 'UnknownSessionError';
  }
}
