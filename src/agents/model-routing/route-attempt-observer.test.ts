import { describe, expect, it, vi } from "vitest";
import type {
  PluginHookAgentContext,
  PluginHookModelCallEndedEvent,
  PluginHookModelCallStartedEvent,
} from "../../plugins/hook-types.js";
import {
  createInMemoryObservationLeaseStore,
  createObservationLease,
  type CreateObservationLeaseInput,
  type ObservationLeaseStore,
} from "../../tasks/safety/observation-lease.js";
import {
  recordObservedModelAttempt,
  type RouteAttemptObserverDeps,
} from "./route-attempt-observer.js";

const SESSION_DIGEST = "sha256:session-digest";
const CONFIG_DIGEST = "sha256:config-digest";
const REGISTRY_DIGEST = "sha256:registry-digest";
const CANDIDATE_CHAIN_DIGEST = "sha256:candidate-digest";

function buildLeaseInput(
  overrides: Partial<CreateObservationLeaseInput> = {},
): CreateObservationLeaseInput {
  return {
    leaseId: "lease-1",
    taskId: "task-1",
    checkpointId: "checkpoint-1",
    sessionBindingDigest: SESSION_DIGEST,
    leaseTokenDigest: "sha256:token-digest",
    contractDigest: "sha256:contract-digest",
    configDigest: CONFIG_DIGEST,
    pluginRegistryDigest: REGISTRY_DIGEST,
    candidateChainDigest: CANDIDATE_CHAIN_DIGEST,
    ttlMs: 30_000,
    now: 1_000,
    ...overrides,
  };
}

function buildStartedEvent(
  overrides: Partial<PluginHookModelCallStartedEvent> = {},
): PluginHookModelCallStartedEvent {
  return {
    runId: "run-1",
    callId: "call-1",
    sessionKey: "session-1",
    provider: "anthropic",
    model: "claude-sonnet-5",
    api: "messages",
    transport: "https",
    contextTokenBudget: 200_000,
    contextWindowSource: "model",
    ...overrides,
  };
}

function buildEndedEvent(
  overrides: Partial<PluginHookModelCallEndedEvent> = {},
): PluginHookModelCallEndedEvent {
  return { ...buildStartedEvent(), durationMs: 1_200, outcome: "completed", ...overrides };
}

const CTX: PluginHookAgentContext = { sessionKey: "session-1" };

function startedInput(overrides: Partial<PluginHookModelCallStartedEvent> = {}, now = 1_500) {
  return {
    phase: "started" as const,
    event: buildStartedEvent(overrides),
    ctx: CTX,
    sessionBindingDigest: SESSION_DIGEST,
    configDigest: CONFIG_DIGEST,
    pluginRegistryDigest: REGISTRY_DIGEST,
    candidateChainDigest: CANDIDATE_CHAIN_DIGEST,
    now,
  };
}

function endedInput(overrides: Partial<PluginHookModelCallEndedEvent> = {}, now = 2_000) {
  return {
    phase: "ended" as const,
    event: buildEndedEvent(overrides),
    ctx: CTX,
    configDigest: CONFIG_DIGEST,
    pluginRegistryDigest: REGISTRY_DIGEST,
    candidateChainDigest: CANDIDATE_CHAIN_DIGEST,
    now,
  };
}

type FakeAttempt = {
  attemptId: string;
  provider: string;
  model: string;
  observationCompleteness: string;
  observationCoverage: string;
  runId?: string;
  callId?: string;
};

function createFakeDeps(leaseStore: ObservationLeaseStore) {
  const attempts = new Map<string, FakeAttempt>([
    [
      "attempt-1",
      {
        attemptId: "attempt-1",
        provider: "anthropic",
        model: "claude-sonnet-5",
        observationCompleteness: "unavailable",
        observationCoverage: "out-of-scope",
      },
    ],
  ]);
  const updateCalls: Array<{ attemptId: string; patch: Record<string, unknown> }> = [];

  const deps: RouteAttemptObserverDeps = {
    leaseStore,
    listRouteAttempts: vi.fn((_taskId: string, _checkpointId: string) => [...attempts.values()]),
    updateRouteAttemptObservation: vi.fn((attemptId: string, patch) => {
      updateCalls.push({ attemptId, patch });
      const existing = attempts.get(attemptId);
      if (!existing) {
        return false;
      }
      attempts.set(attemptId, { ...existing, ...patch });
      return true;
    }),
  };

  return { deps, attempts, updateCalls };
}

