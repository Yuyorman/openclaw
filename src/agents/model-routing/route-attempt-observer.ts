/**
 * Fire-and-forget adapter bridging real `model_call_started`/`model_call_ended`
 * hook events to persisted route attempt observations. Independent of
 * shadow-evaluator.ts (pure evaluation) and observed-attempt.ts (pure
 * correlation) — this is the only layer that touches storage, and it must
 * never let a persistence failure surface as an unhandled rejection. A route
 * attempt is created by the evaluator with `observationCompleteness:
 * "unavailable"`; if this observer never successfully updates it, that
 * initial value is already the correct terminal fact — no separate
 * failure-path write is needed.
 */
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type {
  ObservationLease,
  ObservationLeaseStore,
} from "../../tasks/safety/observation-lease.js";
import { correlateModelCallEvent, type CorrelateModelCallEventInput } from "./observed-attempt.js";

const log = createSubsystemLogger("agents.model-routing.route-attempt-observer");

export type RouteAttemptObserverDeps = {
  leaseStore: ObservationLeaseStore;
  listRouteAttempts(
    taskId: string,
    checkpointId: string,
  ): ReadonlyArray<{ attemptId: string; provider: string; model: string }>;
  updateRouteAttemptObservation(
    attemptId: string,
    patch: {
      runId?: string;
      callId?: string;
      observationCompleteness: string;
      observationCoverage: string;
    },
  ): boolean;
};

/**
 * Looks up the lease this event would correlate against, before calling
 * `correlateModelCallEvent` mutates its state — the lease's task/checkpoint
 * id is needed to locate the matching route attempt row, and a lookup taken
 * after the CAS transition (pending→bound, bound→complete) would miss it.
 */
function findLeaseForInput(
  leaseStore: ObservationLeaseStore,
  input: CorrelateModelCallEventInput,
): ObservationLease | undefined {
  if (input.phase === "started") {
    return leaseStore.findPendingBySessionBindingDigest(input.sessionBindingDigest);
  }
  return leaseStore.findBoundByRunAndCall(input.event.runId, input.event.callId);
}

/**
 * Correlates one hook event and, when it resolves to a terminal-for-now
 * observation, persists it against the matching route attempt row. Never
 * throws and never rejects: failures are logged, leaving the attempt at
 * whatever observation state it already had.
 */
export async function recordObservedModelAttempt(
  deps: RouteAttemptObserverDeps,
  input: CorrelateModelCallEventInput,
): Promise<void> {
  try {
    const lease = findLeaseForInput(deps.leaseStore, input);
    const observed = correlateModelCallEvent(deps.leaseStore, input);
    if (!observed || !lease) {
      return;
    }

    const attempt = deps
      .listRouteAttempts(lease.taskId, lease.checkpointId)
      .find(
        (candidate) =>
          candidate.provider === observed.provider && candidate.model === observed.model,
      );
    if (!attempt) {
      // No theoretical route attempt row exists for this candidate: out of this observer's scope.
      return;
    }

    const wrote = deps.updateRouteAttemptObservation(attempt.attemptId, {
      ...(observed.runId !== undefined ? { runId: observed.runId } : {}),
      ...(observed.callId !== undefined ? { callId: observed.callId } : {}),
      observationCompleteness: observed.observationCompleteness,
      observationCoverage: observed.observationCoverage,
    });
    if (!wrote) {
      log.warn("Route attempt observation update affected no rows", {
        attemptId: attempt.attemptId,
      });
    }
  } catch (error) {
    log.warn("Failed to record observed model attempt", { error });
  }
}
