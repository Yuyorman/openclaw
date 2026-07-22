/**
 * Core safe-routing shadow service: composes the task contract, the current
 * process's candidate/capability resolver, the shadow evaluator, the
 * observation lease, and the store behind three narrow, callerScope-checked
 * operations. Plugins reach this only through the Task 6 Plugin SDK adapter;
 * this module never assumes an upper caller already validated `callerScope`.
 */
import { randomUUID } from "node:crypto";
import { buildCapabilitySnapshot } from "../../agents/model-routing/capability-snapshot.js";
import type { ModelCapabilitySnapshot } from "../../agents/model-routing/capability-snapshot.js";
import type { ModelRoutingAdmissionPolicy } from "../../agents/model-routing/candidate-admission.js";
import {
  evaluateShadowRoute,
  type ShadowRouteCandidate,
} from "../../agents/model-routing/shadow-evaluator.js";
import { stableStringify } from "../../agents/stable-stringify.js";
import { DEFAULT_PROVIDER } from "../../agents/defaults.js";
import { resolveModelCandidateChain } from "../../agents/model-fallback.js";
import { buildModelAliasIndex, resolveModelRefFromString } from "../../agents/model-selection-resolve.js";
import { getRuntimeConfig } from "../../config/io.js";
import { resolveAgentModelPrimaryValue } from "../../config/model-input.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sha256Hex } from "../../infra/crypto-digest.js";
import {
  READ_SCOPE,
  WRITE_SCOPE,
  authorizeOperatorScopesForRequiredScope,
} from "../../gateway/method-scopes.js";
import {
  recordObservedModelAttempt,
  type RouteAttemptObserverDeps,
} from "../../agents/model-routing/route-attempt-observer.js";
import type {
  PluginHookAgentContext,
  PluginHookModelCallEndedEvent,
  PluginHookModelCallStartedEvent,
} from "../../plugins/hook-types.js";
import { getPluginRegistryState } from "../../plugins/runtime-state.js";
import {
  consumeObservationLease,
  createObservationLease,
  type ObservationLeaseStore,
} from "./observation-lease.js";
import {
  appendRouteAttempts,
  createManagedTaskWithCheckpoint,
  createSqliteObservationLeaseStore,
  getTaskCheckpointByTaskId,
  getTaskContract,
  listRouteAttempts,
  putCapabilitySnapshot,
  updateRouteAttemptObservation,
} from "./store.sqlite.js";
import type { PutCapabilitySnapshotInput, RouteAttemptRow, TaskCheckpointRow, TaskContractRow } from "./store.types.js";
import { digestTaskContract, normalizeTaskContract, type NormalizedTaskContract, type PersistedTaskContract } from "./contracts.js";

/** The fixed, only Phase 1 task kind — enforced by the Task 7 extension's allowedTaskKinds gate. */
export const SAFE_ROUTING_SHADOW_TASK_KIND = "safe-routing-readonly-shadow";

export type SafeRoutingCallerScope = {
  sessionKey: string;
  operatorScopes: readonly string[];
};

export type SafeRoutingServiceDeps = {
  now(): number;
  randomId(): string;
  leaseTtlMs: number;
  admissionPolicy: ModelRoutingAdmissionPolicy;
  /** The live gateway process's current model-level candidate chain (already resolved via `resolveModelCandidateChain`). */
  resolveCandidates(): ShadowRouteCandidate[];
  /** Digest of the live gateway process's current config. */
  configDigest(): string;
  /** Digest of the live gateway process's current plugin registry. */
  pluginRegistryDigest(): string;
  /** Builds a capability snapshot for one candidate from the live process's config/runtime/observed evidence. */
  buildSnapshotForCandidate(candidate: ShadowRouteCandidate): ModelCapabilitySnapshot;
  leaseStore: ObservationLeaseStore;
};