describe("recordObservedModelAttempt", () => {
  it("does not persist anything for a normal session with no active lease", async () => {
    const store = createInMemoryObservationLeaseStore();
    const { deps, updateCalls } = createFakeDeps(store);

    await recordObservedModelAttempt(deps, startedInput());
    await recordObservedModelAttempt(deps, endedInput());

    expect(updateCalls).toEqual([]);
  });

  it("silently binds on a matching started event, then persists complete once ended arrives", async () => {
    const store = createInMemoryObservationLeaseStore();
    createObservationLease(store, buildLeaseInput());
    const { deps, attempts, updateCalls } = createFakeDeps(store);

    await recordObservedModelAttempt(deps, startedInput());
    expect(updateCalls).toEqual([]); // still awaiting the ended pairing, nothing written yet

    await recordObservedModelAttempt(deps, endedInput());

    expect(updateCalls).toHaveLength(1);
    expect(attempts.get("attempt-1")).toMatchObject({
      runId: "run-1",
      callId: "call-1",
      observationCompleteness: "complete",
      observationCoverage: "hook-covered",
    });
  });

  it("maps provider/model/runId/callId fields completely onto the updated attempt", async () => {
    const store = createInMemoryObservationLeaseStore();
    createObservationLease(store, buildLeaseInput());
    const { deps, updateCalls } = createFakeDeps(store);
    await recordObservedModelAttempt(deps, startedInput());

    await recordObservedModelAttempt(deps, endedInput());

    expect(updateCalls[0]).toEqual({
      attemptId: "attempt-1",
      patch: {
        runId: "run-1",
        callId: "call-1",
        observationCompleteness: "complete",
        observationCoverage: "hook-covered",
      },
    });
  });

  it("marks the attempt partial when the started event arrives after the lease has expired", async () => {
    const store = createInMemoryObservationLeaseStore();
    createObservationLease(store, buildLeaseInput({ now: 1_000, ttlMs: 100 }));
    const { deps, attempts } = createFakeDeps(store);

    await recordObservedModelAttempt(deps, startedInput({}, 5_000));

    expect(attempts.get("attempt-1")).toMatchObject({
      observationCompleteness: "partial",
      observationCoverage: "hook-covered",
    });
  });

  it("marks the attempt partial when the started event's digests have drifted from the lease", async () => {
    const store = createInMemoryObservationLeaseStore();
    createObservationLease(store, buildLeaseInput());
    const { deps, attempts } = createFakeDeps(store);

    await recordObservedModelAttempt(deps, {
      ...startedInput(),
      candidateChainDigest: "sha256:different-candidate-digest",
    });

    expect(attempts.get("attempt-1")).toMatchObject({
      observationCompleteness: "partial",
      observationCoverage: "hook-covered",
    });
  });

  it("does not double-write for a duplicate ended event (idempotent: the second event's lease lookup already misses)", async () => {
    const store = createInMemoryObservationLeaseStore();
    createObservationLease(store, buildLeaseInput());
    const { deps, updateCalls } = createFakeDeps(store);
    await recordObservedModelAttempt(deps, startedInput());
    await recordObservedModelAttempt(deps, endedInput());
    expect(updateCalls).toHaveLength(1);

    await recordObservedModelAttempt(deps, endedInput());

    expect(updateCalls).toHaveLength(1);
    expect(deps.updateRouteAttemptObservation).toHaveBeenCalledTimes(1);
  });

  it("resolves without throwing when the route attempt lookup fails, leaving no unhandled rejection", async () => {
    const store = createInMemoryObservationLeaseStore();
    createObservationLease(store, buildLeaseInput());
    const { deps } = createFakeDeps(store);
    await recordObservedModelAttempt(deps, startedInput());
    deps.listRouteAttempts = vi.fn(() => {
      throw new Error("boom: lookup failed");
    });

    await expect(recordObservedModelAttempt(deps, endedInput())).resolves.toBeUndefined();
  });

  it("resolves without throwing when persisting the update fails", async () => {
    const store = createInMemoryObservationLeaseStore();
    createObservationLease(store, buildLeaseInput());
    const { deps } = createFakeDeps(store);
    await recordObservedModelAttempt(deps, startedInput());
    deps.updateRouteAttemptObservation = vi.fn(() => {
      throw new Error("boom: write failed");
    });

    await expect(recordObservedModelAttempt(deps, endedInput())).resolves.toBeUndefined();
  });

  it("leaves an unmatched candidate's route attempt untouched (no theoretical row for this provider/model)", async () => {
    const store = createInMemoryObservationLeaseStore();
    createObservationLease(
      store,
      buildLeaseInput({ leaseId: "lease-2", sessionBindingDigest: "sha256:other-session" }),
    );
    const { deps, updateCalls } = createFakeDeps(store);

    await recordObservedModelAttempt(deps, {
      ...startedInput({ provider: "openai", model: "gpt-5.4" }),
      sessionBindingDigest: "sha256:other-session",
    });
    await recordObservedModelAttempt(deps, endedInput({ provider: "openai", model: "gpt-5.4" }));

    expect(updateCalls).toEqual([]);
  });
});
