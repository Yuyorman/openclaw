/** Fail-closed signal for a recovery dispatch capability that cannot be replayed. */
export class MainRunRecoveryOwnershipLostError extends Error {
  constructor(message = "main-run recovery dispatch lost ownership") {
    super(message);
    this.name = "MainRunRecoveryOwnershipLostError";
  }
}

export function isMainRunRecoveryOwnershipLostError(
  error: unknown,
): error is MainRunRecoveryOwnershipLostError {
  return (
    error instanceof MainRunRecoveryOwnershipLostError ||
    (error instanceof Error && error.name === "MainRunRecoveryOwnershipLostError")
  );
}