function digestCandidateChain(candidates: readonly ShadowRouteCandidate[]): string {
  return `sha256:${sha256Hex(stableStringify(candidates))}`;
}

function resolveLiveCandidates(cfg: OpenClawConfig): ShadowRouteCandidate[] {
  const primaryRaw = resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model);
  if (!primaryRaw?.trim()) {
    return [];
  }
  const aliasIndex = buildModelAliasIndex({ cfg, defaultProvider: DEFAULT_PROVIDER });
  const resolved = resolveModelRefFromString({
    cfg,
    raw: primaryRaw,
    defaultProvider: DEFAULT_PROVIDER,
    aliasIndex,
  });
  if (!resolved?.ref.provider || !resolved.ref.model) {
    return [];
  }
  return resolveModelCandidateChain({ cfg, provider: resolved.ref.provider, model: resolved.ref.model });
}

function buildLiveCapabilitySnapshot(cfg: OpenClawConfig, candidate: ShadowRouteCandidate): ModelCapabilitySnapshot {
  const providerConfig = cfg.models?.providers?.[candidate.provider];
  const modelConfig = providerConfig?.models?.find((entry) => entry.id === candidate.model);
  const modalities = modelConfig?.input?.filter(
    (value): value is "text" | "image" | "audio" => value === "text" || value === "image" || value === "audio",
  );
  return buildCapabilitySnapshot({
    provider: candidate.provider,
    model: candidate.model,
    configured: {
      contextWindowTokens: modelConfig?.contextWindow ?? providerConfig?.contextWindow,
      outputTokens: modelConfig?.maxTokens ?? providerConfig?.maxTokens,
      ...(modalities && modalities.length > 0 ? { modalities } : {}),
      toolCalling: modelConfig?.compat?.supportsTools,
      api: modelConfig?.api ?? providerConfig?.api,
    },
    decisionGradeAuthorization: {
      maxAuthorizedDecisionGrade: "final",
      reason:
        "Phase 1 has no per-model decisionGrade authorization policy source yet; " +
        "defaulting to unrestricted pending a real routing-policy input (see Task 5/7 disclosure).",
    },
  });
}

export type CreateLiveSafeRoutingServiceDepsInput = {
  admissionPolicy: ModelRoutingAdmissionPolicy;
  /** Defaults to 5 minutes — short-lived, single-use per Task 6 Step 2. */
  leaseTtlMs?: number;
};

/**
 * Builds the real, live-gateway-process `SafeRoutingServiceDeps`: reads the
 * current config via `getRuntimeConfig()`, resolves the current model-level
 * candidate chain via the unmodified `resolveModelCandidateChain`, and builds
 * capability snapshots from config declarations only (Phase 1 has no runtime
 * probe pipeline yet). Extensions call this instead of constructing deps by
 * hand so Core (not the extension) owns config/model-fallback plumbing and the
 * lease store's SQLite handle never needs to be exposed through the SDK.
 */
export function createLiveSafeRoutingServiceDeps(
  input: CreateLiveSafeRoutingServiceDepsInput,
): SafeRoutingServiceDeps {
  return {
    now: () => Date.now(),
    randomId: () => randomUUID(),
    leaseTtlMs: input.leaseTtlMs ?? 5 * 60_000,
    admissionPolicy: input.admissionPolicy,
    resolveCandidates: () => resolveLiveCandidates(getRuntimeConfig()),
    configDigest: () => `sha256:${sha256Hex(stableStringify(getRuntimeConfig()))}`,
    pluginRegistryDigest: () => {
      const state = getPluginRegistryState();
      return `sha256:${sha256Hex(
        stableStringify({
          activeVersion: state?.activeVersion,
          importedPluginIds: [...(state?.importedPluginIds ?? [])].toSorted(),
        }),
      )}`;
    },
    buildSnapshotForCandidate: (candidate) => buildLiveCapabilitySnapshot(getRuntimeConfig(), candidate),
    leaseStore: createSqliteObservationLeaseStore(),
  };
}

