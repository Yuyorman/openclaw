/**
 * Builds immutable model capability snapshots from config declaration,
 * runtime limits, and observed evidence. Pure, no I/O — no SQLite, network,
 * or provider calls here (see Task 3 for persistence, Task 5 for live wiring).
 */
import { sha256Hex } from "../../infra/crypto-digest.js";
import type {
  TaskContractDecisionGrade,
  TaskContractModality,
} from "../../tasks/safety/contracts.js";
import { stableStringify } from "../stable-stringify.js";

export type CapabilityVerification = "configured" | "observed" | "unverified" | "contradicted";

export type CapabilityEvidenceSource = "config" | "runtime-limit" | "observed" | "policy";

export type CapabilityEvidence = {
  source: CapabilityEvidenceSource;
  detail: string;
};

export type CapabilityValue<T> = {
  value?: T;
  verification: CapabilityVerification;
  evidence: CapabilityEvidence[];
};

export type ModelCapabilitySnapshot = {
  provider: string;
  model: string;
  contextWindowTokens: CapabilityValue<number>;
  outputTokens: CapabilityValue<number>;
  modalities: CapabilityValue<TaskContractModality[]>;
  toolCalling: CapabilityValue<boolean>;
  structuredOutput: CapabilityValue<boolean>;
  /** Phase 1 never resolves a verified resolvedRuntimeId; always unverified regardless of input. */
  runtimeIds: CapabilityValue<string[]>;
  /** Provider API adapter id; the only recognized signal for a local-only data policy (see candidate-admission.ts). */
  api: CapabilityValue<string>;
  /** Computed by local routing/authorization policy, never by the model itself — see decisionGradeAuthorization input. */
  authorizedDecisionGrade: CapabilityValue<TaskContractDecisionGrade>;
  snapshotDigest: string;
};

export type BuildCapabilitySnapshotInput = {
  provider: string;
  model: string;
  configured?: {
    contextWindowTokens?: number;
    outputTokens?: number;
    modalities?: TaskContractModality[];
    toolCalling?: boolean;
    structuredOutput?: boolean;
    api?: string;
  };
  /** A second static ceiling independent of config declaration (e.g. an agent harness cap). Never dynamic accumulated usage. */
  runtimeLimits?: {
    contextWindowTokens?: number;
    outputTokens?: number;
  };
  observed?: {
    contextWindowTokens?: number;
    outputTokens?: number;
    modalities?: TaskContractModality[];
    toolCalling?: boolean;
    structuredOutput?: boolean;
  };
  /** Local authorization policy's decision for this candidate; not a model-intrinsic parameter. */
  decisionGradeAuthorization: {
    maxAuthorizedDecisionGrade: TaskContractDecisionGrade;
    reason: string;
  };
};

function resolveNumericCapability(params: {
  fieldName: string;
  configured?: number;
  runtimeLimit?: number;
  observed?: number;
}): CapabilityValue<number> {
  const evidence: CapabilityEvidence[] = [];
  if (params.configured !== undefined) {
    evidence.push({
      source: "config",
      detail: `configured ${params.fieldName}=${params.configured}`,
    });
  }
  if (params.runtimeLimit !== undefined) {
    evidence.push({
      source: "runtime-limit",
      detail: `runtime limit ${params.fieldName}=${params.runtimeLimit}`,
    });
  }
  const staticValues = [params.configured, params.runtimeLimit].filter(
    (value): value is number => value !== undefined,
  );
  const staticMin = staticValues.length > 0 ? Math.min(...staticValues) : undefined;

  if (params.observed !== undefined) {
    evidence.push({
      source: "observed",
      detail: `observed ${params.fieldName}=${params.observed}`,
    });
    if (staticMin !== undefined && params.observed > staticMin) {
      // Observed evidence claims more capacity than declared/runtime-capped: keep the conservative ceiling.
      return { value: staticMin, verification: "contradicted", evidence };
    }
    return { value: params.observed, verification: "observed", evidence };
  }
  if (staticMin !== undefined) {
    return { value: staticMin, verification: "configured", evidence };
  }
  return { verification: "unverified", evidence };
}

