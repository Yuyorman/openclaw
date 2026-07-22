/**
 * Correlates real gateway `model_call_started`/`model_call_ended` typed hook
 * events against pending observation leases, producing best-effort
 * `ObservedModelAttempt` facts. Pure domain logic over an injectable lease
 * store — no SQLite or gateway wiring here (see Task 3/5/6).
 */
import type {
  PluginHookAgentContext,
  PluginHookModelCallEndedEvent,
  PluginHookModelCallStartedEvent,
} from "../../plugins/hook-types.js";
import type {
  ObservationLease,
  ObservationLeaseStore,
} from "../../tasks/safety/observation-lease.js";

export type ObservationCompleteness = "complete" | "partial" | "unavailable";
export type ObservationCoverage = "hook-covered" | "out-of-scope";

/** Phase 1's faithful observation boundary: model-level call facts only. */
export type ObservedModelAttempt = {
  runId: string;
  callId: string;
  provider: string;
  model: string;
  api?: string;
  transport?: string;
  contextTokenBudget?: number;
  contextWindowSource?: string;
  observationCompleteness: ObservationCompleteness;
  observationCoverage: ObservationCoverage;
};

export type CorrelateModelCallEventInput =
  | {
      phase: "started";
      event: PluginHookModelCallStartedEvent;
      ctx: PluginHookAgentContext;
      sessionBindingDigest: string;
      configDigest: string;
      pluginRegistryDigest: string;
      candidateChainDigest: string;
      now: number;
    }
  | {
      phase: "ended";
      event: PluginHookModelCallEndedEvent;
      ctx: PluginHookAgentContext;
      configDigest: string;
      pluginRegistryDigest: string;
      candidateChainDigest: string;
      now: number;
    };

function baseAttemptFields(
  event: PluginHookModelCallStartedEvent | PluginHookModelCallEndedEvent,
): Pick<
  ObservedModelAttempt,
  | "runId"
  | "callId"
  | "provider"
  | "model"
  | "api"
  | "transport"
  | "contextTokenBudget"
  | "contextWindowSource"
> {
  return {
    runId: event.runId,
    callId: event.callId,
    provider: event.provider,
    model: event.model,
    ...(event.api !== undefined ? { api: event.api } : {}),
    ...(event.transport !== undefined ? { transport: event.transport } : {}),
    ...(event.contextTokenBudget !== undefined
      ? { contextTokenBudget: event.contextTokenBudget }
      : {}),
    ...(event.contextWindowSource !== undefined
      ? { contextWindowSource: event.contextWindowSource }
      : {}),
  };
}

function correlateStarted(
  store: ObservationLeaseStore,
  input: Extract<CorrelateModelCallEventInput, { phase: "started" }>,
): ObservedModelAttempt | undefined {
  const lease = store.findPendingBySessionBindingDigest(input.sessionBindingDigest);
  if (!lease) {
    // Normal session with no active lease: existing empty-hook-check path, no safety facts written.
    return undefined;
  }

  if (input.now >= lease.expiresAt) {
    store.compareAndSwap(lease.leaseId, lease.rowVersion, { state: "partial" });
    return {
      ...baseAttemptFields(input.event),
      observationCompleteness: "partial",
      observationCoverage: "hook-covered",
    };
  }

  const digestsMatch = leaseDigestsMatch(lease, input);
  if (!digestsMatch) {
    store.compareAndSwap(lease.leaseId, lease.rowVersion, { state: "partial" });
    return {
      ...baseAttemptFields(input.event),
      observationCompleteness: "partial",
      observationCoverage: "hook-covered",
    };
  }

  // CAS-bind the first runId/callId. A losing CAS means a concurrent call already
  // bound this lease first; this call correctly does nothing further (no preemption).
  store.compareAndSwap(lease.leaseId, lease.rowVersion, {
    state: "bound",
    boundRunId: input.event.runId,
    boundCallId: input.event.callId,
  });
  return undefined;
}

type LeaseDigests = Pick<
  ObservationLease,
  "configDigest" | "pluginRegistryDigest" | "candidateChainDigest"
>;

function leaseDigestsMatch(lease: ObservationLease, input: LeaseDigests): boolean {
  return (
    input.configDigest === lease.configDigest &&
    input.pluginRegistryDigest === lease.pluginRegistryDigest &&
    input.candidateChainDigest === lease.candidateChainDigest
  );
}

/**
 * A bound lease's `ended` pairing must recheck live digests: the call may
 * have run long enough for config/plugins/candidates to drift after `started`
 * verified them, and a stale-but-since-reverted live state must not launder
 * the attempt back to `complete` (see module docs on the two independent
 * digest checkpoints).
 */
function correlateEnded(
  store: ObservationLeaseStore,
  input: Extract<CorrelateModelCallEventInput, { phase: "ended" }>,
): ObservedModelAttempt | undefined {
  const lease = store.findBoundByRunAndCall(input.event.runId, input.event.callId);
  if (!lease) {
    // No lease was ever bound to this call: out of this correlator's scope.
    return undefined;
  }

  const digestsMatch = leaseDigestsMatch(lease, input);
  const completeness: ObservationCompleteness = digestsMatch ? "complete" : "partial";
  store.compareAndSwap(lease.leaseId, lease.rowVersion, {
    state: digestsMatch ? "complete" : "partial",
  });
  return {
    ...baseAttemptFields(input.event),
    observationCompleteness: completeness,
    observationCoverage: "hook-covered",
  };
}

/**
 * Correlates one `model_call_started`/`model_call_ended` hook event against
 * the injected lease store. Returns an `ObservedModelAttempt` only when this
 * event resolves a lease to a terminal-for-now classification (bound-early
 * partial, or completed); returns `undefined` for normal sessions and for a
 * successful bind still awaiting its `ended` pairing.
 */
export function correlateModelCallEvent(
  store: ObservationLeaseStore,
  input: CorrelateModelCallEventInput,
): ObservedModelAttempt | undefined {
  if (input.phase === "started") {
    return correlateStarted(store, input);
  }
  return correlateEnded(store, input);
}