function authorizesSessionOwnershipOrScope(
  callerScope: SafeRoutingCallerScope,
  sessionRef: string,
  requiredScope: typeof READ_SCOPE | typeof WRITE_SCOPE,
): boolean {
  if (callerScope.sessionKey === sessionRef) {
    return true;
  }
  return authorizeOperatorScopesForRequiredScope(requiredScope, callerScope.operatorScopes).allowed;
}

function summarizeVerificationStatus(snapshot: ModelCapabilitySnapshot): string {
  const verifications = [
    snapshot.contextWindowTokens.verification,
    snapshot.outputTokens.verification,
    snapshot.modalities.verification,
    snapshot.toolCalling.verification,
    snapshot.structuredOutput.verification,
    snapshot.runtimeIds.verification,
    snapshot.api.verification,
    snapshot.authorizedDecisionGrade.verification,
  ];
  if (verifications.includes("contradicted")) {
    return "contradicted";
  }
  if (verifications.includes("unverified")) {
    return "unverified";
  }
  return "verified";
}

/** Bridges Task 4's per-field-verified snapshot shape onto Task 3's single-verificationStatus row shape, keeping full per-field evidence in `evidence`. */
function snapshotToStoreInput(snapshot: ModelCapabilitySnapshot): PutCapabilitySnapshotInput {
  return {
    provider: snapshot.provider,
    model: snapshot.model,
    verificationStatus: summarizeVerificationStatus(snapshot),
    capabilities: {
      contextWindowTokens: snapshot.contextWindowTokens.value,
      outputTokens: snapshot.outputTokens.value,
      modalities: snapshot.modalities.value,
      toolCalling: snapshot.toolCalling.value,
      structuredOutput: snapshot.structuredOutput.value,
      runtimeIds: snapshot.runtimeIds.value,
      api: snapshot.api.value,
      authorizedDecisionGrade: snapshot.authorizedDecisionGrade.value,
    },
    evidence: {
      contextWindowTokens: snapshot.contextWindowTokens,
      outputTokens: snapshot.outputTokens,
      modalities: snapshot.modalities,
      toolCalling: snapshot.toolCalling,
      structuredOutput: snapshot.structuredOutput,
      runtimeIds: snapshot.runtimeIds,
      api: snapshot.api,
      authorizedDecisionGrade: snapshot.authorizedDecisionGrade,
    },
    snapshotDigest: snapshot.snapshotDigest,
  };
}

export type CreateShadowObservationLeaseInput = {
  contract: PersistedTaskContract;
  sessionRef: string;
  callerScope: SafeRoutingCallerScope;
};

export type CreateShadowObservationLeaseResult =
  | { ok: true; taskId: string; leaseId: string; leaseToken: string }
  | { ok: false; code: "forbidden" | "invalid_contract" };

/**
 * Creates a new managed shadow task + first checkpoint + single-use
 * observation lease, all bound to the live process's current
 * config/plugin-registry/candidate-chain digests. Forces `deliveryMode=none`
 * regardless of what the caller's contract requested.
 */
