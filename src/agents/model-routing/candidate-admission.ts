/**
 * Evaluates whether a model candidate's capability snapshot admits it for a
 * task contract's required capabilities. Pure, no I/O, no model/tool calls.
 */
import type {
  NormalizedTaskContract,
  TaskContractDecisionGrade,
} from "../../tasks/safety/contracts.js";
import type { ModelCapabilitySnapshot } from "./capability-snapshot.js";

export type CandidateAdmissionIneligibleCode =
  | "MODALITY"
  | "CONTEXT"
  | "OUTPUT"
  | "TOOLS"
  | "STRUCTURED_OUTPUT"
  | "RUNTIME"
  | "DATA_POLICY"
  | "DECISION_GRADE"
  | "CAPABILITY_UNVERIFIED";

export type CandidateAdmissionDecision =
  | { outcome: "eligible" }
  | { outcome: "ineligible"; code: CandidateAdmissionIneligibleCode; reason: string };

export type ModelRoutingAdmissionPolicy = {
  approvedProviders: string[];
};

/** Phase 1's sole recognized local (data-never-leaves-the-machine) provider API adapter. */
const LOCAL_ONLY_APIS = new Set<string>(["ollama"]);

const DECISION_GRADE_ORDER: Record<TaskContractDecisionGrade, number> = {
  draft: 0,
  analysis: 1,
  decision: 2,
  final: 3,
};

function ineligible(
  code: CandidateAdmissionIneligibleCode,
  reason: string,
): CandidateAdmissionDecision {
  return { outcome: "ineligible", code, reason };
}

/** Evaluates static admission for one candidate; never calls models, tools, or auth resolvers. */
export function evaluateCandidateAdmission(
  contract: NormalizedTaskContract,
  snapshot: ModelCapabilitySnapshot,
  policy: ModelRoutingAdmissionPolicy,
): CandidateAdmissionDecision {
  const required = contract.requiredCapabilities;

  if (required.modalities.length > 0) {
    if (snapshot.modalities.verification === "contradicted") {
      return ineligible(
        "CAPABILITY_UNVERIFIED",
        "Candidate modalities are contradicted between configuration and observed evidence",
      );
    }
    if (
      snapshot.modalities.verification === "unverified" ||
      snapshot.modalities.value === undefined
    ) {
      return ineligible("MODALITY", "Candidate modalities are unverified");
    }
    const supported = new Set(snapshot.modalities.value);
    const missing = required.modalities.filter((modality) => !supported.has(modality));
    if (missing.length > 0) {
      return ineligible(
        "MODALITY",
        `Candidate does not support required modalities: ${missing.join(", ")}`,
      );
    }
  }

  if (snapshot.contextWindowTokens.verification === "contradicted") {
    return ineligible(
      "CAPABILITY_UNVERIFIED",
      "Candidate context window is contradicted between configuration and observed evidence",
    );
  }
  if (snapshot.contextWindowTokens.value === undefined) {
    return ineligible("CONTEXT", "Candidate context window is unverified");
  }
  if (snapshot.contextWindowTokens.value < required.minContextWindowTokens) {
    return ineligible(
      "CONTEXT",
      `Candidate context window ${snapshot.contextWindowTokens.value} is below required ${required.minContextWindowTokens}`,
    );
  }

  if (snapshot.outputTokens.verification === "contradicted") {
    return ineligible(
      "CAPABILITY_UNVERIFIED",
      "Candidate output token limit is contradicted between configuration and observed evidence",
    );
  }
  if (snapshot.outputTokens.value === undefined) {
    return ineligible("OUTPUT", "Candidate output token limit is unverified");
  }
  if (snapshot.outputTokens.value < required.minOutputTokens) {
    return ineligible(
      "OUTPUT",
      `Candidate output limit ${snapshot.outputTokens.value} is below required ${required.minOutputTokens}`,
    );
  }

  if (required.toolCalling) {
    if (snapshot.toolCalling.verification === "contradicted") {
      return ineligible(
        "CAPABILITY_UNVERIFIED",
        "Candidate tool calling is contradicted between configuration and observed evidence",
      );
    }
    if (snapshot.toolCalling.value !== true) {
      return ineligible("TOOLS", "Candidate tool calling is not a verified true");
    }
  }

  if (required.structuredOutput) {
    if (snapshot.structuredOutput.verification === "contradicted") {
      return ineligible(
        "CAPABILITY_UNVERIFIED",
        "Candidate structured output is contradicted between configuration and observed evidence",
      );
    }
    if (snapshot.structuredOutput.value !== true) {
      return ineligible("STRUCTURED_OUTPUT", "Candidate structured output is not a verified true");
    }
  }

  if (required.runtimeIds && required.runtimeIds.length > 0) {
    return ineligible("RUNTIME", "Phase 1 does not resolve a verified candidate runtime id");
  }

  if (required.dataPolicy === "approved-providers") {
    if (!policy.approvedProviders.includes(snapshot.provider)) {
      return ineligible(
        "DATA_POLICY",
        `Provider ${snapshot.provider} is not in the approved-providers allowlist`,
      );
    }
  } else if (snapshot.api.value === undefined || !LOCAL_ONLY_APIS.has(snapshot.api.value)) {
    return ineligible(
      "DATA_POLICY",
      `Candidate api ${snapshot.api.value ?? "unverified"} is not a recognized local-only runtime`,
    );
  }

  if (
    snapshot.authorizedDecisionGrade.value === undefined ||
    DECISION_GRADE_ORDER[snapshot.authorizedDecisionGrade.value] <
      DECISION_GRADE_ORDER[contract.minimumDecisionGrade]
  ) {
    return ineligible(
      "DECISION_GRADE",
      `Candidate is authorized up to decisionGrade ${snapshot.authorizedDecisionGrade.value ?? "none"}, contract requires ${contract.minimumDecisionGrade}`,
    );
  }

  return { outcome: "eligible" };
}
