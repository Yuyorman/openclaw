import { afterEach, describe, expect, it } from "vitest";
import { buildCapabilitySnapshot } from "../../agents/model-routing/capability-snapshot.js";
import type { ShadowRouteCandidate } from "../../agents/model-routing/shadow-evaluator.js";
import { resetLogger, setLoggerOverride } from "../../logging/logger.js";
import { loggingState } from "../../logging/state.js";
import { closeOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { captureEnv } from "../../test-utils/env.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { PersistedTaskContract } from "./contracts.js";
import { createSqliteObservationLeaseStore } from "./store.sqlite.js";
import { resetTaskRegistryForTests } from "../task-registry.js";
import {
  createShadowObservationLease,
  evaluateShadowRouteInGateway,
  getShadowAudit,
  type SafeRoutingCallerScope,
  type SafeRoutingServiceDeps,
} from "./service.js";

const ORIGINAL_ENV = captureEnv(["OPENCLAW_STATE_DIR"]);

const REAL_CANDIDATE: ShadowRouteCandidate = { provider: "openai", model: "gpt-5.4" };
const SHADOW_ELIGIBLE_CANDIDATE: ShadowRouteCandidate = { provider: "anthropic", model: "claude-sonnet-5" };

function buildContract(overrides: Partial<PersistedTaskContract> = {}): PersistedTaskContract {
  return {
    schemaVersion: 1,
    taskId: "unused-caller-supplied-id-ignored-by-registry",
    requiredCapabilities: {
      modalities: ["text"],
      minContextWindowTokens: 100000,
      minOutputTokens: 4096,
      toolCalling: false,
      structuredOutput: false,
      dataPolicy: "approved-providers",
    },
    minimumDecisionGrade: "analysis",
    riskClass: "low",
    reviewRequired: false,
    allowedToolPolicyId: "policy-1",
    deliveryMode: "formal", // deliberately not "none" — proves the service forces it
    routingPolicyVersion: "v1",
    ...overrides,
  };
}

function createTestDeps(overrides: Partial<SafeRoutingServiceDeps> = {}): SafeRoutingServiceDeps {
  let clock = 1_000;
  let idCounter = 0;
  return {
    now: () => clock,
    randomId: () => `id-${(idCounter += 1)}`,
    leaseTtlMs: 30_000,
    admissionPolicy: { approvedProviders: ["openai", "anthropic"] },
    resolveCandidates: () => [REAL_CANDIDATE, SHADOW_ELIGIBLE_CANDIDATE],
    configDigest: () => "sha256:config-v1",
    pluginRegistryDigest: () => "sha256:registry-v1",
    buildSnapshotForCandidate: (candidate) =>
      buildCapabilitySnapshot({
        provider: candidate.provider,
        model: candidate.model,
        configured: {
          contextWindowTokens: candidate.provider === "anthropic" ? 200000 : 16000,
          outputTokens: 8192,
          modalities: ["text"],
          api: `${candidate.provider}-api`,
        },
        decisionGradeAuthorization: { maxAuthorizedDecisionGrade: "final", reason: "test policy" },
      }),
    leaseStore: createSqliteObservationLeaseStore(),
    ...overrides,
    // allow the test to advance the fake clock via the returned object below
  };
}

const OWNER: SafeRoutingCallerScope = { sessionKey: "session-owner", operatorScopes: [] };
const OTHER_SESSION: SafeRoutingCallerScope = { sessionKey: "session-other", operatorScopes: [] };
const OPERATOR_READ: SafeRoutingCallerScope = { sessionKey: "session-operator", operatorScopes: ["operator.read"] };
const OPERATOR_WRITE: SafeRoutingCallerScope = { sessionKey: "session-operator", operatorScopes: ["operator.write"] };

describe("safety service", () => {
  afterEach(() => {
    ORIGINAL_ENV.restore();
    resetTaskRegistryForTests();
    loggingState.rawConsole = null;
    setLoggerOverride(null);
    resetLogger();
  });

  it("creates a lease for the owning session and forces deliveryMode=none regardless of the input contract", async () => {
    await withOpenClawTestState({ layout: "state-only", prefix: "openclaw-safety-service-create-" }, async () => {
      resetTaskRegistryForTests();
      const deps = createTestDeps();

      const result = createShadowObservationLease(deps, {
        contract: buildContract(),
        sessionRef: "session-owner",
        callerScope: OWNER,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      const lease = deps.leaseStore.findById(result.leaseId);
      expect(lease).toMatchObject({ state: "pending" });

      const audit = getShadowAudit({ taskId: lease!.taskId, callerScope: OWNER });
      expect(audit.ok).toBe(true);
      if (!audit.ok) throw new Error("unreachable");
      expect(audit.contract.deliveryMode).toBe("none");

      closeOpenClawStateDatabase();
    });
  });

  it("creates a lease for an operator acting with write scope on someone else's session", async () => {
    await withOpenClawTestState({ layout: "state-only", prefix: "openclaw-safety-service-op-write-" }, async () => {
      resetTaskRegistryForTests();
      const deps = createTestDeps();

      const result = createShadowObservationLease(deps, {
        contract: buildContract(),
        sessionRef: "session-owner",
        callerScope: OPERATOR_WRITE,
      });

      expect(result.ok).toBe(true);
      closeOpenClawStateDatabase();
    });
  });

  it("forbids creating a lease for another session without write scope", async () => {
    await withOpenClawTestState({ layout: "state-only", prefix: "openclaw-safety-service-forbid-create-" }, async () => {
      resetTaskRegistryForTests();
      const deps = createTestDeps();

      const result = createShadowObservationLease(deps, {
        contract: buildContract(),
        sessionRef: "session-owner",
        callerScope: OTHER_SESSION,
      });

      expect(result).toEqual({ ok: false, code: "forbidden" });
      closeOpenClawStateDatabase();
    });
  });

  it("rejects a structurally invalid contract", async () => {
    await withOpenClawTestState({ layout: "state-only", prefix: "openclaw-safety-service-invalid-" }, async () => {
      resetTaskRegistryForTests();
      const deps = createTestDeps();

      const result = createShadowObservationLease(deps, {
        contract: buildContract({ minimumDecisionGrade: "not-a-real-grade" as never }),
        sessionRef: "session-owner",
        callerScope: OWNER,
      });

      expect(result).toEqual({ ok: false, code: "invalid_contract" });
      closeOpenClawStateDatabase();
    });
  });

  it("evaluates and persists candidate judgments, reporting the shadow-eligible candidate as the theoretical choice", async () => {
    await withOpenClawTestState({ layout: "state-only", prefix: "openclaw-safety-service-evaluate-" }, async () => {
      resetTaskRegistryForTests();
      const deps = createTestDeps();
      const created = createShadowObservationLease(deps, {
        contract: buildContract(),
        sessionRef: "session-owner",
        callerScope: OWNER,
      });
      if (!created.ok) throw new Error("unreachable");

      const result = evaluateShadowRouteInGateway(deps, {
        leaseId: created.leaseId,
        leaseToken: created.leaseToken,
      });

      expect(result).toMatchObject({
        ok: true,
        theoreticalChoice: { provider: "anthropic", model: "claude-sonnet-5" },
        digestsConsistent: true,
      });

      const lease = deps.leaseStore.findById(created.leaseId);
      const audit = getShadowAudit({ taskId: lease!.taskId, callerScope: OWNER });
      if (!audit.ok) throw new Error("unreachable");
      expect(audit.attempts).toHaveLength(2);
      expect(audit.attempts.find((a) => a.provider === "openai")).toMatchObject({
        eligibility: "rejected",
        wouldSelect: false,
        observationCompleteness: "unavailable",
      });
      expect(audit.attempts.find((a) => a.provider === "anthropic")).toMatchObject({
        eligibility: "eligible",
        wouldSelect: true,
        observationCompleteness: "unavailable",
      });

      closeOpenClawStateDatabase();
    });
  });

  it("marks every persisted attempt partial when the live digests have drifted from the lease's bound digests", async () => {
    await withOpenClawTestState({ layout: "state-only", prefix: "openclaw-safety-service-drift-" }, async () => {
      resetTaskRegistryForTests();
      const deps = createTestDeps();
      const created = createShadowObservationLease(deps, {
        contract: buildContract(),
        sessionRef: "session-owner",
        callerScope: OWNER,
      });
      if (!created.ok) throw new Error("unreachable");

      const driftedDeps: SafeRoutingServiceDeps = { ...deps, configDigest: () => "sha256:config-v2-drifted" };
      const result = evaluateShadowRouteInGateway(driftedDeps, {
        leaseId: created.leaseId,
        leaseToken: created.leaseToken,
      });

      expect(result).toMatchObject({ ok: true, digestsConsistent: false });
      const lease = deps.leaseStore.findById(created.leaseId);
      const audit = getShadowAudit({ taskId: lease!.taskId, callerScope: OWNER });
      if (!audit.ok) throw new Error("unreachable");
      expect(audit.attempts.every((a) => a.observationCompleteness === "partial")).toBe(true);

      closeOpenClawStateDatabase();
    });
  });

  it("rejects evaluation with a wrong leaseToken without consuming the lease", async () => {
    await withOpenClawTestState({ layout: "state-only", prefix: "openclaw-safety-service-bad-token-" }, async () => {
      resetTaskRegistryForTests();
      const deps = createTestDeps();
      const created = createShadowObservationLease(deps, {
        contract: buildContract(),
        sessionRef: "session-owner",
        callerScope: OWNER,
      });
      if (!created.ok) throw new Error("unreachable");

      const result = evaluateShadowRouteInGateway(deps, { leaseId: created.leaseId, leaseToken: "wrong-token" });

      expect(result).toEqual({ ok: false, code: "invalid_token" });
      expect(deps.leaseStore.findById(created.leaseId)?.tokenConsumedAt).toBeUndefined();
      closeOpenClawStateDatabase();
    });
  });

  it("rejects a second presentation of an already-consumed leaseToken", async () => {
    await withOpenClawTestState({ layout: "state-only", prefix: "openclaw-safety-service-reused-token-" }, async () => {
      resetTaskRegistryForTests();
      const deps = createTestDeps();
      const created = createShadowObservationLease(deps, {
        contract: buildContract(),
        sessionRef: "session-owner",
        callerScope: OWNER,
      });
      if (!created.ok) throw new Error("unreachable");
      evaluateShadowRouteInGateway(deps, { leaseId: created.leaseId, leaseToken: created.leaseToken });

      const second = evaluateShadowRouteInGateway(deps, {
        leaseId: created.leaseId,
        leaseToken: created.leaseToken,
      });

      expect(second).toEqual({ ok: false, code: "already_consumed" });
      closeOpenClawStateDatabase();
    });
  });

  it("returns not_found for evaluation against an unknown leaseId", async () => {
    await withOpenClawTestState({ layout: "state-only", prefix: "openclaw-safety-service-unknown-lease-" }, async () => {
      resetTaskRegistryForTests();
      const deps = createTestDeps();

      const result = evaluateShadowRouteInGateway(deps, { leaseId: "no-such-lease", leaseToken: "anything" });

      expect(result).toEqual({ ok: false, code: "not_found" });
      closeOpenClawStateDatabase();
    });
  });

  it("lets the owning session read its own shadow audit", async () => {
    await withOpenClawTestState({ layout: "state-only", prefix: "openclaw-safety-service-audit-owner-" }, async () => {
      resetTaskRegistryForTests();
      const deps = createTestDeps();
      const created = createShadowObservationLease(deps, {
        contract: buildContract(),
        sessionRef: "session-owner",
        callerScope: OWNER,
      });
      if (!created.ok) throw new Error("unreachable");
      const lease = deps.leaseStore.findById(created.leaseId);

      const audit = getShadowAudit({ taskId: lease!.taskId, callerScope: OWNER });

      expect(audit.ok).toBe(true);
      closeOpenClawStateDatabase();
    });
  });

  it("returns not_found (not a distinct forbidden code) for a different session with no operator.read", async () => {
    await withOpenClawTestState({ layout: "state-only", prefix: "openclaw-safety-service-audit-forbid-" }, async () => {
      resetTaskRegistryForTests();
      const deps = createTestDeps();
      const created = createShadowObservationLease(deps, {
        contract: buildContract(),
        sessionRef: "session-owner",
        callerScope: OWNER,
      });
      if (!created.ok) throw new Error("unreachable");
      const lease = deps.leaseStore.findById(created.leaseId);

      const audit = getShadowAudit({ taskId: lease!.taskId, callerScope: OTHER_SESSION });
      const missing = getShadowAudit({ taskId: "no-such-task", callerScope: OTHER_SESSION });

      expect(audit).toEqual({ ok: false, code: "not_found" });
      expect(missing).toEqual({ ok: false, code: "not_found" });
      closeOpenClawStateDatabase();
    });
  });

  it("lets an operator with operator.read read any session's shadow audit", async () => {
    await withOpenClawTestState({ layout: "state-only", prefix: "openclaw-safety-service-audit-op-read-" }, async () => {
      resetTaskRegistryForTests();
      const deps = createTestDeps();
      const created = createShadowObservationLease(deps, {
        contract: buildContract(),
        sessionRef: "session-owner",
        callerScope: OWNER,
      });
      if (!created.ok) throw new Error("unreachable");
      const lease = deps.leaseStore.findById(created.leaseId);

      const audit = getShadowAudit({ taskId: lease!.taskId, callerScope: OPERATOR_READ });

      expect(audit.ok).toBe(true);
      closeOpenClawStateDatabase();
    });
  });
});