export function createShadowObservationLease(
  deps: SafeRoutingServiceDeps,
  input: CreateShadowObservationLeaseInput,
): CreateShadowObservationLeaseResult {
  if (!authorizesSessionOwnershipOrScope(input.callerScope, input.sessionRef, WRITE_SCOPE)) {
    return { ok: false, code: "forbidden" };
  }

  let normalized: NormalizedTaskContract;
  try {
    normalized = normalizeTaskContract({ ...input.contract, deliveryMode: "none" });
  } catch {
    return { ok: false, code: "invalid_contract" };
  }
  const contractDigest = digestTaskContract(normalized);
  const now = deps.now();
  const candidates = deps.resolveCandidates();
  const configDigest = deps.configDigest();
  const pluginRegistryDigest = deps.pluginRegistryDigest();
  const candidateChainDigest = digestCandidateChain(candidates);

  const leaseId = deps.randomId();
  const leaseToken = deps.randomId();

  // afterCheckpoint runs inside createManagedTaskWithCheckpoint's own write
  // transaction, before that transaction commits and before createTaskRecord
  // updates its in-memory registry. A lease-insert failure there rolls the
  // whole task+contract+checkpoint insert back too (via the same try/catch
  // that already gates the in-memory update on persistence actually
  // succeeding — see store.sqlite.ts), instead of leaving a task/checkpoint
  // committed with no lease attached. Deliberately NOT a transaction opened
  // here and passed down: createTaskRecord's in-memory cache update is only
  // safe to run once its own transaction is the outermost, real commit — an
  // outer transaction wrapped around it would let that cache update fire
  // before the outer transaction is known to succeed.
  const managed = createManagedTaskWithCheckpoint({
    task: {
      runtime: "cli",
      ownerKey: `agent:main:${input.sessionRef}`,
      scopeKind: "session",
      task: SAFE_ROUTING_SHADOW_TASK_KIND,
      status: "succeeded",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
    },
    contract: {
      schemaVersion: 1,
      contractJson: stableStringify(normalized),
      contractDigest,
      riskClass: normalized.riskClass,
      reviewRequired: normalized.reviewRequired,
      deliveryMode: normalized.deliveryMode,
      routingPolicyVersion: normalized.routingPolicyVersion,
    },
    checkpoint: {
      sequence: 0,
      contractDigest,
      inputDigest: contractDigest,
      routingPolicyVersion: normalized.routingPolicyVersion,
      configDigest,
      pluginRegistryDigest,
      candidateChainDigest,
    },
    afterCheckpoint: ({ taskId, checkpointId }) => {
      createObservationLease(deps.leaseStore, {
        leaseId,
        taskId,
        checkpointId,
        sessionBindingDigest: `sha256:${sha256Hex(input.sessionRef)}`,
        leaseTokenDigest: `sha256:${sha256Hex(leaseToken)}`,
        contractDigest,
        configDigest,
        pluginRegistryDigest,
        candidateChainDigest,
        ttlMs: deps.leaseTtlMs,
        now,
      });
    },
  });
  if (!managed) {
    return { ok: false, code: "invalid_contract" };
  }

  return { ok: true, taskId: managed.task.taskId, leaseId, leaseToken };
}

export type EvaluateShadowRouteInGatewayInput = {
  leaseId: string;
  leaseToken: string;
};

export type EvaluateShadowRouteInGatewayResult =
  | {
      ok: true;
      routingPolicyVersion: string;
      theoreticalChoice?: ShadowRouteCandidate;
      digestsConsistent: boolean;
    }
  | { ok: false; code: "not_found" | "invalid_token" | "expired" | "already_consumed" | "superseded" };

/**
 * Consumes the lease's one-time token, then runs the pure shadow evaluator
 * against the live process's current candidates/snapshots and persists the
 * resulting candidate judgments. A live digest drift from the lease's bound
 * digests does not block evaluation, but marks every attempt `partial`
 * instead of the default `unavailable` (see design: must not enter the
 * consistency-rate denominator as if it were consistent).
 */
