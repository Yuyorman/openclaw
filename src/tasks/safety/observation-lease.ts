/**
 * Shadow observation lease domain logic. Pure, injectable-store logic only —
 * no SQLite or gateway method wiring here (see Task 3 for persistence, Task 5/6
 * for live-gateway authentication and hook wiring).
 */

export type ObservationLeaseState = "pending" | "bound" | "complete" | "partial";

export type ObservationLease = {
  leaseId: string;
  taskId: string;
  checkpointId: string;
  /** Digest of the caller's resolved session binding; the raw session key/ref is never stored. */
  sessionBindingDigest: string;
  /** Digest of the one-time bearer lease token; the raw token is never stored. */
  leaseTokenDigest: string;
  contractDigest: string;
  configDigest: string;
  pluginRegistryDigest: string;
  candidateChainDigest: string;
  expiresAt: number;
  state: ObservationLeaseState;
  tokenConsumedAt?: number;
  boundRunId?: string;
  boundCallId?: string;
  rowVersion: number;
};

export type ObservationLeasePatch = Partial<
  Pick<ObservationLease, "state" | "tokenConsumedAt" | "boundRunId" | "boundCallId">
>;

export type ObservationLeaseStore = {
  insert(lease: ObservationLease): void;
  findById(leaseId: string): ObservationLease | undefined;
  /** Only ever matches leases still awaiting their first bind. */
  findPendingBySessionBindingDigest(
    sessionBindingDigest: string,
  ): ObservationLease | undefined;
  findBoundByRunAndCall(runId: string, callId: string): ObservationLease | undefined;
  /** Applies `patch` and bumps rowVersion iff the stored rowVersion still equals `expectedRowVersion`. */
  compareAndSwap(
    leaseId: string,
    expectedRowVersion: number,
    patch: ObservationLeasePatch,
  ): boolean;
};

export function createInMemoryObservationLeaseStore(): ObservationLeaseStore {
  const leasesById = new Map<string, ObservationLease>();

  return {
    insert(lease) {
      leasesById.set(lease.leaseId, { ...lease });
    },
    findById(leaseId) {
      const lease = leasesById.get(leaseId);
      return lease ? { ...lease } : undefined;
    },
    findPendingBySessionBindingDigest(sessionBindingDigest) {
      for (const lease of leasesById.values()) {
        if (lease.state === "pending" && lease.sessionBindingDigest === sessionBindingDigest) {
          return { ...lease };
        }
      }
      return undefined;
    },
    findBoundByRunAndCall(runId, callId) {
      for (const lease of leasesById.values()) {
        if (lease.state === "bound" && lease.boundRunId === runId && lease.boundCallId === callId) {
          return { ...lease };
        }
      }
      return undefined;
    },
    compareAndSwap(leaseId, expectedRowVersion, patch) {
      const current = leasesById.get(leaseId);
      if (!current || current.rowVersion !== expectedRowVersion) {
        return false;
      }
      leasesById.set(leaseId, { ...current, ...patch, rowVersion: current.rowVersion + 1 });
      return true;
    },
  };
}

export type CreateObservationLeaseInput = {
  leaseId: string;
  taskId: string;
  checkpointId: string;
  sessionBindingDigest: string;
  leaseTokenDigest: string;
  contractDigest: string;
  configDigest: string;
  pluginRegistryDigest: string;
  candidateChainDigest: string;
  ttlMs: number;
  now: number;
};

/** Persists a new pending, single-use observation lease with a short TTL. */
export function createObservationLease(
  store: ObservationLeaseStore,
  input: CreateObservationLeaseInput,
): ObservationLease {
  const lease: ObservationLease = {
    leaseId: input.leaseId,
    taskId: input.taskId,
    checkpointId: input.checkpointId,
    sessionBindingDigest: input.sessionBindingDigest,
    leaseTokenDigest: input.leaseTokenDigest,
    contractDigest: input.contractDigest,
    configDigest: input.configDigest,
    pluginRegistryDigest: input.pluginRegistryDigest,
    candidateChainDigest: input.candidateChainDigest,
    expiresAt: input.now + input.ttlMs,
    state: "pending",
    rowVersion: 1,
  };
  store.insert(lease);
  return lease;
}

export type ConsumeObservationLeaseErrorCode = "not_found" | "expired" | "already_consumed";

export type ConsumeObservationLeaseResult =
  | { ok: true }
  | { ok: false; code: ConsumeObservationLeaseErrorCode };

/**
 * Consumes the lease's one-time bearer token. This only terminates token
 * replay; it is independent of `state`/bind eligibility (see module docs on
 * the two independent lifecycles) and never mutates those fields.
 */
export function consumeObservationLease(
  store: ObservationLeaseStore,
  leaseId: string,
  now: number,
): ConsumeObservationLeaseResult {
  const lease = store.findById(leaseId);
  if (!lease) {
    return { ok: false, code: "not_found" };
  }
  if (lease.tokenConsumedAt !== undefined) {
    return { ok: false, code: "already_consumed" };
  }
  if (now >= lease.expiresAt) {
    return { ok: false, code: "expired" };
  }
  const applied = store.compareAndSwap(leaseId, lease.rowVersion, { tokenConsumedAt: now });
  if (!applied) {
    // Lost the race to a concurrent consumer; token replay is what we guard against.
    return { ok: false, code: "already_consumed" };
  }
  return { ok: true };
}