function resolveBooleanCapability(params: {
  fieldName: string;
  configured?: boolean;
  observed?: boolean;
}): CapabilityValue<boolean> {
  const evidence: CapabilityEvidence[] = [];
  if (params.configured !== undefined) {
    evidence.push({
      source: "config",
      detail: `configured ${params.fieldName}=${params.configured}`,
    });
  }
  if (params.observed !== undefined) {
    evidence.push({
      source: "observed",
      detail: `observed ${params.fieldName}=${params.observed}`,
    });
    if (params.configured !== undefined && params.configured !== params.observed) {
      // Conservative: never trust an unexpected boolean claim over a conflicting one.
      return { value: false, verification: "contradicted", evidence };
    }
    return { value: params.observed, verification: "observed", evidence };
  }
  if (params.configured !== undefined) {
    return { value: params.configured, verification: "configured", evidence };
  }
  return { verification: "unverified", evidence };
}

function resolveModalitiesCapability(params: {
  configured?: TaskContractModality[];
  observed?: TaskContractModality[];
}): CapabilityValue<TaskContractModality[]> {
  const evidence: CapabilityEvidence[] = [];
  if (params.configured !== undefined) {
    evidence.push({
      source: "config",
      detail: `configured modalities=${[...params.configured].toSorted().join(",")}`,
    });
  }
  if (params.observed !== undefined) {
    evidence.push({
      source: "observed",
      detail: `observed modalities=${[...params.observed].toSorted().join(",")}`,
    });
    if (params.configured !== undefined) {
      const configuredSet = new Set(params.configured);
      const observedSet = new Set(params.observed);
      const same =
        configuredSet.size === observedSet.size &&
        [...configuredSet].every((m) => observedSet.has(m));
      if (!same) {
        const intersection = [...configuredSet].filter((m) => observedSet.has(m)).toSorted();
        return { value: intersection, verification: "contradicted", evidence };
      }
    }
    return { value: [...params.observed].toSorted(), verification: "observed", evidence };
  }
  if (params.configured !== undefined) {
    return { value: [...params.configured].toSorted(), verification: "configured", evidence };
  }
  return { verification: "unverified", evidence };
}

function resolveApiCapability(configuredApi?: string): CapabilityValue<string> {
  if (configuredApi !== undefined) {
    return {
      value: configuredApi,
      verification: "configured",
      evidence: [{ source: "config", detail: `configured api=${configuredApi}` }],
    };
  }
  return { verification: "unverified", evidence: [] };
}

/** Aggregates config declaration, runtime limits, and observed evidence into one immutable, content-addressed snapshot. */
export function buildCapabilitySnapshot(
  input: BuildCapabilitySnapshotInput,
): ModelCapabilitySnapshot {
  const contextWindowTokens = resolveNumericCapability({
    fieldName: "contextWindowTokens",
    configured: input.configured?.contextWindowTokens,
    runtimeLimit: input.runtimeLimits?.contextWindowTokens,
    observed: input.observed?.contextWindowTokens,
  });
  const outputTokens = resolveNumericCapability({
    fieldName: "outputTokens",
    configured: input.configured?.outputTokens,
    runtimeLimit: input.runtimeLimits?.outputTokens,
    observed: input.observed?.outputTokens,
  });
  const modalities = resolveModalitiesCapability({
    configured: input.configured?.modalities,
    observed: input.observed?.modalities,
  });
  const toolCalling = resolveBooleanCapability({
    fieldName: "toolCalling",
    configured: input.configured?.toolCalling,
    observed: input.observed?.toolCalling,
  });
  const structuredOutput = resolveBooleanCapability({
    fieldName: "structuredOutput",
    configured: input.configured?.structuredOutput,
    observed: input.observed?.structuredOutput,
  });
  const api = resolveApiCapability(input.configured?.api);
  const runtimeIds: CapabilityValue<string[]> = {
    verification: "unverified",
    evidence: [
      { source: "policy", detail: "Phase 1 does not resolve a verified resolvedRuntimeId" },
    ],
  };
  const authorizedDecisionGrade: CapabilityValue<TaskContractDecisionGrade> = {
    value: input.decisionGradeAuthorization.maxAuthorizedDecisionGrade,
    verification: "configured",
    evidence: [{ source: "policy", detail: input.decisionGradeAuthorization.reason }],
  };

  const factsWithoutDigest = {
    provider: input.provider,
    model: input.model,
    contextWindowTokens,
    outputTokens,
    modalities,
    toolCalling,
    structuredOutput,
    runtimeIds,
    api,
    authorizedDecisionGrade,
  };
  const snapshotDigest = `sha256:${sha256Hex(stableStringify(factsWithoutDigest))}`;
  return { ...factsWithoutDigest, snapshotDigest };
}
