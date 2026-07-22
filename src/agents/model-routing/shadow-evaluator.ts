/**
 * Pure in-gateway theoretical route evaluation: given the current model-level
 * candidate chain and their capability snapshots, reports which candidate
 * would be selected under the task contract. Never calls models, tools, or
 * any live routing/auth machinery, and never mutates its inputs — persisting
 * the result is the caller's job (see route-attempt-observer.ts/service.ts).
 */
import type { NormalizedTaskContract } from "../../tasks/safety/contracts.js";
import {
  evaluateCandidateAdmission,
  type CandidateAdmissionDecision,
  type ModelRoutingAdmissionPolicy,
} from "./candidate-admission.js";
import type { ModelCapabilitySnapshot } from "./capability-snapshot.js";

export type ShadowRouteCandidate = { provider: string; model: string };

export type ShadowRouteAttempt = {
  ordinal: number;
  provider: string;
  model: string;
  decision: CandidateAdmissionDecision;
};

export type EvaluateShadowRouteInput = {
  contract: NormalizedTaskContract;
  /** The live gateway process's current model-level candidate chain (already resolved by the caller via `resolveModelCandidateChain`). */
  candidates: readonly ShadowRouteCandidate[];
  /** One capability snapshot per distinct (provider, model) candidate; a missing one is reported as ineligible, not skipped. */
  snapshots: readonly ModelCapabilitySnapshot[];
  policy: ModelRoutingAdmissionPolicy;
};

export type EvaluateShadowRouteResult = {
  routingPolicyVersion: string;
  theoreticalChoice?: ShadowRouteCandidate;
  attempts: ShadowRouteAttempt[];
};

/** Length-prefixes `provider` so no two distinct (provider, model) pairs can ever collide, even when either contains the delimiter. */
export function candidateKey(provider: string, model: string): string {
  return `${provider.length}:${provider}:${model}`;
}

/**
 * Evaluates each distinct model-level candidate once, in the caller-supplied
 * order, and reports the first eligible one as the theoretical choice.
 */
export function evaluateShadowRoute(input: EvaluateShadowRouteInput): EvaluateShadowRouteResult {
  const snapshotsByKey = new Map<string, ModelCapabilitySnapshot>();
  for (const snapshot of input.snapshots) {
    snapshotsByKey.set(candidateKey(snapshot.provider, snapshot.model), snapshot);
  }

  const seen = new Set<string>();
  const attempts: ShadowRouteAttempt[] = [];
  let theoreticalChoice: ShadowRouteCandidate | undefined;
  let ordinal = 0;
  for (const candidate of input.candidates) {
    const key = candidateKey(candidate.provider, candidate.model);
    if (seen.has(key)) {
      // Phase 1 records each model-level (provider, model) candidate once per task/checkpoint.
      continue;
    }
    seen.add(key);

    const snapshot = snapshotsByKey.get(key);
    const decision: CandidateAdmissionDecision = snapshot
      ? evaluateCandidateAdmission(input.contract, snapshot, input.policy)
      : {
          outcome: "ineligible",
          code: "CAPABILITY_UNVERIFIED",
          reason: "No capability snapshot is available for this candidate",
        };
    attempts.push({ ordinal, provider: candidate.provider, model: candidate.model, decision });
    ordinal += 1;
    if (!theoreticalChoice && decision.outcome === "eligible") {
      theoreticalChoice = { provider: candidate.provider, model: candidate.model };
    }
  }

  return { routingPolicyVersion: input.contract.routingPolicyVersion, theoreticalChoice, attempts };
}
