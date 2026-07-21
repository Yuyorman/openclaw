import { describe, expect, it } from "vitest";
import {
  consumeObservationLease,
  createInMemoryObservationLeaseStore,
  createObservationLease,
  type CreateObservationLeaseInput,
} from "./observation-lease.js";

function buildLeaseInput(overrides: Partial<CreateObservationLeaseInput> = {}): CreateObservationLeaseInput {
  return {
    leaseId: "lease-1",
    taskId: "task-1",
    checkpointId: "checkpoint-1",
    sessionBindingDigest: "sha256:session-digest",
    leaseTokenDigest: "sha256:token-digest",
    contractDigest: "sha256:contract-digest",
    configDigest: "sha256:config-digest",
    pluginRegistryDigest: "sha256:registry-digest",
    candidateChainDigest: "sha256:candidate-digest",
    ttlMs: 30_000,
    now: 1_000,
    ...overrides,
  };
}

describe("createObservationLease", () => {
  it("persists a pending, single-use lease with the requested TTL and digest bindings", () => {
    const store = createInMemoryObservationLeaseStore();

    const lease = createObservationLease(store, buildLeaseInput());

    expect(lease.state).toBe("pending");
    expect(lease.expiresAt).toBe(1_000 + 30_000);
    expect(lease.tokenConsumedAt).toBeUndefined();
    expect(lease.boundRunId).toBeUndefined();
    expect(lease.boundCallId).toBeUndefined();
    expect(store.findById("lease-1")).toMatchObject({
      contractDigest: "sha256:contract-digest",
      configDigest: "sha256:config-digest",
      pluginRegistryDigest: "sha256:registry-digest",
      candidateChainDigest: "sha256:candidate-digest",
    });
  });
});

describe("consumeObservationLease", () => {
  it("consumes the token exactly once", () => {
    const store = createInMemoryObservationLeaseStore();
    createObservationLease(store, buildLeaseInput());

    const result = consumeObservationLease(store, "lease-1", 1_500);

    expect(result).toEqual({ ok: true });
    expect(store.findById("lease-1")?.tokenConsumedAt).toBe(1_500);
  });

  it("rejects a replayed token with a stable error code", () => {
    const store = createInMemoryObservationLeaseStore();
    createObservationLease(store, buildLeaseInput());
    consumeObservationLease(store, "lease-1", 1_500);

    const replay = consumeObservationLease(store, "lease-1", 1_600);

    expect(replay).toEqual({ ok: false, code: "already_consumed" });
  });

  it("rejects consumption of an expired lease", () => {
    const store = createInMemoryObservationLeaseStore();
    createObservationLease(store, buildLeaseInput({ now: 1_000, ttlMs: 1_000 }));

    const result = consumeObservationLease(store, "lease-1", 2_500);

    expect(result).toEqual({ ok: false, code: "expired" });
  });

  it("rejects consumption of an unknown lease id", () => {
    const store = createInMemoryObservationLeaseStore();

    const result = consumeObservationLease(store, "missing-lease", 1_000);

    expect(result).toEqual({ ok: false, code: "not_found" });
  });

  it("does not change state or bind eligibility — token consumption and binding are independent", () => {
    const store = createInMemoryObservationLeaseStore();
    createObservationLease(store, buildLeaseInput());

    consumeObservationLease(store, "lease-1", 1_500);

    const lease = store.findById("lease-1");
    expect(lease?.state).toBe("pending");
    expect(store.findPendingBySessionBindingDigest("sha256:session-digest")).toMatchObject({
      leaseId: "lease-1",
    });
  });
});

describe("ObservationLeaseStore.compareAndSwap", () => {
  it("applies the patch and bumps rowVersion when the expected version matches", () => {
    const store = createInMemoryObservationLeaseStore();
    createObservationLease(store, buildLeaseInput());

    const applied = store.compareAndSwap("lease-1", 1, { state: "bound", boundRunId: "run-1" });

    expect(applied).toBe(true);
    expect(store.findById("lease-1")).toMatchObject({ state: "bound", boundRunId: "run-1", rowVersion: 2 });
  });

  it("rejects a stale rowVersion without mutating the stored lease", () => {
    const store = createInMemoryObservationLeaseStore();
    createObservationLease(store, buildLeaseInput());
    store.compareAndSwap("lease-1", 1, { state: "bound", boundRunId: "run-1" });

    const staleApplied = store.compareAndSwap("lease-1", 1, { state: "bound", boundRunId: "run-2" });

    expect(staleApplied).toBe(false);
    expect(store.findById("lease-1")).toMatchObject({ boundRunId: "run-1", rowVersion: 2 });
  });
});