export function evaluateShadowRouteInGateway(
  deps: SafeRoutingServiceDeps,
  input: EvaluateShadowRouteInGatewayInput,
): EvaluateShadowRouteInGatewayResult {
  const lease = deps.leaseStore.findById(input.leaseId);
  if (!lease) {
    return { ok: false, code: "not_found" };
  }
  if (`sha256:${sha256Hex(input.leaseToken)}` !== lease.leaseTokenDigest) {
    return { ok: false, code: "invalid_token" };
  }
  if (lease.state === "superseded") {
    // A newer createShadowObservationLease call for the same session replaced
    // this lease before it was evaluated; it can never be evaluated now (see
    // ObservationLeaseStore.insert's supersede-on-create step).
    return { ok: false, code: "superseded" };
  }
  const consumed = consumeObservationLease(deps.leaseStore, input.leaseId, deps.now());
  if (!consumed.ok) {
    return { ok: false, code: consumed.code === "not_found" ? "not_found" : consumed.code };
  }

  const contractRow = getTaskContract(lease.taskId);
  const checkpoint = getTaskCheckpointByTaskId(lease.taskId);
  if (!contractRow || !checkpoint) {
    return { ok: false, code: "not_found" };
  }
  const normalized = JSON.parse(contractRow.contractJson) as NormalizedTaskContract;

  const candidates = deps.resolveCandidates();
  const liveConfigDigest = deps.configDigest();
  const livePluginRegistryDigest = deps.pluginRegistryDigest();
  const liveCandidateChainDigest = digestCandidateChain(candidates);
  const digestsConsistent =
    liveConfigDigest === lease.configDigest &&
    livePluginRegistryDigest === lease.pluginRegistryDigest &&
    liveCandidateChainDigest === lease.candidateChainDigest;

  const seen = new Set<string>();
  const dedupedCandidates = candidates.filter((candidate) => {
    const key = `${candidate.provider} ${candidate.model}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
  const snapshots = dedupedCandidates.map((candidate) => {
    const built = deps.buildSnapshotForCandidate(candidate);
    const persisted = putCapabilitySnapshot(snapshotToStoreInput(built));
    return { built, snapshotId: persisted.snapshotId };
  });

  const evaluation = evaluateShadowRoute({
    contract: normalized,
    candidates: dedupedCandidates,
    snapshots: snapshots.map((s) => s.built),
    policy: deps.admissionPolicy,
  });

  const snapshotIdByKey = new Map(snapshots.map((s) => [`${s.built.provider} ${s.built.model}`, s.snapshotId]));
  appendRouteAttempts(
    lease.taskId,
    checkpoint.checkpointId,
    evaluation.attempts.map((attempt) => ({
      ordinal: attempt.ordinal,
      provider: attempt.provider,
      model: attempt.model,
      capabilitySnapshotId: snapshotIdByKey.get(`${attempt.provider} ${attempt.model}`) ?? "unknown",
      evaluationMode: "shadow",
      eligibility: attempt.decision.outcome === "eligible" ? "eligible" : "rejected",
      ...(attempt.decision.outcome === "ineligible"
        ? { rejectionCode: attempt.decision.code, rejectionReason: attempt.decision.reason }
        : {}),
      wouldSelect: attempt.decision.outcome === "eligible",
      observationCompleteness: digestsConsistent ? "unavailable" : "partial",
      observationCoverage: "out-of-scope",
    })),
  );

  return {
    ok: true,
    routingPolicyVersion: evaluation.routingPolicyVersion,
    ...(evaluation.theoreticalChoice ? { theoreticalChoice: evaluation.theoreticalChoice } : {}),
    digestsConsistent,
  };
}

export type GetShadowAuditInput = {
  taskId: string;
  callerScope: SafeRoutingCallerScope;
};

export type GetShadowAuditResult =
  | {
      ok: true;
      contract: TaskContractRow;
      checkpoint: TaskCheckpointRow;
      attempts: RouteAttemptRow[];
      /** Derived suggestion, never a stored fact: set when at least one candidate was evaluated and none was eligible. */
      suggestion?: "CAPABLE_MODEL";
    }
  | { ok: false; code: "not_found" };

/**
 * Object-level authorization: a caller may read a task's audit only if it is
 * bound to their own session, or they hold explicit `operator.read` (write/
 * admin imply read). Unauthorized and nonexistent both return the same
 * `not_found` code so a caller cannot enumerate task ids by response shape.
 */
export function getShadowAudit(input: GetShadowAuditInput): GetShadowAuditResult {
  const contract = getTaskContract(input.taskId);
  const checkpoint = contract ? getTaskCheckpointByTaskId(input.taskId) : undefined;
  if (!contract || !checkpoint) {
    return { ok: false, code: "not_found" };
  }

  const callerSessionBindingDigest = `sha256:${sha256Hex(input.callerScope.sessionKey)}`;
  const ownsSession = checkpoint.sessionBindingDigest === callerSessionBindingDigest;
  const hasReadScope = authorizeOperatorScopesForRequiredScope(READ_SCOPE, input.callerScope.operatorScopes).allowed;
  if (!ownsSession && !hasReadScope) {
    return { ok: false, code: "not_found" };
  }

  const attempts = listRouteAttempts(input.taskId, checkpoint.checkpointId);
  // Derived guidance only — the shadow task itself still ends via the existing
  // lifecycle (task_runs.status is never rewritten to a Phase 2 `blocked` state).
  const suggestion: "CAPABLE_MODEL" | undefined =
    attempts.length > 0 && !attempts.some((attempt) => attempt.wouldSelect) ? "CAPABLE_MODEL" : undefined;

  return {
    ok: true,
    contract,
    checkpoint,
    attempts,
    ...(suggestion ? { suggestion } : {}),
  };
}

export type RecordObservedModelAttemptInGatewayInput =
  | { phase: "started"; event: PluginHookModelCallStartedEvent; ctx: PluginHookAgentContext; now: number }
  | { phase: "ended"; event: PluginHookModelCallEndedEvent; ctx: PluginHookAgentContext; now: number };

/**
 * The fourth narrow method: bridges a real `model_call_started`/
 * `model_call_ended` typed hook event (subscribed via `api.on(...)` in the
 * Task 7 extension) into `route-attempt-observer.ts`'s pure correlation and
 * persistence logic. Fire-and-forget by construction (never throws — see
 * `recordObservedModelAttempt`'s own contract).
 *
 * Trust boundary: unlike the other three exported methods, this one has no
 * caller-identity check of its own — it trusts `input.ctx`/`input.event`
 * verbatim, because the only intended caller is Core's own typed-hook
 * dispatcher (which supplies a real session's `ctx`, not attacker-suppliable
 * data). Only call this from an `api.on("model_call_started"/"model_call_ended", ...)`
 * handler; calling it directly with a fabricated `ctx.sessionKey` lets the
 * caller record a fabricated observation against any session that currently
 * holds an active lease. That residual is disclosed in
 * extensions/safe-routing/README.md's Known Phase 1 limitations — closing it
 * fully would require Core to give hook dispatch tamper-evident provenance,
 * which is out of Phase 1's scope.
 */
export async function recordObservedModelAttemptInGateway(
  deps: SafeRoutingServiceDeps,
  input: RecordObservedModelAttemptInGatewayInput,
): Promise<void> {
  const observerDeps: RouteAttemptObserverDeps = {
    leaseStore: deps.leaseStore,
    listRouteAttempts: (taskId, checkpointId) => listRouteAttempts(taskId, checkpointId),
    updateRouteAttemptObservation: (attemptId, patch) => updateRouteAttemptObservation(attemptId, patch),
  };

  if (input.phase === "ended") {
    await recordObservedModelAttempt(observerDeps, {
      phase: "ended",
      event: input.event,
      ctx: input.ctx,
      now: input.now,
    });
    return;
  }

  const sessionKey = input.ctx.sessionKey;
  if (!sessionKey) {
    return;
  }
  await recordObservedModelAttempt(observerDeps, {
    phase: "started",
    event: input.event,
    ctx: input.ctx,
    sessionBindingDigest: `sha256:${sha256Hex(sessionKey)}`,
    configDigest: deps.configDigest(),
    pluginRegistryDigest: deps.pluginRegistryDigest(),
    candidateChainDigest: digestCandidateChain(deps.resolveCandidates()),
    now: input.now,
  });
}
