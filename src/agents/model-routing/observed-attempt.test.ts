import { describe, expect, it } from "vitest";
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
import { correlateModelCallEvent } from "./observed-attempt.js";

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
  return {
    ...buildStartedEvent(),
    durationMs: 1_200,
    outcome: "completed",
    ...overrides,
  };
}

const CTX: PluginHookAgentContext = { sessionKey: "session-1" };

function startedInput(
  overrides: Partial<
    Extract<Parameters<typeof correlateModelCallEvent>[1], { phase: "started" }>
  > = {},
) {
  return {
    phase: "started" as const,
    event: buildStartedEvent(),
    ctx: CTX,
    sessionBindingDigest: SESSION_DIGEST,
    configDigest: CONFIG_DIGEST,
    pluginRegistryDigest: REGISTRY_DIGEST,
    candidateChainDigest: CANDIDATE_CHAIN_DIGEST,
    now: 1_500,
    ...overrides,
  };
}

function endedInput(
  eventOverrides: Partial<PluginHookModelCallEndedEvent> = {},
  now = 2_000,
  digestOverrides: Partial<{
    configDigest: string;
    pluginRegistryDigest: string;
    candidateChainDigest: string;
  }> = {},
) {
  return {
    phase: "ended" as const,
    event: buildEndedEvent(eventOverrides),
    ctx: CTX,
    configDigest: CONFIG_DIGEST,
    pluginRegistryDigest: REGISTRY_DIGEST,
    candidateChainDigest: CANDIDATE_CHAIN_DIGEST,
    now,
    ...digestOverrides,
  };
}

function setUpBoundLease(store: ObservationLeaseStore) {
  createObservationLease(store, buildLeaseInput());
  correlateModelCallEvent(store, startedInput());
}

describe("correlateModelCallEvent — started", () => {
  it("no-ops for a normal session with no active lease", () => {
    const store = createInMemoryObservationLeaseStore();

    const result = correlateModelCallEvent(store, startedInput());

    expect(result).toBeUndefined();
  });

  it("CAS-binds the first runId/callId to a pending, unexpired, digest-matching lease", () => {
    const store = createInMemoryObservationLeaseStore();
    createObservationLease(store, buildLeaseInput());

    const result = correlateModelCallEvent(store, startedInput());

    expect(result).toBeUndefined();
    expect(store.findById("lease-1")).toMatchObject({
      state: "bound",
      boundRunId: "run-1",
      boundCallId: "call-1",
    });
  });

  it("does not let a second concurrent call preempt an already-bound lease", () => {
    const store = createInMemoryObservationLeaseStore();
    setUpBoundLease(store);

    const second = correlateModelCallEvent(
      store,
      startedInput({ event: buildStartedEvent({ runId: "run-2", callId: "call-2" }) }),
    );

    expect(second).toBeUndefined();
    expect(store.findById("lease-1")).toMatchObject({ boundRunId: "run-1", boundCallId: "call-1" });
  });

  it("marks an expired lease partial instead of binding it", () => {
    const store = createInMemoryObservationLeaseStore();
    createObservationLease(store, buildLeaseInput({ now: 1_000, ttlMs: 100 }));

    const result = correlateModelCallEvent(store, startedInput({ now: 5_000 }));

    expect(result).toMatchObject({
      observationCompleteness: "partial",
      observationCoverage: "hook-covered",
    });
    expect(store.findById("lease-1")?.state).toBe("partial");
  });

  it("marks a lease partial when any bound snapshot digest has drifted", () => {
    const store = createInMemoryObservationLeaseStore();
    createObservationLease(store, buildLeaseInput());

    const result = correlateModelCallEvent(
      store,
      startedInput({ candidateChainDigest: "sha256:different-candidate-digest" }),
    );

    expect(result).toMatchObject({
      observationCompleteness: "partial",
      observationCoverage: "hook-covered",
    });
    expect(store.findById("lease-1")?.state).toBe("partial");
  });
});

describe("correlateModelCallEvent — ended", () => {
  it("completes the observation for a bound lease and reports full attempt fields", () => {
    const store = createInMemoryObservationLeaseStore();
    setUpBoundLease(store);

    const result = correlateModelCallEvent(store, endedInput());

    expect(result).toEqual({
      runId: "run-1",
      callId: "call-1",
      provider: "anthropic",
      model: "claude-sonnet-5",
      api: "messages",
      transport: "https",
      contextTokenBudget: 200_000,
      contextWindowSource: "model",
      observationCompleteness: "complete",
      observationCoverage: "hook-covered",
    });
    expect(store.findById("lease-1")?.state).toBe("complete");
  });

  it("no-ops for a call with no matching bound lease (normal session, out of this correlator's scope)", () => {
    const store = createInMemoryObservationLeaseStore();

    const result = correlateModelCallEvent(store, endedInput({ runId: "unrelated-run" }));

    expect(result).toBeUndefined();
  });

  it("marks partial instead of complete when the live digest has drifted since bind", () => {
    const store = createInMemoryObservationLeaseStore();
    setUpBoundLease(store);

    const result = correlateModelCallEvent(
      store,
      endedInput({}, 2_000, { candidateChainDigest: "sha256:different-candidate-digest" }),
    );

    expect(result).toMatchObject({
      observationCompleteness: "partial",
      observationCoverage: "hook-covered",
    });
    expect(store.findById("lease-1")?.state).toBe("partial");
  });

  it("always reports hook-covered — out-of-scope classification is the caller's absence-of-event concern", () => {
    const store = createInMemoryObservationLeaseStore();
    setUpBoundLease(store);

    const result = correlateModelCallEvent(store, endedInput());

    expect(result?.observationCoverage).toBe("hook-covered");
  });
});
